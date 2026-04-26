// v3: inbox API — list + detail + attachment download URL
import { api } from "./client";

export interface EmailAttachmentSummary {
  id: string;
  filename: string;
  contentType: string;
  contentId: string | null;
  isInline: boolean;
  sizeBytes: number;
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
  attachmentUrl: (messageId: string, attachmentId: string) =>
    `/api/email-messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  reprocess: (id: string) =>
    api.post<EmailMessageSummary>(`/email-messages/${encodeURIComponent(id)}/reprocess`, {}),
  remove: (id: string) =>
    api.delete<{
      deletedPlans: number;
      deletedWorkflowRuns: number;
      deletedComments: number;
      deletedIssue: boolean;
    }>(`/email-messages/${encodeURIComponent(id)}`),
};
