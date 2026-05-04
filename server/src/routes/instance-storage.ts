import fs from "node:fs/promises";
import path from "node:path";
import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import {
  getAuthUrl,
  exchangeCodeForTokens,
  getGDriveStatus,
  disconnectGDrive,
  saveGoogleAppCreds,
  deleteGoogleAppCreds,
  getGoogleAppCredsStatus,
  getAuthenticatedDriveClient,
} from "../services/gdrive-auth.js";
import { SUPPORTED_EXTENSIONS } from "../services/document-extractor.js";
import { getCompanyStorageRoot, setCompanyStorageRoot, listCompaniesWithStorage } from "../services/client-storage.js";

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

  // Google OAuth app credentials (client ID + secret stored in DB)
  router.get("/instance/storage/gdrive/app-credentials", async (req, res) => {
    assertAdmin(req);
    res.json(await getGoogleAppCredsStatus(db));
  });

  router.put("/instance/storage/gdrive/app-credentials", async (req, res) => {
    assertAdmin(req);
    const { clientId, clientSecret } = req.body as { clientId?: string; clientSecret?: string };
    if (!clientId?.trim() || !clientSecret?.trim()) {
      res.status(400).json({ error: "clientId and clientSecret are required" });
      return;
    }
    await saveGoogleAppCreds(db, clientId.trim(), clientSecret.trim());
    res.json({ ok: true });
  });

  router.delete("/instance/storage/gdrive/app-credentials", async (req, res) => {
    assertAdmin(req);
    await deleteGoogleAppCreds(db);
    res.json({ ok: true });
  });

  // List folders inside a Drive folder (parentId defaults to "root")
  router.get("/instance/storage/gdrive/folders", async (req, res) => {
    assertAdmin(req);
    const parentId = (req.query.parentId as string | undefined) || "root";
    const drive = await getAuthenticatedDriveClient(db);
    if (!drive) {
      res.status(400).json({ error: "Google Drive not connected" });
      return;
    }
    const result = await drive.files.list({
      q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
      orderBy: "name",
      pageSize: 200,
    });
    res.json({ folders: result.data.files ?? [], parentId });
  });

  router.get("/instance/storage/gdrive/status", async (req, res) => {
    assertAdmin(req);
    res.json(await getGDriveStatus(db));
  });

  router.get("/instance/storage/gdrive/auth", async (req, res) => {
    assertAdmin(req);
    const redirectUri = `${req.protocol}://${req.get("host")}/api/instance/storage/gdrive/callback`;
    res.json({ url: await getAuthUrl(db, redirectUri) });
  });

  router.get("/instance/storage/gdrive/callback", async (req, res) => {
    const code = req.query.code as string | undefined;
    if (!code) { res.status(400).send("Missing code"); return; }
    const redirectUri = `${req.protocol}://${req.get("host")}/api/instance/storage/gdrive/callback`;
    try {
      await exchangeCodeForTokens(db, code, redirectUri);
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Google Drive Connected</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #141414; border: 1px solid #2a2a2a; border-radius: 12px; padding: 2rem; max-width: 360px; width: 100%; text-align: center; }
    .icon { font-size: 2.5rem; margin-bottom: 1rem; }
    h1 { font-size: 1.125rem; font-weight: 600; margin-bottom: 0.5rem; }
    p { font-size: 0.875rem; color: #888; margin-bottom: 1.5rem; }
    .btn { display: inline-block; background: #fff; color: #0a0a0a; font-size: 0.875rem; font-weight: 500; padding: 0.5rem 1.25rem; border-radius: 6px; text-decoration: none; cursor: pointer; border: none; }
    .btn:hover { background: #e5e5e5; }
    .close { display: inline-block; margin-left: 0.75rem; font-size: 0.875rem; color: #666; cursor: pointer; background: none; border: none; }
    .close:hover { color: #aaa; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">✓</div>
    <h1>Google Drive connected</h1>
    <p>Your account has been linked. You can close this window or return to Paperclip.</p>
    <a class="btn" href="javascript:void(0)" onclick="window.close()">Close window</a>
    <button class="close" onclick="window.opener && window.opener.location.reload(); window.close()">Back to Paperclip</button>
  </div>
  <script>
    if (window.opener) {
      try { window.opener.postMessage('gdrive-connected', '*'); } catch(e) {}
    }
  </script>
</body>
</html>`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[gdrive-callback] token exchange failed:", msg);
      res.status(500).send(`Failed to authenticate: ${msg}`);
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

  // Per-company storage root
  router.get("/companies/:companyId/storage/root", async (req, res) => {
    assertAdmin(req);
    res.json(await getCompanyStorageRoot(db, req.params.companyId));
  });

  router.put("/companies/:companyId/storage/root", async (req, res) => {
    assertAdmin(req);
    const { localPath, driveFolderId, copyFromCompanyId } = req.body as {
      localPath?: string | null;
      driveFolderId?: string | null;
      copyFromCompanyId?: string;
    };
    if (copyFromCompanyId) {
      const source = await getCompanyStorageRoot(db, copyFromCompanyId);
      await setCompanyStorageRoot(db, req.params.companyId, source);
      res.json({ ok: true, copied: source });
      return;
    }
    await setCompanyStorageRoot(db, req.params.companyId, {
      localPath: localPath?.trim() || null,
      driveFolderId: driveFolderId?.trim() || null,
    });
    res.json({ ok: true });
  });

  // List companies with storage configured (for "copy from" picker)
  router.get("/instance/storage/companies-with-storage", async (req, res) => {
    assertAdmin(req);
    res.json(await listCompaniesWithStorage(db));
  });

  return router;
}
