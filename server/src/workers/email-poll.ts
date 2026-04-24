// v3: IMAP polling worker — spawns a monitor per active email account.
// Reconciles the active set every reconcileIntervalMs so newly-added or
// deactivated accounts pick up/drop out without a restart.

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { emailAccounts } from "@paperclipai/db";
import { startMonitor } from "../services/email-monitor.js";
import { emailProcessorService } from "../services/email-processor.js";
import { logger } from "../middleware/logger.js";

export interface EmailPollWorkerOptions {
  db: Db;
  reconcileIntervalMs?: number;
}

export interface EmailPollWorker {
  stop: () => void;
  reconcileNow: () => Promise<void>;
}

export function startEmailPollWorker(opts: EmailPollWorkerOptions): EmailPollWorker {
  const { db } = opts;
  const reconcileIntervalMs = opts.reconcileIntervalMs ?? 60_000;
  const processor = emailProcessorService(db);
  const monitors = new Map<string, { stop: () => void }>();
  let stopped = false;
  let reconcileTimer: NodeJS.Timeout | null = null;

  async function reconcile() {
    if (stopped) return;
    try {
      const rows = await db
        .select({ id: emailAccounts.id, active: emailAccounts.active })
        .from(emailAccounts)
        .where(and(eq(emailAccounts.active, true), eq(emailAccounts.role, "inbound")));
      const activeIds = new Set(rows.map((r) => r.id));
      // Stop monitors for accounts that went away or became inactive
      for (const [id, handle] of monitors) {
        if (!activeIds.has(id)) {
          handle.stop();
          monitors.delete(id);
          logger.info({ accountId: id }, "email-poll: stopped monitor");
        }
      }
      // Start monitors for newly-active accounts
      for (const id of activeIds) {
        if (!monitors.has(id)) {
          const handle = startMonitor({ db, accountId: id, processor });
          monitors.set(id, handle);
          logger.info({ accountId: id }, "email-poll: started monitor");
        }
      }
    } catch (err) {
      logger.warn({ err }, "email-poll: reconcile failed");
    } finally {
      if (!stopped) reconcileTimer = setTimeout(reconcile, reconcileIntervalMs);
    }
  }

  reconcile();

  return {
    stop() {
      stopped = true;
      if (reconcileTimer) clearTimeout(reconcileTimer);
      for (const handle of monitors.values()) handle.stop();
      monitors.clear();
    },
    reconcileNow: reconcile,
  };
}
