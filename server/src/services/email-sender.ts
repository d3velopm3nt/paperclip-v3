// v3: outbound email sender — used by plan-gate executePlan dispatchers
// (reply_to_sender, request_clarification) and any service needing SMTP.
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { emailAccounts } from "@paperclipai/db";
import { decryptPassword } from "./email-accounts.js";
import { logger } from "../middleware/logger.js";

export interface SendEmailOpts {
  accountId: string;
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string | null;
  references?: string[] | null;
  replyTo?: string | null;
}

export interface SendEmailResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

export async function sendEmailFromAccount(db: Db, opts: SendEmailOpts): Promise<SendEmailResult> {
  const [account] = await db
    .select()
    .from(emailAccounts)
    .where(eq(emailAccounts.id, opts.accountId))
    .limit(1);
  if (!account) throw new Error(`email account not found: ${opts.accountId}`);
  if (!account.smtpHost || !account.smtpPort) {
    throw new Error(`email account ${account.label} has no SMTP configured`);
  }

  const smtpUser = account.smtpUser ?? account.imapUser;
  const encPass = account.smtpPasswordEnc ?? account.imapPasswordEnc;
  const password = decryptPassword(encPass);

  const { default: nodemailer } = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    auth: { user: smtpUser, pass: password },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
    tls: { rejectUnauthorized: false },
  });

  logger.info(
    { accountId: opts.accountId, to: opts.to, subject: opts.subject, from: account.fromEmail },
    "email-sender: sending",
  );
  try {
    const info = await transporter.sendMail({
      from: `"${account.fromName}" <${account.fromEmail}>`,
      to: opts.to,
      replyTo: opts.replyTo ?? account.replyTo ?? undefined,
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      inReplyTo: opts.inReplyTo ?? undefined,
      references: opts.references ?? undefined,
    });
    logger.info(
      {
        accountId: opts.accountId,
        messageId: info.messageId,
        to: opts.to,
        subject: opts.subject,
        accepted: info.accepted,
        rejected: info.rejected,
      },
      "email-sender: sent",
    );
    if ((info.rejected ?? []).length > 0) {
      logger.warn({ accountId: opts.accountId, rejected: info.rejected, to: opts.to }, "email-sender: some recipients rejected");
    }
    return {
      messageId: info.messageId,
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
    };
  } catch (err) {
    logger.error(
      { accountId: opts.accountId, to: opts.to, subject: opts.subject, err: err instanceof Error ? err.message : String(err) },
      "email-sender: send failed",
    );
    throw err;
  } finally {
    transporter.close();
  }
}
