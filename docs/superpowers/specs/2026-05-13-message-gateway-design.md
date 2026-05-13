# Message Gateway Design

## Goal

Unified inbound message processing across all channels (email, WhatsApp, Telegram, future). Each channel has a thin processor responsible only for parsing raw data — all routing, classification, spam checking, and EA wakeup logic lives in a single `message-gateway` service.

## Architecture

```
channel processors (parse only)          message-gateway (route + classify)
─────────────────────────────────        ──────────────────────────────────
email-processor.ts          ──────────►  1. find company EA (adapterType="ea")
  parse IMAP bytes                        2. spam check (blocked_sender_domains)
  insert email_messages row               3. resolve sender → clientId or null
  save attachments to disk                4. unknown → EA wakeup for classification
  call messageGateway()                   5. known → EA wakeup with clientId
                                          6. file attachments to client folder
whatsapp-channel-plugin    ──────────►   7. storage warning if no root set
  receive Meta webhook                    │
  parse payload                           ↓ fallback if no EA in company
  fetch media → upload assets             runOrchestrator (inbound-router.ts)
  POST /api/ingest

telegram-polling.ts        ──────────►  (calls messageGateway() directly,
  long-poll Telegram API                  same process, no HTTP boundary)
  parse message
  call messageGateway()

email-channel-plugin       (Phase 2)    replaces email-processor.ts entirely
  Paperclip plugin
  IMAP polling moves out of core server
  POST /api/ingest
```

## Normalized InboundMessage Interface

All channel processors submit the same shape to message-gateway:

```typescript
interface InboundMessage {
  channel: "email" | "whatsapp" | "telegram";
  companyId: string;
  fromAddr: string;        // email address or E.164 phone number
  body: string;
  subject?: string;        // email only
  threadKey?: string;      // email Message-ID header or WhatsApp thread ID
  attachmentIds?: string[]; // asset UUIDs already uploaded via /api/assets/upload
  sourceMessageId: string; // email_messages.id, operator_messages.id, etc.
}
```

## Message Gateway Processing Steps

```
function messageGateway(db, msg: InboundMessage): Promise<void>

1. Find EA agent
   → SELECT id FROM agents WHERE companyId = msg.companyId AND adapterType = 'ea' LIMIT 1
   → if none: call routeInboundMessage(db, msg) and return (legacy orchestrator path)

2. Spam check
   → extract domain (email) or phone prefix (whatsapp)
   → SELECT FROM blocked_sender_domains WHERE companyId = ... AND domain = ...
   → if blocked: mark sourceMessage processingState = "ignored", return

3. Resolve sender
   → email: resolveClientByEmail(db, companyId, fromAddr) → clientId | null
   → whatsapp: resolveClientByPhone(db, companyId, fromAddr) → clientId | null
   → telegram: fromAddr is operatorChatId → always operator, skip client resolve

4. EA wakeup
   → INSERT agentWakeupRequests { agentId: ea.id, companyId, payload: {
        sourceMessageId, channel, fromAddr, clientId: clientId ?? null
      }}
   → mark sourceMessage processingState = "analyzing"

5. File attachments (fire-and-forget, non-fatal)
   → if clientId known AND attachmentIds.length > 0:
      fileAttachmentToClientFolder(db, assetId, filename, clientId, channel)

6. Storage warning (fire-and-forget, non-fatal)
   → if !hasStorageRoot(db, companyId): notifyStorageNotConfigured(db, companyId)
```

## Attachment Flow (Plugin Channels)

Plugins cannot write to the server filesystem directly. Attachments flow via API:

```
plugin fetches raw bytes (IMAP fetch / Meta media URL)
  → POST /api/assets/upload  (multipart, board API token)
  → receives { assetId, filename, mimeType, sizeBytes }
  → includes assetId[] in POST /api/ingest payload
  → gateway calls fileAttachmentToClientFolder(db, assetId, ...)
```

For `email-processor.ts` (Phase 1, still in-process): attachment bytes saved to disk as today, asset IDs passed directly to gateway without HTTP upload.

## Channel Processors

### email-processor.ts (Phase 1 — refactor)

**Remove:**
- Spam check (moves to gateway)
- EA agent lookup + wakeup (moves to gateway)
- `routeInboundMessage` call (moves to gateway)
- `notifyStorageNotConfigured` call (moves to gateway)
- Attachment filing call (moves to gateway)

**Keep:**
- IMAP RFC-822 parsing
- `email_messages` row insert
- `email_attachments` rows insert
- Attachment bytes saved to `~/.paperclip/attachments/`

**Add:**
```typescript
await messageGateway(db, {
  channel: "email",
  companyId: emailAccount.companyId,
  fromAddr,
  body,
  subject,
  threadKey: messageIdHeader,
  attachmentIds: savedAttachmentIds,
  sourceMessageId: inserted.id,
});
```

### telegram-polling.ts (Phase 1 — refactor)

Same pattern: strip routing logic, call `messageGateway()` directly. No HTTP boundary since it runs in the same server process.

### whatsapp-channel-plugin (Phase 3)

Paperclip plugin (same structure as `paperclip-plugin-telegram`):

```typescript
// plugin receives Meta webhook via ctx.http or registered webhook URL
// parses message payload
// fetches media bytes → ctx.http.fetch(mediaUrl) → upload to /api/assets/upload
// submits to gateway:
await ctx.http.fetch(`${baseUrl}/api/ingest`, {
  method: "POST",
  headers: { Authorization: `Bearer ${boardApiToken}` },
  body: JSON.stringify({
    channel: "whatsapp",
    companyId,
    fromAddr: phoneNumber,
    body: messageText,
    threadKey: waMessageId,
    attachmentIds,
    sourceMessageId: operatorMessageId,
  }),
});
```

### email-channel-plugin (Phase 2)

Paperclip plugin that replaces `email-processor.ts`:
- IMAP polling moves out of core server
- Per-account IMAP credentials stored as plugin secrets
- Parses RFC-822, uploads attachment bytes via `/api/assets/upload`
- POSTs normalized message to `POST /api/ingest`
- `email_messages` insert moves into plugin (via direct DB or `/api/email-messages` endpoint)

## API Route

```
POST /api/ingest
Authorization: Bearer <board-api-token>
Body: InboundMessage (JSON)

Response:
  200 { status: "accepted", eaWakeupId?: string }
  400 { error: "missing required field" }
  401 unauthorized
```

Used by plugin channels only. In-process channels (email-processor Phase 1, telegram-polling) call `messageGateway(db, msg)` directly.

## inbound-router.ts (shrinks over time)

After Phase 1 refactor, `inbound-router.ts` is the fallback path for companies without an EA agent. Its `runOrchestrator` function stays, but sender resolution and message persistence move into message-gateway. Long term, when all companies have EA, this file becomes vestigial and can be removed.

## Files Created / Modified

| File | Change |
|------|--------|
| `server/src/services/message-gateway.ts` | **Create** — core gateway service |
| `server/src/routes/ingest.ts` | **Create** — POST /api/ingest route for plugins |
| `server/src/services/email-processor.ts` | **Modify** — strip routing, call gateway |
| `server/src/services/telegram-polling.ts` | **Modify** — strip routing, call gateway |
| `server/src/services/inbound-router.ts` | **Modify** — shrink to orchestrator fallback only |
| `server/src/app.ts` | **Modify** — register /api/ingest route |
| `packages/plugins/email-channel/` | **Create** (Phase 2) — email plugin |
| `packages/plugins/whatsapp-channel/` | **Create** (Phase 3) — WhatsApp plugin |

## Migration Phases

### Phase 1 — Extract gateway, refactor in-process channels
- Create `message-gateway.ts`
- Refactor `email-processor.ts` to call it
- Refactor `telegram-polling.ts` to call it
- `inbound-router.ts` becomes orchestrator-fallback only
- All existing tests pass, no behavior change

### Phase 2 — email-channel-plugin
- IMAP polling moves to Paperclip plugin
- `email-processor.ts` deleted (replaced by plugin)
- Plugin uses `/api/ingest` + `/api/assets/upload`
- Requires: WhatsApp working first as proof of concept, OR email plugin built independently

### Phase 3 — whatsapp-channel-plugin
- Meta webhook handler moves to Paperclip plugin
- WhatsApp messages flow through message-gateway same as email
- Sender classification (A/B/C/D/E) works identically for both channels

## EA Classification Flow (all channels)

After gateway wakes EA with `{ sourceMessageId, channel, fromAddr, clientId: null }`:

1. EA calls `get_email_message(sourceMessageId)` or equivalent per channel
2. Unknown sender → EA calls `notify_operator` with classification prompt:
   > "New [channel] from `<fromAddr>`. What is this?
   > A) New client  B) Vendor  C) Partner of [name]  D) Block domain  E) Discard once"
3. Operator replies → EA calls appropriate tool:
   - A → `create_client` + `ensure_client_folder`
   - B → `create_contact(role=vendor)`
   - C → `create_contact(role=partner, clientId=<id>)`
   - D → `block_sender_domain`
   - E → `discard_message`

Same flow regardless of channel. The `block_sender_domain` tool blocks by domain (email). For WhatsApp, the `domain` field stores the phone number or prefix (e.g. `+1234`). Gateway queries `blocked_sender_domains` using the appropriate field per channel — for WhatsApp it checks if `fromAddr` starts with any blocked entry for the company.

## Error Handling

- Gateway errors are non-fatal to channel processors — they log and return
- Attachment filing is always fire-and-forget (log warn on failure)
- Storage warning is always fire-and-forget
- If EA wakeup fails → message stays in `processingState = "pending"`, not lost
- `NODE_ENV === "test"` guard on `notifyStorageNotConfigured` to prevent Telegram noise in tests

## Testing

- Unit test `messageGateway()` with embedded postgres — mock `agentWakeupRequests` insert
- Test spam check: blocked domain → processingState = "ignored"
- Test sender resolve: known domain → correct clientId passed to wakeup
- Test fallback: no EA agent → `runOrchestrator` called
- Plugin tests: use plugin SDK test harness (from `@paperclipai/plugin-sdk`)
