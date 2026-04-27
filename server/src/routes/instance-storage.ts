import fs from "node:fs/promises";
import path from "node:path";
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { getAuthUrl, exchangeCodeForTokens, getGDriveStatus, disconnectGDrive } from "../services/gdrive-auth.js";
import { SUPPORTED_EXTENSIONS } from "../services/document-extractor.js";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  ".cache", ".parcel-cache", "coverage", "vendor", "__pycache__", ".venv",
]);

async function countSupportedFiles(dir: string, depth = 0): Promise<number> {
  if (depth > 6) return 0;
  let count = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        count += await countSupportedFiles(path.join(dir, entry.name), depth + 1);
      } else if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        count++;
      }
    }
  } catch {
    // ignore
  }
  return count;
}

function assertAdmin(req: Request) {
  if (req.actor.type !== "board") throw forbidden("Board access required");
}

export function instanceStorageRoutes(db: Db): Router {
  const router = Router();

  router.get("/instance/storage/gdrive/status", async (req, res) => {
    assertAdmin(req);
    res.json(await getGDriveStatus(db));
  });

  router.get("/instance/storage/gdrive/auth", async (req, res) => {
    assertAdmin(req);
    const redirectUri = `${req.protocol}://${req.get("host")}/api/instance/storage/gdrive/callback`;
    res.json({ url: getAuthUrl(redirectUri) });
  });

  router.get("/instance/storage/gdrive/callback", async (req, res) => {
    const code = req.query.code as string | undefined;
    if (!code) { res.status(400).send("Missing code"); return; }
    const redirectUri = `${req.protocol}://${req.get("host")}/api/instance/storage/gdrive/callback`;
    try {
      await exchangeCodeForTokens(db, code, redirectUri);
      res.send("<html><body><script>window.close();</script><p>Connected! You can close this window.</p></body></html>");
    } catch (err) {
      res.status(500).send("Failed to authenticate. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
    }
  });

  router.delete("/instance/storage/gdrive/auth", async (req, res) => {
    assertAdmin(req);
    await disconnectGDrive(db);
    res.json({ ok: true });
  });

  // Test a local folder path — check accessibility and count supported files
  router.post("/instance/storage/local/test", async (req, res) => {
    assertAdmin(req);
    const { localPath } = req.body as { localPath?: string };
    if (!localPath?.trim()) { res.status(400).json({ error: "localPath required" }); return; }
    const p = localPath.trim();
    try {
      const stat = await fs.stat(p);
      if (!stat.isDirectory()) {
        res.json({ ok: false, error: "Path exists but is not a directory" });
        return;
      }
      const fileCount = await countSupportedFiles(p);
      res.json({
        ok: true,
        fileCount,
        message: fileCount === 0
          ? `Directory accessible but no supported files found (.md, .txt, .pdf, .docx)`
          : `Found ${fileCount} supported file${fileCount === 1 ? "" : "s"}`,
      });
    } catch {
      res.json({ ok: false, error: `Cannot access path: ${p}` });
    }
  });

  return router;
}
