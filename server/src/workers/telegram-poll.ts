// v3: Telegram long-poll worker — spawns a poller per active longpoll bot.
// Reconciles active set every reconcileIntervalMs so newly-added or
// deactivated bots pick up/drop out without restart.

import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { telegramBots } from "@paperclipai/db";
import { pollTelegramUpdates } from "../services/telegram-poller.js";
import { logger } from "../middleware/logger.js";

export interface TelegramPollWorkerOptions {
  db: Db;
  reconcileIntervalMs?: number;
}

export interface TelegramPollWorker {
  stop: () => void;
  reconcileNow: () => Promise<void>;
}

export function startTelegramPollWorker(opts: TelegramPollWorkerOptions): TelegramPollWorker {
  const { db } = opts;
  const reconcileIntervalMs = opts.reconcileIntervalMs ?? 60_000;
  const pollers = new Map<string, { stop: () => void; poll: () => void }>();
  let stopped = false;
  let reconcileTimer: NodeJS.Timeout | null = null;

  async function reconcile() {
    if (stopped) return;
    try {
      // Poll all active longpoll bots
      const rows = await db
        .select({ id: telegramBots.id })
        .from(telegramBots)
        .where(and(eq(telegramBots.active, true), eq(telegramBots.deliveryMode, "longpoll")));

      const activeIds = new Set(rows.map((r) => r.id));

      // Stop pollers for bots that went away or became inactive
      for (const [id, handle] of pollers) {
        if (!activeIds.has(id)) {
          handle.stop();
          pollers.delete(id);
          logger.info({ botId: id }, "telegram-poll: stopped poller");
        }
      }

      // Start pollers for newly-active bots
      for (const id of activeIds) {
        if (!pollers.has(id)) {
          let polling = false;
          let active = true;

          const poll = async () => {
            if (!active || stopped || polling) return;
            polling = true;
            try {
              await pollTelegramUpdates(db);
            } catch (err) {
              logger.warn({ err, botId: id }, "telegram-poll: poll error");
            } finally {
              polling = false;
              if (active && !stopped) {
                setTimeout(poll, 5_000); // Poll every 5s
              }
            }
          };

          const handle = {
            stop: () => {
              active = false;
            },
            poll,
          };

          pollers.set(id, handle);
          poll(); // Start first poll immediately
          logger.info({ botId: id }, "telegram-poll: started poller");
        }
      }
    } catch (err) {
      logger.warn({ err }, "telegram-poll: reconcile failed");
    } finally {
      if (!stopped) reconcileTimer = setTimeout(reconcile, reconcileIntervalMs);
    }
  }

  reconcile();

  return {
    stop() {
      stopped = true;
      if (reconcileTimer) clearTimeout(reconcileTimer);
      for (const handle of pollers.values()) handle.stop();
      pollers.clear();
    },
    reconcileNow: reconcile,
  };
}
