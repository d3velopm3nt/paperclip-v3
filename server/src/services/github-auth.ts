import type { Db } from "@paperclipai/db";
import { instanceSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

const SINGLETON_KEY = "default";
const GITHUB_APP_KEY = "githubOAuthApp";
const GITHUB_TOKEN_KEY = "githubOAuth";

interface GitHubAppCreds {
  clientId: string;
  clientSecret: string;
}

interface GitHubTokens {
  accessToken: string;
  login: string;
  scope: string;
}

async function getSettings(db: Db) {
  const rows = await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, SINGLETON_KEY)).limit(1);
  return rows[0] ?? null;
}

async function upsertGeneral(db: Db, patch: Record<string, unknown>): Promise<void> {
  const existing = await getSettings(db);
  const general = { ...((existing?.general ?? {}) as Record<string, unknown>), ...patch };
  if (existing) {
    await db.update(instanceSettings).set({ general, updatedAt: new Date() }).where(eq(instanceSettings.singletonKey, SINGLETON_KEY));
  } else {
    await db.insert(instanceSettings).values({ singletonKey: SINGLETON_KEY, general, experimental: {} });
  }
}

async function getGitHubAppCreds(db: Db): Promise<{ clientId: string; clientSecret: string }> {
  const row = await getSettings(db);
  const stored = (row?.general as Record<string, unknown>)?.[GITHUB_APP_KEY] as GitHubAppCreds | undefined;
  return {
    clientId: stored?.clientId || process.env.GITHUB_CLIENT_ID || "",
    clientSecret: stored?.clientSecret || process.env.GITHUB_CLIENT_SECRET || "",
  };
}

export async function saveGitHubAppCreds(db: Db, clientId: string, clientSecret: string): Promise<void> {
  await upsertGeneral(db, { [GITHUB_APP_KEY]: { clientId, clientSecret } });
  logger.info("github-auth: app credentials saved");
}

export async function deleteGitHubAppCreds(db: Db): Promise<void> {
  const row = await getSettings(db);
  if (!row) return;
  const general = { ...(row.general as Record<string, unknown>) };
  delete general[GITHUB_APP_KEY];
  await db.update(instanceSettings).set({ general, updatedAt: new Date() }).where(eq(instanceSettings.singletonKey, SINGLETON_KEY));
}

export async function getGitHubAppCredsStatus(db: Db): Promise<{ configured: boolean; clientId: string | null; fromEnv: boolean }> {
  const row = await getSettings(db);
  const stored = (row?.general as Record<string, unknown>)?.[GITHUB_APP_KEY] as GitHubAppCreds | undefined;
  if (stored?.clientId && stored?.clientSecret) {
    return { configured: true, clientId: stored.clientId, fromEnv: false };
  }
  const envId = process.env.GITHUB_CLIENT_ID;
  const envSecret = process.env.GITHUB_CLIENT_SECRET;
  if (envId && envSecret) {
    return { configured: true, clientId: envId, fromEnv: true };
  }
  return { configured: false, clientId: null, fromEnv: false };
}

export async function getGitHubAuthUrl(db: Db, redirectUri: string): Promise<string> {
  const { clientId } = await getGitHubAppCreds(db);
  if (!clientId) throw new Error("GitHub OAuth app not configured");
  const state = Math.random().toString(36).slice(2);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "repo read:org",
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export async function exchangeCodeForToken(db: Db, code: string, redirectUri: string): Promise<void> {
  const { clientId, clientSecret } = await getGitHubAppCreds(db);
  if (!clientId || !clientSecret) throw new Error("GitHub OAuth app not configured");

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  const tokenData = await tokenRes.json() as { access_token?: string; scope?: string; error?: string; error_description?: string };
  if (tokenData.error || !tokenData.access_token) {
    throw new Error(tokenData.error_description ?? tokenData.error ?? "Failed to exchange code");
  }

  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/vnd.github+json" },
  });
  const userData = await userRes.json() as { login?: string };
  const login = userData.login ?? "";

  await upsertGeneral(db, {
    [GITHUB_TOKEN_KEY]: { accessToken: tokenData.access_token, login, scope: tokenData.scope ?? "" },
  });
  logger.info({ login }, "github-auth: token stored");
}

export async function getGitHubStatus(db: Db): Promise<{ connected: boolean; login: string | null; scope: string | null }> {
  const row = await getSettings(db);
  const tokens = (row?.general as Record<string, unknown>)?.[GITHUB_TOKEN_KEY] as GitHubTokens | undefined;
  return { connected: !!tokens?.accessToken, login: tokens?.login ?? null, scope: tokens?.scope ?? null };
}

export async function disconnectGitHub(db: Db): Promise<void> {
  const row = await getSettings(db);
  if (!row) return;
  const general = { ...(row.general as Record<string, unknown>) };
  delete general[GITHUB_TOKEN_KEY];
  await db.update(instanceSettings).set({ general, updatedAt: new Date() }).where(eq(instanceSettings.singletonKey, SINGLETON_KEY));
}

export async function savePAT(db: Db, token: string): Promise<void> {
  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!userRes.ok) throw new Error(`GitHub rejected token: ${userRes.status}`);
  const userData = await userRes.json() as { login?: string };
  const login = userData.login ?? "";
  await upsertGeneral(db, {
    [GITHUB_TOKEN_KEY]: { accessToken: token, login, scope: "pat" },
  });
  logger.info({ login }, "github-auth: PAT stored");
}

/** Returns the stored access token, or null if not connected. */
export async function getStoredGitHubToken(db: Db): Promise<string | null> {
  const row = await getSettings(db);
  const tokens = (row?.general as Record<string, unknown>)?.[GITHUB_TOKEN_KEY] as GitHubTokens | undefined;
  return tokens?.accessToken ?? null;
}

/** Injects the stored GitHub token into a repo URL for authenticated cloning. */
export async function buildAuthenticatedCloneUrl(db: Db, repoUrl: string, overrideToken?: string | null): Promise<string> {
  const token = overrideToken ?? await getStoredGitHubToken(db);
  if (!token) return repoUrl;
  try {
    const u = new URL(repoUrl);
    if (u.hostname !== "github.com") return repoUrl;
    u.username = token;
    u.password = "x-oauth-basic";
    return u.toString();
  } catch {
    return repoUrl;
  }
}
