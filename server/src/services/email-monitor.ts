// v3: per-account IMAP polling with reconnect and exponential backoff.
// Connects, fetches UNSEEN, hands raw bytes to the email processor, marks
// Seen on success, updates lastPolledAt / lastErrorText on the account row.

import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { emailAccounts } from "@paperclipai/db";
import { decryptPassword } from "./email-accounts.js";
import type { EmailProcessorService } from "./email-processor.js";
import { logger } from "../middleware/logger.js";

interface MonitorHandle {
  accountId: string;
  stop: () => void;
}

const MIN_POLL_INTERVAL_MS = 15_000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;

export interface StartMonitorOptions {
  db: Db;
  accountId: string;
  processor: EmailProcessorService;
}

export function startMonitor(opts: StartMonitorOptions): MonitorHandle {
  const { db, accountId, processor } = opts;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let failures = 0;

  async function tick() {
    if (stopped) return;
    try {
      const [row] = await db
        .select()
        .from(emailAccounts)
        .where(eq(emailAccounts.id, accountId))
        .limit(1);
      if (!row || !row.active) {
        scheduleNext(row?.pollIntervalSec ?? 60);
        return;
      }
      const password = decryptPassword(row.imapPasswordEnc);
      const count = await runIMAPCycle(row, password, processor);
      await db
        .update(emailAccounts)
        .set({ lastPolledAt: new Date(), lastErrorText: null, updatedAt: new Date() })
        .where(eq(emailAccounts.id, accountId));
      failures = 0;
      if (count > 0) {
        logger.info({ accountId, count }, "email-monitor: processed messages");
      }
      scheduleNext(row.pollIntervalSec);
    } catch (err) {
      failures++;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ accountId, err: message, failures }, "email-monitor: cycle failed");
      try {
        await db
          .update(emailAccounts)
          .set({ lastErrorText: message.slice(0, 1000), updatedAt: new Date() })
          .where(eq(emailAccounts.id, accountId));
      } catch {
        // ignore secondary write failure
      }
      const backoff = Math.min(MAX_BACKOFF_MS, 2 ** failures * 1000);
      scheduleNext(Math.max(backoff / 1000, 15));
    }
  }

  function scheduleNext(seconds: number) {
    if (stopped) return;
    const ms = Math.max(MIN_POLL_INTERVAL_MS, seconds * 1000);
    timer = setTimeout(tick, ms);
  }

  // Kick off immediately
  tick();

  return {
    accountId,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function runIMAPCycle(
  account: typeof emailAccounts.$inferSelect,
  password: string,
  processor: EmailProcessorService,
): Promise<number> {
  const { default: Imap } = await import("imap");
  return new Promise<number>((resolve, reject) => {
    const imap = new Imap({
      user: account.imapUser,
      password,
      host: account.imapHost,
      port: account.imapPort,
      tls: account.imapTls,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15_000,
      authTimeout: 15_000,
      keepalive: false,
    });

    let settled = false;
    function done(err: Error | null, count = 0) {
      if (settled) return;
      settled = true;
      try { imap.end(); } catch { /* ignore */ }
      if (err) reject(err);
      else resolve(count);
    }

    imap.once("ready", () => {
      imap.openBox(account.folder, false, (err) => {
        if (err) return done(err);
        imap.search(["UNSEEN"], (searchErr, uids) => {
          if (searchErr) return done(searchErr);
          if (!uids || uids.length === 0) return done(null, 0);
          const fetch = imap.fetch(uids, { bodies: "", markSeen: true });
          const pending: Array<Promise<void>> = [];
          fetch.on("message", (msg) => {
            const chunks: Buffer[] = [];
            msg.on("body", (stream) => {
              stream.on("data", (chunk: Buffer) => chunks.push(chunk));
            });
            msg.once("end", () => {
              const raw = Buffer.concat(chunks);
              pending.push(
                processor
                  .processRawMessage({
                    emailAccountId: account.id,
                    rawBytes: raw,
                  })
                  .then(() => undefined)
                  .catch((e: Error) => {
                    logger.warn({ err: e, accountId: account.id }, "email-monitor: process failed");
                  }),
              );
            });
          });
          fetch.once("error", (fetchErr) => done(fetchErr));
          fetch.once("end", () => {
            Promise.all(pending).then(() => done(null, pending.length));
          });
        });
      });
    });

    imap.once("error", (err: Error) => done(err));
    imap.connect();

    setTimeout(() => done(new Error("IMAP cycle timed out")), 60_000);
  });
}
