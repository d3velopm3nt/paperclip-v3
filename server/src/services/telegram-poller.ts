import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { telegramBots } from "@paperclipai/db";
import { telegramService } from "./telegram.js";

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string; username?: string };
    chat: { id: number; type: string };
    date: number;
    text?: string;
  };
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result: TelegramUpdate[];
}

export async function pollTelegramUpdates(db: Db) {
  const svc = telegramService(db);

  // Fetch active longpoll bots
  const bots = await db
    .select()
    .from(telegramBots)
    .where(and(eq(telegramBots.active, true), eq(telegramBots.deliveryMode, "longpoll")));

  for (const bot of bots) {
    try {
      const token = svc.decryptBotToken(bot.botTokenEnc);
      const offset = (bot.lastOffset ?? 0) + 1;

      const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offset, timeout: 30 }),
      });

      const data = (await response.json()) as TelegramGetUpdatesResponse;

      if (!data.ok) {
        throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
      }

      let newOffset = bot.lastOffset ?? 0;

      for (const update of data.result) {
        // Process update (TODO: route to handlers)
        if (update.update_id > newOffset) {
          newOffset = update.update_id;
        }
      }

      // Update bot state
      await db
        .update(telegramBots)
        .set({
          lastPolledAt: new Date(),
          lastOffset: newOffset,
          lastErrorText: null,
          updatedAt: new Date(),
        })
        .where(eq(telegramBots.id, bot.id));
    } catch (error) {
      // Log error but continue polling other bots
      await db
        .update(telegramBots)
        .set({
          lastErrorText: error instanceof Error ? error.message : String(error),
          updatedAt: new Date(),
        })
        .where(eq(telegramBots.id, bot.id));
    }
  }
}
