# Email Send & Reply Design

**Goal:** Let operators send new emails and reply to inbound emails directly from the Paperclip inbox UI.

**Architecture:** Two new Express routes backed by the existing `sendEmailFromAccount()` service. No DB schema changes. Sent emails logged to activity log only (no new `emailMessages` rows in V1). Agent-originated replies continue to use the existing `client_reply` approval gate unchanged.

**Tech Stack:** Express 5, existing `email-sender.ts` (nodemailer), React 19 + TanStack Query, existing `emailMessagesApi` client.

---

## 1. Backend — New Routes

### `POST /api/email-messages/:id/reply`

Operator-only (board auth). Replies to an inbound email, preserving RFC-2822 threading.

**Request body:**
```json
{ "body": "string (required)", "accountId": "uuid (optional — defaults to message's emailAccountId)" }
```

**Logic:**
1. Fetch `emailMessage` by `:id`, verify it belongs to a company the operator controls.
2. Resolve send account: use `accountId` from body if provided, else use `message.emailAccountId`.
3. Verify account belongs to the same `companyId`.
4. Call `sendEmailFromAccount(db, { accountId, to: [message.fromAddr], subject: "Re: " + message.subject, text: body, inReplyTo: message.messageIdHeader, references: [...(message.referencesHeaders ?? []), message.messageIdHeader] })`.
5. Insert activity log entry: `{ kind: "email_replied", detail: { to: message.fromAddr, subject, messageId } }`.
6. Return `200 { messageId, accepted, rejected }`.

**Errors:** `404` if message not found, `400` if account not found or belongs to different company, `502` if SMTP send fails (include SMTP error message).

---

### `POST /api/companies/:companyId/send-email`

Operator-only (board auth). Sends a fresh email from a chosen account.

**Request body:**
```json
{
  "accountId": "uuid (required)",
  "to": ["string (required, at least one)"],
  "subject": "string (required)",
  "body": "string (required)"
}
```

**Logic:**
1. Verify `accountId` belongs to `:companyId`.
2. Call `sendEmailFromAccount(db, { accountId, to, subject, text: body })`.
3. Insert activity log entry: `{ kind: "email_sent", detail: { to, subject, messageId } }`.
4. Return `200 { messageId, accepted, rejected }`.

**Errors:** `400` if `to` empty or account not found/wrong company, `422` if subject/body blank, `502` if SMTP fails.

---

## 2. Frontend — API Client

Add to `ui/src/api/emailMessages.ts`:

```typescript
reply: (id: string, opts: { body: string; accountId?: string }) =>
  api.post<{ messageId: string; accepted: string[]; rejected: string[] }>(
    `/email-messages/${encodeURIComponent(id)}/reply`,
    opts,
  ),
sendNew: (companyId: string, opts: { accountId: string; to: string[]; subject: string; body: string }) =>
  api.post<{ messageId: string; accepted: string[]; rejected: string[] }>(
    `/companies/${encodeURIComponent(companyId)}/send-email`,
    opts,
  ),
```

---

## 3. Frontend — Components

Both components live in `ui/src/pages/EmailInbox.tsx`.

### `ReplyPanel`

Inline panel rendered below `EmailBodyRenderer` inside `MessageDetail`. Toggled by a **Reply** button added to the `MessageDetail` toolbar.

**Props:** `detail: EmailMessageDetail`, `companyId: string`, `accounts: EmailAccount[]`

**State:** `open: boolean`, `body: string`, `accountId: string` (default = `detail.emailAccountId`)

**Layout when open:**
```
┌─────────────────────────────────────────────────┐
│ Reply to: fromAddr@example.com                  │
│ From: [account picker dropdown]  (if >1 acct)  │
│ ┌─────────────────────────────────────────────┐ │
│ │ textarea (min 5 rows)                       │ │
│ └─────────────────────────────────────────────┘ │
│                          [Cancel]  [Send Reply] │
└─────────────────────────────────────────────────┘
```

- Account picker only rendered if company has >1 email account.
- Send button disabled while mutation pending or `body.trim()` empty.
- On success: collapse panel, reset body, show success toast.
- On error: show error toast with SMTP message.

### `ComposeDialog`

Modal opened by **Compose** button in inbox header (between existing mailbox tabs and Refresh button).

**State (in `EmailInbox`):** `composeOpen: boolean`

**Props:** `companyId: string`, `accounts: EmailAccount[]`, `open: boolean`, `onClose: () => void`

**Fields:**
| Field | Control | Validation |
|-------|---------|------------|
| From | `<select>` over accounts | Required |
| To | `<Input>` comma-separated | Required, ≥1 address |
| Subject | `<Input>` | Required |
| Body | `<textarea>` min 6 rows | Required |

- To field split on commas/semicolons/spaces into `string[]` before submit.
- Send button disabled while mutation pending or any required field empty.
- On success: close dialog, reset fields, show success toast.
- On error: show error inline below body field.

### Account list query

Both components need a list of company email accounts. Add one query in `EmailInbox`:

```typescript
const accountsQuery = useQuery({
  queryKey: ["email-accounts", companyId],
  queryFn: () => emailAccountsApi.list(companyId),
  enabled: !!companyId,
});
```

Pass `accountsQuery.data ?? []` as the `accounts` prop to both `ReplyPanel` and `ComposeDialog`. Import type `EmailAccount` from `../api/emailAccounts`.

---

## 4. Activity Log Entries

Two new `kind` values written on send:

| kind | written by | detail fields |
|------|-----------|---------------|
| `email_replied` | reply route | `to`, `subject`, `smtpMessageId` |
| `email_sent` | send-email route | `to[]`, `subject`, `smtpMessageId` |

No new activity schema changes needed — `kind` is a free-form string in the existing `activityLog` table.

---

## 5. Out of Scope (V1)

- Rich text / HTML compose (plain text only)
- CC / BCC fields
- Attachments on outbound emails
- Outbox / sent folder view
- Draft saving
- Agent compose via MCP tool (agents already use `client_reply` approval flow)
