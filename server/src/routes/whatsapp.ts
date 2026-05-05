// v3: WhatsApp webhook receiver + Channels config API (Meta Cloud API).
// Inbound flow: allowlist check → thread → agent analysis → operator notification.
// Operator reviews analysis in /chat and replies manually (no auto-send).

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companies, instanceSettings } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "../middleware/logger.js";
import { assertBoard } from "./authz.js";
import { sendWhatsAppMessage } from "../services/whatsapp-adapter.js";
import { readInstanceToken, writeInstanceToken, deleteInstanceToken } from "../services/instance-token-store.js";
import { routeInboundMessage } from "../services/inbound-router.js";

const WA_COMPANY_ID = process.env.WHATSAPP_COMPANY_ID ?? "";

// ─── Startup helper ───────────────────────────────────────────────────────────

export function whatsappRoutes(db: Db): Router {
  const router = Router();

  // ── Webhook verification (GET — called by Meta when you set the webhook URL) ─

  router.get("/whatsapp/webhook", (req, res) => {
    const mode = req.query["hub.mode"] as string;
    const token = req.query["hub.verify_token"] as string;
    const challenge = req.query["hub.challenge"] as string;

    getWhatsAppSettings(db).then(({ verifyToken }) => {
      if (mode === "subscribe" && token === (verifyToken ?? "paperclip-wa")) {
        logger.info("whatsapp: webhook verified by Meta ✓");
        res.status(200).send(challenge);
      } else {
        logger.warn({ mode, token }, "whatsapp: webhook verification failed");
        res.status(403).json({ error: "forbidden" });
      }
    }).catch(() => res.status(403).json({ error: "forbidden" }));
  });

  // ── Inbound webhook (POST — Meta sends message events here) ──────────────────

  router.post("/whatsapp/webhook", async (req, res) => {
    // Meta expects 200 immediately
    res.status(200).json({ ok: true });

    const payload = req.body as WhatsAppWebhookPayload;
    if (payload.object !== "whatsapp_business_account") return;

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "messages") continue;
        const value = change.value;
        for (const message of value.messages ?? []) {
          if (message.type !== "text") continue;

          const fromPhone = message.from; // e.g. "447911123456" (no +)
          const fromPhoneNormalized = fromPhone.startsWith("+") ? fromPhone : `+${fromPhone}`;
          const contactName = value.contacts?.find((c) => c.wa_id === fromPhone)?.profile?.name ?? fromPhone;
          const text = message.text?.body ?? "";

          handleInboundWhatsApp(db, fromPhoneNormalized, contactName, text, payload).catch((err) =>
            logger.error({ err, fromPhone }, "whatsapp webhook: handler failed"),
          );
        }
      }
    }
  });

  // ── Access token ─────────────────────────────────────────────────────────────

  router.put("/channels/whatsapp/token", async (req, res) => {
    assertBoard(req);
    const { token } = req.body as { token?: string };
    if (!token?.trim()) {
      res.status(400).json({ error: "token required" });
      return;
    }
    try {
      await writeInstanceToken(db, "whatsappAccessToken", token.trim());
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(422).json({ error: msg });
    }
  });

  router.delete("/channels/whatsapp/token", async (req, res) => {
    assertBoard(req);
    await deleteInstanceToken(db, "whatsappAccessToken");
    res.json({ ok: true });
  });

  // ── Phone Number ID + WABA ID ────────────────────────────────────────────────

  router.put("/channels/whatsapp/phone", async (req, res) => {
    assertBoard(req);
    const { phoneNumberId, wabaId } = req.body as { phoneNumberId?: string; wabaId?: string };
    if (!phoneNumberId?.trim() || !wabaId?.trim()) {
      res.status(400).json({ error: "phoneNumberId and wabaId required" });
      return;
    }
    await upsertInstanceSetting(db, {
      whatsappPhoneNumberId: phoneNumberId.trim(),
      whatsappWabaId: wabaId.trim(),
    });
    res.json({ ok: true });
  });

  // ── Webhook verify token ─────────────────────────────────────────────────────

  router.put("/channels/whatsapp/verify-token", async (req, res) => {
    assertBoard(req);
    const { verifyToken } = req.body as { verifyToken?: string };
    if (!verifyToken?.trim()) {
      res.status(400).json({ error: "verifyToken required" });
      return;
    }
    await upsertInstanceSetting(db, { whatsappVerifyToken: verifyToken.trim() });
    res.json({ ok: true });
  });

  // ── Allowed contacts ─────────────────────────────────────────────────────────

  router.put("/channels/whatsapp/contacts", async (req, res) => {
    assertBoard(req);
    const { contacts } = req.body as { contacts?: string[] };
    if (!Array.isArray(contacts)) {
      res.status(400).json({ error: "contacts array required" });
      return;
    }
    const normalized = contacts
      .map((c) => c.trim())
      .filter((c) => c.length > 0)
      .map((c) => (c.startsWith("+") ? c : `+${c}`));
    await upsertInstanceSetting(db, { whatsappAllowedContacts: normalized });
    res.json({ ok: true });
  });

  // ── Company routing ──────────────────────────────────────────────────────────

  router.put("/channels/whatsapp/routing", async (req, res) => {
    assertBoard(req);
    const { companyId } = req.body as { companyId: string | null };
    await upsertInstanceSetting(db, { whatsappCompanyId: companyId ?? null });
    res.json({ ok: true });
  });

  // ── Register webhook URL (informational — Meta Cloud API manages the actual subscription) ─

  router.post("/channels/whatsapp/webhook", async (req, res) => {
    assertBoard(req);
    const { url } = req.body as { url?: string };
    if (!url) {
      res.status(400).json({ error: "url required" });
      return;
    }
    const webhookUrl = `${url.replace(/\/$/, "")}/api/whatsapp/webhook`;
    await upsertInstanceSetting(db, { whatsappWebhookUrl: webhookUrl });
    res.json({ ok: true, webhookUrl });
  });

  // ── Test: send a message to the operator's number ───────────────────────────

  router.post("/channels/whatsapp/test", async (req, res) => {
    assertBoard(req);
    const { token, phoneNumberId, contacts } = await getWhatsAppSettings(db);
    if (!token || !phoneNumberId) {
      res.status(422).json({ error: "Access token and phone number ID required" });
      return;
    }
    const testTarget = contacts?.[0];
    if (!testTarget) {
      res.status(422).json({ error: "Add at least one allowed contact to test" });
      return;
    }
    try {
      await sendWhatsAppMessage(token, phoneNumberId, testTarget.replace(/^\+/, ""), "✅ Paperclip WhatsApp test — channel is working.");
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(422).json({ error: msg });
    }
  });

  return router;
}

// ─── Inbound handler ─────────────────────────────────────────────────────────

async function handleInboundWhatsApp(
  db: Db,
  fromPhone: string,
  contactName: string,
  text: string,
  raw: unknown,
): Promise<void> {
  const { token, phoneNumberId, allowedContacts, companyId: routedCompanyId } = await getWhatsAppSettings(db);

  // Check allowlist
  const normalizedFrom = fromPhone.startsWith("+") ? fromPhone : `+${fromPhone}`;
  const allowed = allowedContacts ?? [];
  if (allowed.length > 0 && !allowed.includes(normalizedFrom)) {
    logger.info({ fromPhone: normalizedFrom }, "whatsapp: contact not in allowlist, ignoring");
    return;
  }

  // Resolve company
  let companyId = WA_COMPANY_ID || routedCompanyId;
  if (!companyId) {
    const [first] = await db.select({ id: companies.id }).from(companies).limit(1);
    companyId = first?.id ?? "";
  }
  if (!companyId) {
    logger.warn("whatsapp webhook: no company found, dropping message");
    return;
  }

  logger.info({ fromPhone: normalizedFrom, contactName, text }, "whatsapp: inbound message ✓");

  await routeInboundMessage(db, {
    companyId,
    platform: "whatsapp",
    fromAddr: normalizedFrom,
    body: text,
    threadKey: normalizedFrom,
  });
}

// ─── Status helper (used by channels/status endpoint) ────────────────────────

export async function getWhatsAppStatus(db: Db): Promise<{
  configured: boolean;
  tokenSource?: "db" | null;
  phoneNumberId?: string | null;
  webhookVerified?: boolean;
  allowedContacts?: string[];
  activeCompanyId?: string | null;
  error?: string;
}> {
  const token = await readInstanceToken(db, "whatsappAccessToken").catch(() => null);
  const settings = await getWhatsAppSettings(db);

  if (!token && !settings.phoneNumberId) {
    return { configured: false };
  }

  return {
    configured: !!(token && settings.phoneNumberId),
    tokenSource: token ? "db" : null,
    phoneNumberId: settings.phoneNumberId ?? null,
    webhookVerified: false, // Meta sends a GET verification — we track via the verify flow
    allowedContacts: settings.allowedContacts ?? [],
    activeCompanyId: settings.companyId ?? null,
  };
}

// ─── Settings helpers ─────────────────────────────────────────────────────────

async function getWhatsAppSettings(db: Db): Promise<{
  token: string | null;
  phoneNumberId: string | null;
  verifyToken: string | null;
  allowedContacts: string[] | null;
  companyId: string | null;
  webhookUrl: string | null;
}> {
  const [row] = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"))
    .limit(1);

  const g = (row?.general as Record<string, unknown> | null) ?? {};
  const token = await readInstanceToken(db, "whatsappAccessToken").catch(() => null);

  return {
    token,
    phoneNumberId: (g.whatsappPhoneNumberId as string | null | undefined) ?? null,
    verifyToken: (g.whatsappVerifyToken as string | null | undefined) ?? null,
    allowedContacts: Array.isArray(g.whatsappAllowedContacts)
      ? (g.whatsappAllowedContacts as string[])
      : null,
    companyId: (g.whatsappCompanyId as string | null | undefined) ?? null,
    webhookUrl: (g.whatsappWebhookUrl as string | null | undefined) ?? null,
  };
}

async function upsertInstanceSetting(db: Db, patch: Record<string, unknown>): Promise<void> {
  const jsonPatch = JSON.stringify(patch);
  await db
    .insert(instanceSettings)
    .values({ singletonKey: "default", general: patch })
    .onConflictDoUpdate({
      target: instanceSettings.singletonKey,
      set: {
        general: sql`instance_settings.general || ${jsonPatch}::jsonb`,
        updatedAt: new Date(),
      },
    });
}

// ─── Meta webhook payload types ───────────────────────────────────────────────

interface WhatsAppWebhookPayload {
  object: string;
  entry?: {
    id: string;
    changes?: {
      field: string;
      value: {
        messaging_product: string;
        metadata?: { display_phone_number: string; phone_number_id: string };
        contacts?: { profile: { name: string }; wa_id: string }[];
        messages?: {
          from: string;
          id: string;
          timestamp: string;
          type: string;
          text?: { body: string };
        }[];
      };
    }[];
  }[];
}
