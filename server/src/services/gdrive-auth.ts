import { google } from "googleapis";
import type { Db } from "@paperclipai/db";
import { instanceSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

const SINGLETON_KEY = "default";
const GDRIVE_SETTINGS_KEY = "gdriveOAuth";
const GOOGLE_APP_KEY = "googleOAuthApp";

interface GDriveTokens {
  accessToken: string;
  refreshToken: string;
  email: string;
  expiresAt: number;
}

interface GoogleAppCreds {
  clientId: string;
  clientSecret: string;
}

async function getSettings(db: Db) {
  const rows = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .limit(1);
  return rows[0] ?? null;
}

async function upsertGeneral(db: Db, patch: Record<string, unknown>): Promise<void> {
  const existing = await getSettings(db);
  const general = { ...((existing?.general ?? {}) as Record<string, unknown>), ...patch };
  if (existing) {
    await db
      .update(instanceSettings)
      .set({ general, updatedAt: new Date() })
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY));
  } else {
    await db.insert(instanceSettings).values({
      singletonKey: SINGLETON_KEY,
      general,
      experimental: {},
    });
  }
}

async function getGoogleAppCreds(db: Db): Promise<{ clientId: string; clientSecret: string }> {
  const row = await getSettings(db);
  const stored = (row?.general as Record<string, unknown>)?.[GOOGLE_APP_KEY] as GoogleAppCreds | undefined;
  return {
    clientId: stored?.clientId || process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: stored?.clientSecret || process.env.GOOGLE_CLIENT_SECRET || "",
  };
}

async function getOAuthClient(db: Db, redirectUri: string) {
  const { clientId, clientSecret } = await getGoogleAppCreds(db);
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export async function saveGoogleAppCreds(db: Db, clientId: string, clientSecret: string): Promise<void> {
  await upsertGeneral(db, { [GOOGLE_APP_KEY]: { clientId, clientSecret } });
  logger.info("gdrive-auth: app credentials saved to DB");
}

export async function deleteGoogleAppCreds(db: Db): Promise<void> {
  const row = await getSettings(db);
  if (!row) return;
  const general = { ...(row.general as Record<string, unknown>) };
  delete general[GOOGLE_APP_KEY];
  await db
    .update(instanceSettings)
    .set({ general, updatedAt: new Date() })
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY));
}

export async function getGoogleAppCredsStatus(db: Db): Promise<{ configured: boolean; clientId: string | null; fromEnv: boolean }> {
  const row = await getSettings(db);
  const stored = (row?.general as Record<string, unknown>)?.[GOOGLE_APP_KEY] as GoogleAppCreds | undefined;
  if (stored?.clientId && stored?.clientSecret) {
    return { configured: true, clientId: stored.clientId, fromEnv: false };
  }
  const envId = process.env.GOOGLE_CLIENT_ID;
  const envSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (envId && envSecret) {
    return { configured: true, clientId: envId, fromEnv: true };
  }
  return { configured: false, clientId: null, fromEnv: false };
}

export async function getAuthUrl(db: Db, redirectUri: string): Promise<string> {
  const oauth2 = await getOAuthClient(db, redirectUri);
  return oauth2.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/drive", // full access — needed for folder/file creation
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    prompt: "consent",
  });
}

export async function exchangeCodeForTokens(
  db: Db,
  code: string,
  redirectUri: string,
): Promise<void> {
  const oauth2 = await getOAuthClient(db, redirectUri);
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  const oauth2Api = google.oauth2({ version: "v2", auth: oauth2 });
  const userInfo = await oauth2Api.userinfo.get();
  const email = userInfo.data.email ?? "";

  await upsertGeneral(db, {
    [GDRIVE_SETTINGS_KEY]: {
      accessToken: tokens.access_token ?? "",
      refreshToken: tokens.refresh_token ?? "",
      email,
      expiresAt: tokens.expiry_date ?? 0,
    },
  });
  logger.info({ email }, "gdrive-auth: tokens stored");
}

export async function getAuthenticatedDriveClient(db: Db) {
  const row = await getSettings(db);
  const tokens = (row?.general as Record<string, unknown>)?.[GDRIVE_SETTINGS_KEY] as GDriveTokens | undefined;
  if (!tokens?.refreshToken) return null;

  const oauth2 = await getOAuthClient(db, "");
  oauth2.setCredentials({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expiry_date: tokens.expiresAt,
  });
  const drive = google.drive({ version: "v3", auth: oauth2 });

  // Safety guard: Paperclip must never delete Drive files or folders.
  // Wrap the client to throw if delete/trash is attempted anywhere in the codebase.
  const safeFiles = new Proxy(drive.files, {
    get(target, prop) {
      if (prop === "delete" || prop === "trash") {
        return () => { throw new Error(`paperclip: Drive ${String(prop)} is disabled — files are never deleted by Paperclip`); };
      }
      return (target as unknown as Record<string | symbol, unknown>)[prop];
    },
  });
  return { ...drive, files: safeFiles } as typeof drive;
}

export async function getGDriveStatus(db: Db): Promise<{ connected: boolean; email: string | null }> {
  const row = await getSettings(db);
  const tokens = (row?.general as Record<string, unknown>)?.[GDRIVE_SETTINGS_KEY] as GDriveTokens | undefined;
  return { connected: !!tokens?.refreshToken, email: tokens?.email ?? null };
}

export async function disconnectGDrive(db: Db): Promise<void> {
  const row = await getSettings(db);
  if (!row) return;
  const general = { ...(row.general as Record<string, unknown>) };
  delete general[GDRIVE_SETTINGS_KEY];
  await db
    .update(instanceSettings)
    .set({ general, updatedAt: new Date() })
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY));
}

/**
 * Creates a folder in Google Drive and returns its ID.
 * parentId defaults to "root" (My Drive root).
 */
export async function createDriveFolder(
  db: Db,
  name: string,
  parentId = "root",
): Promise<string> {
  const drive = await getAuthenticatedDriveClient(db);
  if (!drive) throw new Error("Google Drive not authenticated");
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  const id = res.data.id;
  if (!id) throw new Error("Drive folder creation returned no ID");
  return id;
}

/** Returns the web URL for a Drive folder by ID. */
export function driveFolderWebUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}
