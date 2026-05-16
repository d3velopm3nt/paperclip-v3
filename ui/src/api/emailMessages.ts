// v3: inbox API — list + detail + attachment download URL
import { api } from "./client";

export interface EmailAttachmentSummary {
  id: string;
  filename: string;
  contentType: string;
  contentId: string | null;
  isInline: boolean;
  sizeBytes: number;
  filedAt: string | null;
  filedPath: string | null;
}

export interface EmailMessageSummary {
  id: string;
  emailAccountId: string;
  accountLabel: string | null;
  messageIdHeader: string;
  fromAddr: string;
  toAddrs: string[];
  subject: string;
  body: string;
  receivedAt: string;
  processedAt: string | null;
  processingState: string;
  matchedCompanyId: string | null;
  matchedClientId: string | null;
  matchedAgentId: string | null;
  issueId: string | null;
  approvalId: string | null;
  attachmentsPath: string | null;
  errorText: string | null;
  createdAt: string;
}

export interface EmailMessageDetail extends EmailMessageSummary {
  attachments: EmailAttachmentSummary[];
  rawHeaders: Record<string, unknown> | null;
}

export const emailMessagesApi = {
  list: (companyId: string, state?: string, accountRole?: string, matchedAgentId?: string) => {
    const params = new URLSearchParams();
    if (state) params.set("state", state);
    if (accountRole) params.set("accountRole", accountRole);
    if (matchedAgentId) params.set("matchedAgentId", matchedAgentId);
    const qs = params.size ? `?${params.toString()}` : "";
    return api.get<EmailMessageSummary[]>(
      `/companies/${encodeURIComponent(companyId)}/email-messages${qs}`,
    );
  },
  get: (id: string) =>
    api.get<EmailMessageDetail>(`/email-messages/${encodeURIComponent(id)}`),
  attachmentUrl: (messageId: string, attachmentId: string, preview = false) =>
    `/api/email-messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}${preview ? "?preview=true" : ""}`,
  getHtml: (id: string) =>
    api.get<{ html: string | null }>(`/email-messages/${encodeURIComponent(id)}/html`),
  fileAttachment: (messageId: string, attachmentId: string, opts: { driveFolderId?: string; localPath?: string; clientId?: string }) =>
    api.post<{ id: string; filedAt: string | null; filedPath: string | null }>(
      `/email-messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/file`,
      opts,
    ),
  checkFiledPath: (messageId: string, attachmentId: string) =>
    api.get<{ exists: boolean; path: string | null; type: "local" | "drive" | null; filedAt: string | null; driveFileId: string | null; legacy: boolean }>(
      `/email-messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/filed-check`,
    ),
  reprocess: (id: string) =>
    api.post<EmailMessageSummary>(`/email-messages/${encodeURIComponent(id)}/reprocess`, {}),
  bulkReprocess: (ids: string[]) =>
    api.post<{ reprocessed: number; failed: number; errors: string[] }>(`/email-messages/bulk-reprocess`, { ids }),
  remove: (id: string) =>
    api.delete<{
      deletedPlans: number;
      deletedWorkflowRuns: number;
      deletedComments: number;
      deletedIssue: boolean;
    }>(`/email-messages/${encodeURIComponent(id)}`),
  listForIssue: (companyId: string, issueId: string) =>
    api.get<EmailMessageDetail[]>(`/companies/${encodeURIComponent(companyId)}/issues/${encodeURIComponent(issueId)}/emails`),
  linkToIssue: (id: string, issueId: string | null) =>
    api.patch<EmailMessageSummary>(`/email-messages/${encodeURIComponent(id)}`, { issueId }),
};
