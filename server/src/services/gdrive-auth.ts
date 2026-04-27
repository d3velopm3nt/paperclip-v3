import { google } from "googleapis";
import type { Db } from "@paperclipai/db";
import { instanceSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

const SINGLETON_KEY = "default";
const GDRIVE_SETTINGS_KEY = "gdriveOAuth";

interface GDriveTokens {
  accessToken: string;
  refreshToken: string;
  email: string;
  expiresAt: number;
}

function getOAuthClient(redirectUri: string) {
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function getSettings(db: Db) {
  const rows = await db
    .select()
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .limit(1);
  return rows[0] ?? null;
}

async function setGDriveTokens(db: Db, tokens: GDriveTokens): Promise<void> {
  const existing = await getSettings(db);
  const general = ((existing?.general ?? {}) as Record<string, unknown>);
  const updated = { ...general, [GDRIVE_SETTINGS_KEY]: tokens };
  if (existing) {
    await db
      .update(instanceSettings)
      .set({ general: updated, updatedAt: new Date() })
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY));
  } else {
    await db.insert(instanceSettings).values({
      singletonKey: SINGLETON_KEY,
      general: updated,
      experimental: {},
    });
  }
}

export function getAuthUrl(redirectUri: string): string {
  const oauth2 = getOAuthClient(redirectUri);
  return oauth2.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/drive.readonly",
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
  const oauth2 = getOAuthClient(redirectUri);
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  const oauth2Api = google.oauth2({ version: "v2", auth: oauth2 });
  const userInfo = await oauth2Api.userinfo.get();
  const email = userInfo.data.email ?? "";

  await setGDriveTokens(db, {
    accessToken: tokens.access_token ?? "",
    refreshToken: tokens.refresh_token ?? "",
    email,
    expiresAt: tokens.expiry_date ?? 0,
  });
  logger.info({ email }, "gdrive-auth: tokens stored");
}

export async function getAuthenticatedDriveClient(db: Db) {
  const row = await getSettings(db);
  const tokens = (row?.general as Record<string, unknown>)?.[GDRIVE_SETTINGS_KEY] as GDriveTokens | undefined;
  if (!tokens?.refreshToken) return null;

  const oauth2 = getOAuthClient("");
  oauth2.setCredentials({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expiry_date: tokens.expiresAt,
  });
  return google.drive({ version: "v3", auth: oauth2 });
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
