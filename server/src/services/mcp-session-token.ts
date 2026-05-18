// server/src/services/mcp-session-token.ts
import { createHmac, timingSafeEqual } from "node:crypto";

interface McpTokenPayload {
  companyId: string;
  agentId: string | null;
  isOperator?: boolean; // cross-company operator access (founder/EA)
  exp: number; // unix seconds
}

function secret(): string {
  return (
    process.env.BETTER_AUTH_SECRET?.trim() ||
    process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() ||
    "paperclip-mcp-dev-secret"
  );
}

function base64url(data: string): string {
  return Buffer.from(data).toString("base64url");
}

function fromBase64url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

export function signMcpToken(payload: Omit<McpTokenPayload, "exp">, ttlSeconds = 600): string {
  const full: McpTokenPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(full));
  const sig = createHmac("sha256", secret()).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifyMcpToken(token: string): McpTokenPayload | null {
  try {
    const [header, body, sig] = token.split(".");
    if (!header || !body || !sig) return null;
    const expected = createHmac("sha256", secret()).update(`${header}.${body}`).digest("base64url");
    const a = Buffer.from(sig, "base64url");
    const b = Buffer.from(expected, "base64url");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(fromBase64url(body)) as McpTokenPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
