import { api } from "./client";

export interface TelegramBotInfo {
  id: number;
  username: string;
  firstName: string;
}

export interface TelegramWebhookInfo {
  url: string;
  hasCustomCertificate: boolean;
  pendingUpdateCount: number;
}

export interface TelegramChannelStatus {
  configured: boolean;
  tokenSource?: "db" | "env" | null;
  tokenSet?: boolean;
  routingSource?: "env" | "db" | "default"; // env = TELEGRAM_COMPANY_ID set, cannot change from UI
  activeCompanyId?: string | null;
  operatorChatId?: string | null;
  bot?: TelegramBotInfo;
  webhook?: TelegramWebhookInfo;
  error?: string;
}

export interface EmailChannelStatus {
  configured: boolean;
  accountCount: number;
}

export interface ChannelsStatus {
  telegram: TelegramChannelStatus;
  email: EmailChannelStatus;
}

export interface ChannelMessage {
  id: string;
  direction: string;
  platform: string;
  body: string;
  chatThreadId: string | null;
  createdAt: string;
}

export const channelsApi = {
  status: () => api.get<ChannelsStatus>("/channels/status"),

  registerTelegramWebhook: (url: string) =>
    api.post<{ ok: boolean; webhookUrl: string }>("/channels/telegram/webhook", { url }),

  deleteTelegramWebhook: () =>
    api.delete<{ ok: boolean }>("/channels/telegram/webhook"),

  testTelegram: () =>
    api.post<{ ok: boolean }>("/channels/telegram/test", {}),

  setTelegramToken: (token: string) =>
    api.put<{ ok: boolean }>("/channels/telegram/token", { token }),

  deleteTelegramToken: () =>
    api.delete<{ ok: boolean }>("/channels/telegram/token"),

  setTelegramRouting: (companyId: string | null) =>
    api.put<{ ok: boolean }>("/channels/telegram/routing", { companyId }),

  listMessages: (companyId: string, platform?: string) => {
    const qs = platform ? `?platform=${encodeURIComponent(platform)}` : "";
    return api.get<ChannelMessage[]>(`/companies/${companyId}/channels/messages${qs}`);
  },
};
