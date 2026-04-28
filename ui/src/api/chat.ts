import { api } from "./client";

export interface ChatThread {
  id: string;
  companyId: string;
  agentId: string | null;
  name: string;
  platform: string;
  externalKey: string | null;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  companyId: string;
  issueId: string | null;
  direction: "inbound" | "outbound";
  platform: string;
  source: string;
  fromAgentId: string | null;
  body: string;
  chatThreadId: string | null;
  rawPayload: { contextRefs?: ContextRef[] } | null;
  createdAt: string;
  isStatus?: boolean;
}

export interface ContextRef {
  type: "issue" | "project" | "client" | "agent" | "document";
  id: string;
  label: string;
  meta?: {
    cwd?: string;
    status?: string;
    role?: string;
    sourceType?: string;
    driveWebUrl?: string;
  };
}

export const chatApi = {
  ensureDispatcherThread: (companyId: string) =>
    api.post<ChatThread>(`/companies/${companyId}/chat/threads`, {}),

  ensureAgentThread: (companyId: string, agentId: string) =>
    api.post<ChatThread>(`/companies/${companyId}/chat/threads`, { agentId }),

  listThreads: (companyId: string) =>
    api.get<ChatThread[]>(`/companies/${companyId}/chat/threads`),

  listMessages: (companyId: string, threadId: string) =>
    api.get<ChatMessage[]>(`/companies/${companyId}/chat/threads/${threadId}/messages`),

  ensureTelegramThread: (companyId: string) =>
    api.post<ChatThread>(`/companies/${companyId}/chat/threads`, { platform: "telegram" }),

  sendMessage: (
    companyId: string,
    body: string,
    contextRefs: ContextRef[] = [],
    toAgentId?: string,
  ) =>
    api.post<{ ok: boolean; threadId: string }>(`/companies/${companyId}/chat/messages`, {
      body,
      contextRefs,
      ...(toAgentId ? { toAgentId } : {}),
    }),

  // Reply to a specific thread (WhatsApp, future external platforms)
  replyToThread: (companyId: string, threadId: string, body: string) =>
    api.post<{ ok: boolean; messageId: string }>(
      `/companies/${companyId}/chat/threads/${threadId}/reply`,
      { body },
    ),
};
