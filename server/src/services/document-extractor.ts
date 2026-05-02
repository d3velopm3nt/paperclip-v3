import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { logger } from "../middleware/logger.js";

const require = createRequire(import.meta.url);

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

export async function extractTextFromFile(filePath: string): Promise<string | null> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) return null;
  if (stat.size > MAX_BYTES) {
    logger.warn({ filePath, size: stat.size }, "document-extractor: file too large, skipping");
    return null;
  }

  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === ".md" || ext === ".txt") {
      return await fs.readFile(filePath, "utf-8");
    }
    if (ext === ".pdf") {
      // pdf-parse is CJS — use require() to get the function directly
      const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
      const buffer = await fs.readFile(filePath);
      const data = await pdfParse(buffer);
      return data.text ?? null;
    }
    if (ext === ".docx") {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value ?? null;
    }
    return null;
  } catch (err) {
    logger.warn({ err, filePath }, "document-extractor: extraction failed");
    return null;
  }
}

export async function extractTextFromBuffer(
  buffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  if (buffer.length > MAX_BYTES) return null;
  try {
    if (mimeType === "text/plain" || mimeType === "text/markdown") {
      return buffer.toString("utf-8");
    }
    if (mimeType === "application/pdf") {
      const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
      const data = await pdfParse(buffer);
      return data.text ?? null;
    }
    if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return result.value ?? null;
    }
    return null;
  } catch (err) {
    logger.warn({ err, mimeType }, "document-extractor: buffer extraction failed");
    return null;
  }
}

export function computeChecksum(content: string | Buffer): string {
  const data = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
  return createHash("md5").update(data).digest("hex");
}

export const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".pdf", ".docx"]);

export const SUPPORTED_DRIVE_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.google-apps.document",
]);
