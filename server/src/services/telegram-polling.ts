import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import { companies, instanceSettings } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import type { EaNotificationEvent, EaNotificationMatrix } from "@paperclipai/shared";
import { sendTelegramMessage, sendTelegramChatAction } from "./telegram-adapter.js";
import { logActivity } from "./activity-log.js";
import { readInstanceToken } from "./instance-token-store.js";
import { logger } from "../middleware/logger.js";
import { routeInboundMessage } from "./inbound-router.js";

const BASE_URL = "https://api.telegram.org";

async function tgGet(token: string, method: string, params: Record<string, unknown> = {}) {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  const url = `${BASE_URL}/bot${token}/${method}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string; error_code?: number };
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? "unknown"} (code ${json.error_code})`);
  return json.result;
}

interface PhotoSize { file_id: string; width: number; height: number; file_size?: number; }

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string; title?: string; first_name?: string };
  text?: string;
  caption?: string;
  photo?: PhotoSize[];
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  audio?: { file_id: string; duration: number; mime_type?: string; file_name?: string };
  document?: { file_id: string; file_name?: string; mime_type?: string };
  video?: { file_id: string; duration: number; mime_type?: string };
  date: number;
}

interface Update {
  update_id: number;
  message?: TelegramMessage;
}

async function downloadTelegramFile(token: string, fileId: string, ext: string): Promise<string | null> {
  try {
    const info = (await tgGet(token, "getFile", { file_id: fileId })) as { file_path?: string };
    if (!info.file_path) return null;
    const url = `${BASE_URL}/file/bot${token}/${info.file_path}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = path.join(os.tmpdir(), `tg-${fileId.slice(-8)}.${ext}`);
    await fs.writeFile(dest, buf);
    return dest;
  } catch (err) {
    logger.warn({ err, fileId }, "telegram-polling: file download failed");
    return null;
  }
}

const WHISPER_PYTHON = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.whisper-env/bin/python",
);
const TRANSCRIBE_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/transcribe.py",
);

async function transcribeAudio(audioPath: string): Promise<string | null> {
  try {
    await fs.access(WHISPER_PYTHON);
  } catch {
    logger.warn("telegram-polling: whisper venv not found — skipping transcription");
    return null;
  }
  return new Promise((resolve) => {
    let out = "", err = "";
    const proc = spawn(WHISPER_PYTHON, [TRANSCRIBE_SCRIPT, audioPath, "base"], { stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) {
        logger.warn({ code, stderr: err.slice(0, 300) }, "telegram-polling: transcription failed");
        resolve(null);
      } else {
        resolve(out.trim() || null);
      }
    });
  });
}

declare const global: { __tgPollingActive?: boolean };

export async function startTelegramPolling(db: Db, envToken: string, companyId?: string): Promise<void> {
  if (global.__tgPollingActive) return;
  global.__tgPollingActive = true;

  // Resolve token: DB (encrypted) takes priority over env var
  async function resolveToken(): Promise<string> {
    try {
      const dbToken = await readInstanceToken(db, "telegramBotToken");
      if (dbToken) {
        logger.info("telegram-polling: token resolved from DB ✓");
        return dbToken;
      }
    } catch (err) {
      logger.warn({ err }, "telegram-polling: DB token decrypt failed, falling back to env");
    }
    if (envToken) logger.info("telegram-polling: token resolved from env ✓");
    else logger.warn("telegram-polling: no token found (DB or env) — will retry");
    return envToken;
  }

  const initialToken = await resolveToken();

  // Delete any existing webhook so polling works
  try {
    await tgGet(initialToken, "deleteWebhook", { drop_pending_updates: "false" });
    logger.info("telegram-polling: webhook cleared ✓");
  } catch (err) {
    logger.warn({ err }, "telegram-polling: deleteWebhook failed (likely no token yet)");
  }

  // Register bot commands (shows autocomplete UI in Telegram)
  try {
    await tgGet(initialToken, "setMyCommands", {
      commands: JSON.stringify([
        { command: "help", description: "Show available commands" },
        { command: "issues", description: "List open issues" },
        { command: "status", description: "System status overview" },
        { command: "agents", description: "List active agents" },
      ]),
    });
    logger.info("telegram-polling: bot commands registered ✓");
  } catch (err) {
    logger.warn({ err }, "telegram-polling: setMyCommands failed");
  }

  let offset = 0;

  async function resolveCompanyId(): Promise<string> {
    if (companyId) return companyId; // env var TELEGRAM_COMPANY_ID — hard override
    // Check DB routing setting
    const [settings] = await db.select({ general: instanceSettings.general }).from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")).limit(1);
    const dbCompanyId = (settings?.general as Record<string, unknown> | null)?.telegramCompanyId as string | null | undefined;
    if (dbCompanyId) return dbCompanyId;
    // Fallback: first company in DB
    const [first] = await db.select({ id: companies.id }).from(companies).limit(1);
    return first?.id ?? "";
  }

  async function handleMessage(msg: TelegramMessage, resolvedCompanyId: string, resolvedToken: string) {
    // Accept text, captions (on photos/videos), and media-only messages
    const hasContent = msg.text || msg.caption || msg.photo || msg.voice || msg.audio || msg.document || msg.video;
    if (!hasContent) return;

    const chatId = String(msg.chat.id);
    logger.info({ chatId, text: msg.text ?? msg.caption ?? "(media)" }, "telegram-polling: message received ✓");

    // Persist operator chat ID so outbound tools can reply
    db.insert(instanceSettings)
      .values({ singletonKey: "default", general: { telegramOperatorChatId: chatId }, experimental: {} })
      .onConflictDoUpdate({
        target: instanceSettings.singletonKey,
        set: {
          general: sql`instance_settings.general || jsonb_build_object('telegramOperatorChatId', ${chatId}::text)`,
          updatedAt: new Date(),
        },
      })
      .catch(() => {});

    const rawText = msg.text ?? msg.caption ?? "";

    if (rawText.trim().toLowerCase() === "paperclip") {
      await sendTelegramMessage(resolvedToken, chatId, "✅ Paperclip is connected and receiving messages!");
      return;
    }

    // Download any attached media and collect file paths for Claude to read
    const mediaParts: string[] = [];

    if (msg.photo?.length) {
      // Pick the largest resolution photo
      const largest = msg.photo.reduce((a, b) => (b.file_size ?? 0) > (a.file_size ?? 0) ? b : a);
      const filePath = await downloadTelegramFile(resolvedToken, largest.file_id, "jpg");
      if (filePath) mediaParts.push(`Photo saved at: ${filePath} (use the Read tool to view it)`);
    }

    if (msg.voice) {
      const ext = msg.voice.mime_type === "audio/ogg" ? "ogg" : "oga";
      const filePath = await downloadTelegramFile(resolvedToken, msg.voice.file_id, ext);
      if (filePath) {
        const transcript = await transcribeAudio(filePath);
        if (transcript) {
          mediaParts.push(`Voice note transcript: "${transcript}"`);
        } else {
          mediaParts.push(`Voice note (${msg.voice.duration}s) — transcription unavailable, file at: ${filePath}`);
        }
      } else {
        mediaParts.push(`Voice note (${msg.voice.duration}s) — download failed`);
      }
    }

    if (msg.audio) {
      const ext = (msg.audio.mime_type?.split("/")[1]) ?? "mp3";
      const filePath = await downloadTelegramFile(resolvedToken, msg.audio.file_id, ext);
      const label = msg.audio.file_name ?? "audio";
      if (filePath) {
        const transcript = await transcribeAudio(filePath);
        if (transcript) {
          mediaParts.push(`Audio "${label}" transcript: "${transcript}"`);
        } else {
          mediaParts.push(`Audio file "${label}" saved at: ${filePath}`);
        }
      }
    }

    if (msg.document) {
      const ext = msg.document.file_name?.split(".").pop() ?? "bin";
      const filePath = await downloadTelegramFile(resolvedToken, msg.document.file_id, ext);
      const label = msg.document.file_name ?? "document";
      if (filePath) mediaParts.push(`Document "${label}" saved at: ${filePath} (use the Read tool to inspect it)`);
    }

    if (msg.video) {
      const filePath = await downloadTelegramFile(resolvedToken, msg.video.file_id, "mp4");
      if (filePath) mediaParts.push(`Video (${msg.video.duration}s) saved at: ${filePath}`);
    }

    // Build body: text/caption + any media descriptions
    let body = rawText;
    if (mediaParts.length > 0) {
      if (body) body += "\n\n";
      body += mediaParts.join("\n");
    }
    if (!body.trim()) body = "(no text — media only)";

    // Slash command handling — may override body sent to orchestrator
    if (rawText.startsWith("/")) {
      const [rawCmd] = rawText.slice(1).split(/[\s@]/);
      const cmd = rawCmd?.toLowerCase() ?? "";

      if (cmd === "help") {
        await sendTelegramMessage(
          resolvedToken,
          chatId,
          "📋 *Paperclip commands*\n\n" +
          "/issues — List open issues\n" +
          "/status — System status overview\n" +
          "/agents — List active agents\n" +
          "/help — Show this message\n\n" +
          "You can also send any natural language command.",
        );
        return;
      }

      const COMMAND_HINTS: Record<string, string> = {
        issues: "The operator ran /issues. List all open issues grouped by status. Be concise.",
        status: "The operator ran /status. Summarise: count of open issues by status, any blocked issues, any active agents. Be concise.",
        agents: "The operator ran /agents. List all agents with their current status. Be concise.",
      };

      const hint = COMMAND_HINTS[cmd];
      if (hint) body = hint;
      // Unknown slash commands fall through to orchestrator as-is
    }

    void logActivity(db, {
      companyId: resolvedCompanyId,
      actorType: "system",
      actorId: chatId,
      action: "telegram.message.inbound",
      entityType: "chat_thread",
      entityId: chatId,
      details: { chatId, text: body.slice(0, 500) },
    });

    // Show typing while orchestrator runs
    void sendTelegramChatAction(resolvedToken, chatId);
    const typingInterval = setInterval(() => void sendTelegramChatAction(resolvedToken, chatId), 4_000);

    routeInboundMessage(db, {
      companyId: resolvedCompanyId,
      platform: "telegram",
      fromAddr: chatId,
      body,
      threadKey: chatId,
    }).catch((err) => logger.error({ err, chatId }, "telegram-polling: inbound-router failed"))
      .finally(() => clearInterval(typingInterval));
  }

  const poll = async () => {
    if (!global.__tgPollingActive) return;
    try {
      const token = await resolveToken();
      const updates = (await tgGet(token, "getUpdates", {
        offset,
        timeout: 8,
        allowed_updates: "message",
      })) as Update[];

      const resolvedCompanyId = await resolveCompanyId();
      if (!resolvedCompanyId) {
        logger.warn("telegram-polling: no company found, retrying in 10s");
        setTimeout(poll, 10_000);
        return;
      }

      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          handleMessage(update.message, resolvedCompanyId, token).catch((err) =>
            logger.warn({ err }, "telegram-polling: message handler error"),
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const is409 = msg.includes("409") || msg.includes("Conflict") || msg.includes("terminated by other");
      if (is409) {
        // Another getUpdates is still in flight (e.g. previous server process hot-reload).
        // Timeout is 8s, so wait 12s to guarantee the other request is dead.
        logger.warn("telegram-polling: 409 conflict — another poller still running, waiting 12s");
        setTimeout(poll, 12_000);
      } else {
        const isTimeout = msg.includes("ETIMEDOUT") || msg.includes("fetch failed");
        if (isTimeout) {
          logger.debug({ err }, "telegram-polling: network timeout, retrying in 5s");
        } else {
          logger.warn({ err }, "telegram-polling: getUpdates error, retrying in 5s");
        }
        setTimeout(poll, 5_000);
      }
      return;
    }
    // Immediately poll again (long polling — 25s timeout means we wait up to 25s per request)
    setImmediate(poll);
  };

  // Start polling
  poll();
  logger.info("telegram-polling: started");
}

export function stopTelegramPolling() {
  global.__tgPollingActive = false;
}

// Shared helper — resolves bot token + operator chat ID from DB/env and sends a message.
// Use this everywhere instead of duplicating the lookup pattern.
export async function notifyOperatorTelegram(db: Db, message: string): Promise<void> {
  const token = await readInstanceToken(db, "telegramBotToken").catch(() => null)
    ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!token) return;
  const [settings] = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"))
    .limit(1);
  const chatId = ((settings?.general as Record<string, unknown> | null)?.telegramOperatorChatId as string | undefined)
    ?? process.env.TELEGRAM_OPERATOR_CHAT_ID ?? "";
  if (!chatId) return;
  await sendTelegramMessage(token, chatId, message);
}

// Multi-channel operator notification. Checks eaNotificationMatrix in instance_settings
// for per-event per-channel routing. Pass eventType to gate on matrix; omit to send to all channels.
export async function notifyOperator(db: Db, message: string, eventType?: EaNotificationEvent): Promise<void> {
  const [settings] = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"))
    .limit(1);
  const general = (settings?.general ?? {}) as Record<string, unknown>;
  const matrix = (general.eaNotificationMatrix ?? null) as EaNotificationMatrix | null;

  function channelEnabled(channel: "telegram" | "email"): boolean {
    if (!matrix) return channel === "telegram"; // default: telegram only
    if (!eventType) return true; // no event type = always send
    return matrix[channel]?.[eventType] ?? false;
  }

  const results = await Promise.allSettled([
    channelEnabled("telegram") ? notifyOperatorTelegram(db, message) : Promise.resolve(),
    channelEnabled("email") ? notifyOperatorEmail(db, general, message) : Promise.resolve(),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn({ err: result.reason }, "notifyOperator: channel delivery failed");
    }
  }
}

async function notifyOperatorEmail(db: Db, general: Record<string, unknown>, message: string): Promise<void> {
  const toAddr = (general.operatorNotifyEmail as string | undefined) ?? "";
  if (!toAddr) return;

  // Find any active outbound email account to use as sender
  const { emailAccounts } = await import("@paperclipai/db");
  const { sendEmailFromAccount } = await import("./email-sender.js");
  const [account] = await db
    .select({ id: emailAccounts.id, companyId: emailAccounts.companyId })
    .from(emailAccounts)
    .limit(1);
  if (!account) return;

  const subject = message.split("\n")[0]?.slice(0, 100) ?? "Paperclip notification";
  const htmlBody = `<pre style="font-family:sans-serif;white-space:pre-wrap">${message.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`;
  await sendEmailFromAccount(db, {
    accountId: account.id,
    to: toAddr,
    subject,
    html: htmlBody,
    text: message,
  });
}
