// Encrypted storage for instance-level tokens (e.g. Telegram bot token).
// Uses same AES-256-GCM scheme as the local_encrypted secrets provider.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { instanceSettings } from "@paperclipai/db";

interface EncryptedToken {
  scheme: "aes256gcm_v1";
  iv: string;
  tag: string;
  ciphertext: string;
}

function loadMasterKey(): Buffer | null {
  const envKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY?.trim();
  if (envKey) {
    if (/^[A-Fa-f0-9]{64}$/.test(envKey)) return Buffer.from(envKey, "hex");
    const b64 = Buffer.from(envKey, "base64");
    if (b64.length === 32) return b64;
    if (Buffer.byteLength(envKey, "utf8") === 32) return Buffer.from(envKey, "utf8");
  }
  const keyPath = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE?.trim()
    || path.resolve(process.cwd(), "data/secrets/master.key");
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, "utf8").trim();
    if (/^[A-Fa-f0-9]{64}$/.test(raw)) return Buffer.from(raw, "hex");
    const b64 = Buffer.from(raw, "base64");
    if (b64.length === 32) return b64;
  }
  return null;
}

function encrypt(value: string): EncryptedToken {
  const key = loadMasterKey();
  if (!key) throw new Error("No master key configured — set PAPERCLIP_SECRETS_MASTER_KEY or PAPERCLIP_SECRETS_MASTER_KEY_FILE");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { scheme: "aes256gcm_v1", iv: iv.toString("base64"), tag: tag.toString("base64"), ciphertext: ciphertext.toString("base64") };
}

function decrypt(material: EncryptedToken): string {
  const key = loadMasterKey();
  if (!key) throw new Error("No master key configured");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(material.iv, "base64"));
  decipher.setAuthTag(Buffer.from(material.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(material.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

function isEncryptedToken(v: unknown): v is EncryptedToken {
  return !!v && typeof v === "object" && (v as Record<string, unknown>).scheme === "aes256gcm_v1";
}

export async function readInstanceToken(db: Db, key: string): Promise<string | null> {
  const [row] = await db.select({ general: instanceSettings.general }).from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")).limit(1);
  const stored = (row?.general as Record<string, unknown> | null)?.[key];
  if (!stored) return null;
  if (typeof stored === "string") return stored; // plaintext fallback (env-sourced)
  if (isEncryptedToken(stored)) return decrypt(stored);
  return null;
}

export async function writeInstanceToken(db: Db, key: string, value: string): Promise<void> {
  const encrypted = encrypt(value);
  await db
    .insert(instanceSettings)
    .values({ singletonKey: "default", general: { [key]: encrypted } })
    .onConflictDoUpdate({
      target: instanceSettings.singletonKey,
      set: {
        general: sql`instance_settings.general || jsonb_build_object(${key}::text, ${JSON.stringify(encrypted)}::jsonb)`,
        updatedAt: new Date(),
      },
    });
}

export async function deleteInstanceToken(db: Db, key: string): Promise<void> {
  await db
    .insert(instanceSettings)
    .values({ singletonKey: "default", general: {} })
    .onConflictDoUpdate({
      target: instanceSettings.singletonKey,
      set: {
        general: sql`instance_settings.general - ${key}::text`,
        updatedAt: new Date(),
      },
    });
}
