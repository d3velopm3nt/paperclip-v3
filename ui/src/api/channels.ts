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

export const channelsApi = {
  status: () => api.get<ChannelsStatus>("/channels/status"),

  registerTelegramWebhook: (url: string) =>
    api.post<{ ok: boolean; webhookUrl: string }>("/channels/telegram/webhook", { url }),

  deleteTelegramWebhook: () =>
    api.delete<{ ok: boolean }>("/channels/telegram/webhook"),

  testTelegram: () =>
    api.post<{ ok: boolean }>("/channels/telegram/test", {}),
};
