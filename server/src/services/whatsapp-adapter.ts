// v3: WhatsApp platform adapter — Meta Cloud API (v19.0).
// Operator-review flow: inbound messages trigger agent analysis, not auto-reply.

import { logger } from "../middleware/logger.js";
import type { OutboundMessage } from "./operator-messaging.js";

const BASE_URL = "https://graph.facebook.com/v19.0";

async function waApi(
  token: string,
  phoneNumberId: string,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(`${BASE_URL}/${phoneNumberId}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WhatsApp API error (${phoneNumberId}/${endpoint}): ${res.status} ${text}`);
  }
  return res.json();
}

// ─── Public helpers ───────────────────────────────────────────────────────────

export async function sendWhatsAppMessage(
  token: string,
  phoneNumberId: string,
  to: string,
  text: string,
): Promise<{ messageId: string }> {
  const result = (await waApi(token, phoneNumberId, "messages", {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  })) as { messages: [{ id: string }] };
  return { messageId: result.messages?.[0]?.id ?? "" };
}

// ─── Adapter factory ──────────────────────────────────────────────────────────

export function createWhatsAppAdapter(token: string, phoneNumberId: string) {
  return {
    platform: "whatsapp" as const,

    async send(msg: OutboundMessage): Promise<{ threadKey: string }> {
      const to = msg.to[0] ?? "";
      try {
        await sendWhatsAppMessage(token, phoneNumberId, to, msg.body);
        return { threadKey: to };
      } catch (err) {
        logger.error({ err, to }, "whatsapp-adapter: send failed");
        throw err;
      }
    },

    async reply(threadKey: string, body: string): Promise<void> {
      try {
        await sendWhatsAppMessage(token, phoneNumberId, threadKey, body);
      } catch (err) {
        logger.error({ err, to: threadKey }, "whatsapp-adapter: reply failed");
        throw err;
      }
    },
  };
}
