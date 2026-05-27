// v3: telegram bots CRUD API
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { telegramService } from "../services/telegram.js";

const REQUIRED_CREATE_FIELDS = ["botToken", "botUsername"] as const;

// Strip encrypted token from response - never expose even encrypted secrets
function stripToken<T extends object>(bot: T): Omit<T, "botTokenEnc"> {
  const { botTokenEnc: _enc, ...safe } = bot as T & { botTokenEnc?: unknown };
  return safe;
}

function validateCreateBody(body: Record<string, unknown>) {
  for (const field of REQUIRED_CREATE_FIELDS) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      throw badRequest(`Missing required field: ${field}`);
    }
  }
}

export function telegramBotRoutes(db: Db) {
  const router = Router();
  const svc = telegramService(db);

  // GET /api/companies/:companyId/telegram-bots
  router.get("/companies/:companyId/telegram-bots", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const bots = await svc.listBots(companyId);
    res.json(bots.map(stripToken));
  });

  // POST /api/companies/:companyId/telegram-bots
  router.post("/companies/:companyId/telegram-bots", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    validateCreateBody(req.body as Record<string, unknown>);
    const bot = await svc.createBot({
      companyId,
      botToken: req.body.botToken,
      botUsername: req.body.botUsername,
      deliveryMode: req.body.deliveryMode ?? "longpoll",
      webhookSecret: req.body.webhookSecret,
      publicBaseUrl: req.body.publicBaseUrl,
    });
    res.status(201).json(stripToken(bot));
  });

  // GET /api/telegram-bots/:id
  router.get("/telegram-bots/:id", async (req, res) => {
    const { id } = req.params;
    const bot = await svc.getBot(id);
    if (!bot) {
      res.status(404).json({ error: "Telegram bot not found" });
      return;
    }
    assertCompanyAccess(req, bot.companyId!);
    res.json(stripToken(bot));
  });

  // DELETE /api/telegram-bots/:id
  router.delete("/telegram-bots/:id", async (req, res) => {
    const { id } = req.params;
    const bot = await svc.getBot(id);
    if (!bot) {
      res.status(404).json({ error: "Telegram bot not found" });
      return;
    }
    assertCompanyAccess(req, bot.companyId!);
    await svc.deactivateBot(id);
    res.status(204).send();
  });

  return router;
}
