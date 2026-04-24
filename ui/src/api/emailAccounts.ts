// v3: email accounts client — wraps /api/companies/:id/email-accounts + /api/email-accounts/:id
import { api } from "./client";

export interface EmailAccount {
  id: string;
  companyId: string;
  label: string;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapTls: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpSecure: boolean;
  folder: string;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  pollIntervalSec: number;
  active: boolean;
  lastPolledAt: string | null;
  lastErrorText: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailAccountCreateRequest {
  label: string;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPassword: string;
  imapTls?: boolean;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUser?: string | null;
  smtpPassword?: string | null;
  smtpSecure?: boolean;
  folder?: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string | null;
  pollIntervalSec?: number;
  active?: boolean;
}

export interface EmailAccountUpdateRequest {
  label?: string;
  imapHost?: string;
  imapPort?: number;
  imapUser?: string;
  imapPassword?: string;
  imapTls?: boolean;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpUser?: string | null;
  smtpPassword?: string | null;
  smtpSecure?: boolean;
  folder?: string;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string | null;
  pollIntervalSec?: number;
  active?: boolean;
}

export type TestConnectionResult = { ok: true } | { ok: false; error: string };

export interface EphemeralTestRequest {
  kind: "imap" | "smtp";
  host: string;
  port: number;
  user: string;
  password: string;
  tls?: boolean;
  secure?: boolean;
}

export const emailAccountsApi = {
  list: (companyId: string) =>
    api.get<EmailAccount[]>(`/companies/${encodeURIComponent(companyId)}/email-accounts`),
  create: (companyId: string, data: EmailAccountCreateRequest) =>
    api.post<EmailAccount>(`/companies/${encodeURIComponent(companyId)}/email-accounts`, data),
  get: (id: string) =>
    api.get<EmailAccount>(`/email-accounts/${encodeURIComponent(id)}`),
  update: (id: string, data: EmailAccountUpdateRequest) =>
    api.patch<EmailAccount>(`/email-accounts/${encodeURIComponent(id)}`, data),
  delete: (id: string) =>
    api.delete<void>(`/email-accounts/${encodeURIComponent(id)}`),
  testConnection: (id: string) =>
    api.post<TestConnectionResult>(`/email-accounts/${encodeURIComponent(id)}/test-connection`, {}),
  testSmtp: (id: string) =>
    api.post<TestConnectionResult>(`/email-accounts/${encodeURIComponent(id)}/test-smtp`, {}),
  testEphemeral: (data: EphemeralTestRequest) =>
    api.post<TestConnectionResult>(`/email-accounts/test-connection`, data),
};
