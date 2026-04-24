// v3: email account service — CRUD + IMAP test-connection
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { emailAccounts } from "@paperclipai/db";
import { badRequest } from "../errors.js";

// ---------------------------------------------------------------------------
// Encryption helpers (AES-256-GCM, same scheme as local-encrypted-provider)
// ---------------------------------------------------------------------------

interface EncryptedMaterial {
  scheme: "local_encrypted_v1";
  iv: string;
  tag: string;
  ciphertext: string;
}

function decodeMasterKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // ignored
  }
  if (Buffer.byteLength(trimmed, "utf8") === 32) {
    return Buffer.from(trimmed, "utf8");
  }
  return null;
}

function loadOrCreateMasterKey(): Buffer {
  const envKeyRaw = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
  if (envKeyRaw && envKeyRaw.trim().length > 0) {
    const fromEnv = decodeMasterKey(envKeyRaw);
    if (!fromEnv) {
      throw badRequest(
        "Invalid PAPERCLIP_SECRETS_MASTER_KEY (expected 32-byte base64, 64-char hex, or raw 32-char string)",
      );
    }
    return fromEnv;
  }

  const fromEnvFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const keyPath = fromEnvFile && fromEnvFile.trim().length > 0
    ? path.resolve(fromEnvFile.trim())
    : path.resolve(process.cwd(), "data/secrets/master.key");

  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, "utf8");
    const decoded = decodeMasterKey(raw);
    if (!decoded) {
      throw badRequest(`Invalid secrets master key at ${keyPath}`);
    }
    return decoded;
  }

  const dir = path.dirname(keyPath);
  mkdirSync(dir, { recursive: true });
  const generated = randomBytes(32);
  writeFileSync(keyPath, generated.toString("base64"), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    // best effort
  }
  return generated;
}

export function encryptPassword(plain: string): string {
  const masterKey = loadOrCreateMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const material: EncryptedMaterial = {
    scheme: "local_encrypted_v1",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return JSON.stringify(material);
}

export function decryptPassword(enc: string): string {
  const masterKey = loadOrCreateMasterKey();
  let material: EncryptedMaterial;
  try {
    material = JSON.parse(enc) as EncryptedMaterial;
  } catch {
    throw badRequest("Stored IMAP password is corrupted (invalid JSON)");
  }
  if (material.scheme !== "local_encrypted_v1") {
    throw badRequest("Unsupported encryption scheme for IMAP password");
  }
  const iv = Buffer.from(material.iv, "base64");
  const tag = Buffer.from(material.tag, "base64");
  const ciphertext = Buffer.from(material.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

// ---------------------------------------------------------------------------
// IMAP test-connection
// ---------------------------------------------------------------------------

export interface TestConnectionResult {
  ok: boolean;
  error?: string;
}

async function testImapConnection(opts: {
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
}): Promise<TestConnectionResult> {
  return new Promise((resolve) => {
    // Dynamic import so unit tests can mock the module
    import("imap").then(({ default: Imap }) => {
      let settled = false;
      function done(result: TestConnectionResult) {
        if (settled) return;
        settled = true;
        try { imap.end(); } catch { /* ignore */ }
        resolve(result);
      }

      const imap = new Imap({
        user: opts.user,
        password: opts.password,
        host: opts.host,
        port: opts.port,
        tls: opts.tls,
        tlsOptions: { rejectUnauthorized: false },
        connTimeout: 10_000,
        authTimeout: 10_000,
      });

      imap.once("ready", () => {
        imap.getBoxes((err, _boxes) => {
          if (err) {
            done({ ok: false, error: `LIST failed: ${err.message}` });
          } else {
            done({ ok: true });
          }
        });
      });

      imap.once("error", (err: Error) => {
        done({ ok: false, error: err.message });
      });

      imap.connect();

      // Hard timeout safety net
      setTimeout(() => done({ ok: false, error: "Connection timed out" }), 15_000);
    }).catch((err: Error) => {
      resolve({ ok: false, error: `imap module unavailable: ${err.message}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type EmailAccountRow = typeof emailAccounts.$inferSelect;
export type EmailAccountPublic = Omit<EmailAccountRow, "imapPasswordEnc" | "smtpPasswordEnc">;

function stripPassword(row: EmailAccountRow): EmailAccountPublic {
  const { imapPasswordEnc: _imap, smtpPasswordEnc: _smtp, ...rest } = row;
  return rest;
}

export interface CreateEmailAccountInput {
  label: string;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPassword: string;  // plaintext — will be encrypted before storage
  imapTls?: boolean;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUser?: string | null;
  smtpPassword?: string | null;  // plaintext; if null and smtpHost set, reuses imapPassword
  smtpSecure?: boolean;
  folder?: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string | null;
  pollIntervalSec?: number;
  active?: boolean;
}

export interface UpdateEmailAccountInput {
  label?: string;
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapPassword?: string;  // plaintext — if provided, re-encrypts
  imapTls?: boolean;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUser?: string | null;
  smtpPassword?: string | null;
  smtpSecure?: boolean;
  folder?: string;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string | null;
  pollIntervalSec?: number;
  active?: boolean;
}

export function emailAccountService(db: Db) {
  async function list(companyId: string): Promise<EmailAccountPublic[]> {
    const rows = await db
      .select()
      .from(emailAccounts)
      .where(eq(emailAccounts.companyId, companyId));
    return rows.map(stripPassword);
  }

  async function getById(id: string): Promise<EmailAccountRow | null> {
    const [row] = await db
      .select()
      .from(emailAccounts)
      .where(eq(emailAccounts.id, id))
      .limit(1);
    return row ?? null;
  }

  async function create(companyId: string, input: CreateEmailAccountInput): Promise<EmailAccountPublic> {
    const imapPasswordEnc = encryptPassword(input.imapPassword);
    const smtpPasswordEnc =
      input.smtpHost && input.smtpPassword
        ? encryptPassword(input.smtpPassword)
        : null;
    const [row] = await db
      .insert(emailAccounts)
      .values({
        companyId,
        label: input.label,
        imapHost: input.imapHost,
        imapPort: input.imapPort,
        imapUser: input.imapUser,
        imapPasswordEnc,
        imapTls: input.imapTls ?? true,
        smtpHost: input.smtpHost ?? null,
        smtpPort: input.smtpPort ?? null,
        smtpUser: input.smtpUser ?? null,
        smtpPasswordEnc,
        smtpSecure: input.smtpSecure ?? false,
        folder: input.folder ?? "INBOX",
        fromName: input.fromName,
        fromEmail: input.fromEmail,
        replyTo: input.replyTo ?? null,
        pollIntervalSec: input.pollIntervalSec ?? 60,
        active: input.active ?? true,
        updatedAt: new Date(),
      })
      .returning();
    return stripPassword(row!);
  }

  async function update(id: string, input: UpdateEmailAccountInput): Promise<EmailAccountPublic> {
    const updates: Partial<EmailAccountRow> & { updatedAt: Date } = {
      updatedAt: new Date(),
    };

    if (input.label !== undefined) updates.label = input.label;
    if (input.imapHost !== undefined) updates.imapHost = input.imapHost;
    if (input.imapPort !== undefined) updates.imapPort = input.imapPort;
    if (input.imapUser !== undefined) updates.imapUser = input.imapUser;
    if (input.imapPassword !== undefined) updates.imapPasswordEnc = encryptPassword(input.imapPassword);
    if (input.imapTls !== undefined) updates.imapTls = input.imapTls;
    if (input.smtpHost !== undefined) updates.smtpHost = input.smtpHost;
    if (input.smtpPort !== undefined) updates.smtpPort = input.smtpPort;
    if (input.smtpUser !== undefined) updates.smtpUser = input.smtpUser;
    if (input.smtpPassword !== undefined) {
      updates.smtpPasswordEnc = input.smtpPassword === null ? null : encryptPassword(input.smtpPassword);
    }
    if (input.smtpSecure !== undefined) updates.smtpSecure = input.smtpSecure;
    if (input.folder !== undefined) updates.folder = input.folder;
    if (input.fromName !== undefined) updates.fromName = input.fromName;
    if (input.fromEmail !== undefined) updates.fromEmail = input.fromEmail;
    if (input.replyTo !== undefined) updates.replyTo = input.replyTo;
    if (input.pollIntervalSec !== undefined) updates.pollIntervalSec = input.pollIntervalSec;
    if (input.active !== undefined) updates.active = input.active;

    const [row] = await db
      .update(emailAccounts)
      .set(updates)
      .where(eq(emailAccounts.id, id))
      .returning();
    return stripPassword(row!);
  }

  async function deleteAccount(id: string): Promise<void> {
    await db.delete(emailAccounts).where(eq(emailAccounts.id, id));
  }

  async function testConnection(account: EmailAccountRow): Promise<TestConnectionResult> {
    let password: string;
    try {
      password = decryptPassword(account.imapPasswordEnc);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to decrypt stored password",
      };
    }
    return testImapConnection({
      host: account.imapHost,
      port: account.imapPort,
      user: account.imapUser,
      password,
      tls: account.imapTls,
    });
  }

  async function testSmtpConnectionForAccount(account: EmailAccountRow): Promise<TestConnectionResult> {
    if (!account.smtpHost || !account.smtpPort) {
      return { ok: false, error: "SMTP not configured for this account" };
    }
    const user = account.smtpUser ?? account.imapUser;
    const enc = account.smtpPasswordEnc ?? account.imapPasswordEnc;
    let password: string;
    try {
      password = decryptPassword(enc);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to decrypt stored SMTP password",
      };
    }
    return testSmtpConnection({
      host: account.smtpHost,
      port: account.smtpPort,
      user,
      password,
      secure: account.smtpSecure,
    });
  }

  return {
    list,
    getById,
    create,
    update,
    delete: deleteAccount,
    testConnection,
    testSmtpConnectionForAccount,
  };
}

// ---------------------------------------------------------------------------
// SMTP test + ephemeral (unsaved) probes
// ---------------------------------------------------------------------------

export async function testSmtpConnection(opts: {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
}): Promise<TestConnectionResult> {
  try {
    const { default: nodemailer } = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: { user: opts.user, pass: opts.password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 10_000,
      tls: { rejectUnauthorized: false },
    });
    await transporter.verify();
    transporter.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "SMTP verify failed" };
  }
}

export async function testImapConnectionRaw(opts: {
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
}): Promise<TestConnectionResult> {
  return testImapConnection(opts);
}
