// v3: telegram webhook receiver
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { unauthorized } from "../errors.js";
import { telegramService } from "../services/telegram.js";

export function telegramWebhookRoutes(db: Db) {
  const router = Router();
  const svc = telegramService(db);

  // POST /webhook/telegram/:botId
  router.post("/telegram/:botId", async (req, res) => {
    const { botId } = req.params;

    const bot = await svc.getBot(botId);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }

    if (bot.deliveryMode !== "webhook") {
      res.status(400).json({ error: "Bot not configured for webhook delivery" });
      return;
    }

    // Verify webhook secret if configured
    if (bot.webhookSecret) {
      const providedSecret = req.headers["x-telegram-bot-api-secret-token"];
      if (providedSecret !== bot.webhookSecret) {
        throw unauthorized();
      }
    }

    // Process update (TODO: route to handlers)
    const update = req.body;
    console.log(`Received webhook update ${update.update_id} for bot ${bot.botUsername}`);

    res.status(200).json({ ok: true });
  });

  return router;
}
