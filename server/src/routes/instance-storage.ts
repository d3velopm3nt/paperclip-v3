import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { getAuthUrl, exchangeCodeForTokens, getGDriveStatus, disconnectGDrive } from "../services/gdrive-auth.js";

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

  return router;
}
