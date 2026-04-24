// v3: parses raw IMAP RFC-822 bytes → email_messages + email_attachments rows,
// saves attachment blobs to the filesystem. Pure of IMAP — takes Buffer in,
// returns the inserted message id.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { emailMessages, emailAttachments } from "@paperclipai/db";
import { saveAttachment } from "./attachment-storage.js";
import { logger } from "../middleware/logger.js";

export interface ProcessEmailInput {
  emailAccountId: string;
  rawBytes: Buffer;
  // If caller already knows the IMAP INTERNALDATE it can override the parsed Date
  fallbackReceivedAt?: Date;
}

export interface ProcessEmailResult {
  emailMessageId: string;
  duplicated: boolean;
  attachmentCount: number;
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function extractEmailAddresses(input: unknown): string[] {
  if (!input) return [];
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) return input.flatMap((v) => extractEmailAddresses(v));
  if (typeof input === "object") {
    const obj = input as { value?: Array<{ address?: string }>; address?: string };
    if (Array.isArray(obj.value)) {
      return obj.value.map((v) => v.address).filter((v): v is string => !!v);
    }
    if (typeof obj.address === "string") return [obj.address];
  }
  return [];
}

export function emailProcessorService(db: Db) {
  async function processRawMessage(input: ProcessEmailInput): Promise<ProcessEmailResult> {
    const { simpleParser } = await import("mailparser");
    const parsed = await simpleParser(input.rawBytes);

    const messageIdHeader = parsed.messageId ?? `<no-id-${Date.now()}@paperclip>`;
    const fromAddr = extractEmailAddresses(parsed.from)[0] ?? "";
    const toAddrs = extractEmailAddresses(parsed.to);
    const subject = parsed.subject ?? "";
    const body = parsed.text ?? parsed.html ?? "";
    const receivedAt = parsed.date ?? input.fallbackReceivedAt ?? new Date();

    // Dedup check — unique index on (emailAccountId, messageIdHeader) would
    // throw, but a pre-check gives us a clean duplicated=true return instead
    // of noisy error logs.
    const existing = await db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(
        and(
          eq(emailMessages.emailAccountId, input.emailAccountId),
          eq(emailMessages.messageIdHeader, messageIdHeader),
        ),
      )
      .limit(1);
    if (existing[0]) {
      return { emailMessageId: existing[0].id, duplicated: true, attachmentCount: 0 };
    }

    const [inserted] = await db
      .insert(emailMessages)
      .values({
        emailAccountId: input.emailAccountId,
        messageIdHeader,
        fromAddr,
        toAddrs,
        subject,
        body: typeof body === "string" ? body : "",
        receivedAt,
        rawHeaders: Object.fromEntries(parsed.headers ?? []) as Record<string, unknown>,
      })
      .returning();

    const attachments = asArray(parsed.attachments);
    let attachmentCount = 0;
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i]!;
      const content = att.content;
      if (!content || !Buffer.isBuffer(content)) continue;
      const rawName = att.filename ?? `attachment-${i + 1}`;
      // Prefix with index to avoid intra-message filename collisions.
      const filename = `${String(i + 1).padStart(2, "0")}-${rawName}`;
      try {
        const saved = saveAttachment({
          emailMessageId: inserted!.id,
          filename,
          content,
        });
        await db.insert(emailAttachments).values({
          emailMessageId: inserted!.id,
          filename: rawName,
          contentType: att.contentType ?? "application/octet-stream",
          contentId: att.cid ?? null,
          isInline: att.contentDisposition === "inline",
          sizeBytes: saved.sizeBytes,
          storagePath: saved.storagePath,
        });
        attachmentCount++;
      } catch (err) {
        logger.warn(
          { err, emailMessageId: inserted!.id, filename: rawName },
          "Failed to save email attachment",
        );
      }
    }

    if (attachmentCount > 0) {
      // Record a per-message folder hint (human convenience).
      const folder = `${inserted!.id}`;
      await db
        .update(emailMessages)
        .set({ attachmentsPath: folder })
        .where(eq(emailMessages.id, inserted!.id));
    }

    return {
      emailMessageId: inserted!.id,
      duplicated: false,
      attachmentCount,
    };
  }

  return { processRawMessage };
}

export type EmailProcessorService = ReturnType<typeof emailProcessorService>;
