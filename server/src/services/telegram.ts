import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { telegramBots } from "@paperclipai/db";
import { encryptPassword, decryptPassword } from "./email-accounts.js";

export interface CreateBotInput {
  companyId: string | null;
  botToken: string;
  botUsername: string;
  deliveryMode?: "longpoll" | "webhook";
  webhookSecret?: string;
  publicBaseUrl?: string;
}

export function telegramService(db: Db) {
  async function createBot(input: CreateBotInput) {
    const botTokenEnc = encryptPassword(input.botToken);

    const [bot] = await db
      .insert(telegramBots)
      .values({
        companyId: input.companyId,
        botTokenEnc,
        botUsername: input.botUsername,
        deliveryMode: input.deliveryMode ?? "longpoll",
        webhookSecret: input.webhookSecret ?? null,
        publicBaseUrl: input.publicBaseUrl ?? null,
      })
      .returning();

    return bot!;
  }

  async function listBots(companyId: string) {
    return db.select().from(telegramBots).where(eq(telegramBots.companyId, companyId));
  }

  async function deactivateBot(botId: string) {
    await db.update(telegramBots).set({ active: false, updatedAt: new Date() }).where(eq(telegramBots.id, botId));
  }

  async function getBot(botId: string) {
    const [bot] = await db.select().from(telegramBots).where(eq(telegramBots.id, botId)).limit(1);
    return bot ?? null;
  }

  function decryptBotToken(botTokenEnc: string): string {
    return decryptPassword(botTokenEnc);
  }

  return {
    createBot,
    listBots,
    deactivateBot,
    getBot,
    decryptBotToken,
  };
}
