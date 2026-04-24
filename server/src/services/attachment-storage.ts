// v3: filesystem sink for email attachments
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveEmailAttachmentsRoot } from "../home-paths.js";

// Replace characters that break filesystems; keep reasonably readable names.
function sanitizeFilename(input: string): string {
  const cleaned = input.replace(/[\/\\\x00]/g, "_").trim();
  if (!cleaned) return "attachment.bin";
  return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
}

export interface SaveAttachmentInput {
  emailMessageId: string;
  filename: string;
  content: Buffer;
}

export interface SavedAttachment {
  storagePath: string;
  sizeBytes: number;
}

// Writes to <root>/<emailMessageId>/<idx>-<filename>. Caller provides an idx
// prefix by passing unique filenames; duplicates get suffixed by the mailparser
// index upstream. No async I/O — writeFileSync is fine here because attachment
// counts per message are tiny and the caller already awaits the message.
export function saveAttachment(input: SaveAttachmentInput): SavedAttachment {
  const root = resolveEmailAttachmentsRoot();
  const dir = path.resolve(root, input.emailMessageId);
  mkdirSync(dir, { recursive: true });
  const safe = sanitizeFilename(input.filename);
  const storagePath = path.resolve(dir, safe);
  writeFileSync(storagePath, input.content);
  return { storagePath, sizeBytes: input.content.length };
}
