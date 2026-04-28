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
  routingSource?: "env" | "db" | "default";
  activeCompanyId?: string | null;
  operatorChatId?: string | null;
  bot?: TelegramBotInfo;
  webhook?: TelegramWebhookInfo;
  error?: string;
}

export interface WhatsAppChannelStatus {
  configured: boolean;
  tokenSource?: "db" | null;
  phoneNumberId?: string | null;
  webhookVerified?: boolean;
  allowedContacts?: string[];
  activeCompanyId?: string | null;
  error?: string;
}

export interface EmailChannelStatus {
  configured: boolean;
  accountCount: number;
}

export interface ChannelsStatus {
  telegram: TelegramChannelStatus;
  email: EmailChannelStatus;
  whatsapp?: WhatsAppChannelStatus;
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

  // Telegram
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

  // WhatsApp
  setWhatsAppToken: (token: string) =>
    api.put<{ ok: boolean }>("/channels/whatsapp/token", { token }),
  deleteWhatsAppToken: () =>
    api.delete<{ ok: boolean }>("/channels/whatsapp/token"),
  setWhatsAppPhone: (phoneNumberId: string, wabaId: string) =>
    api.put<{ ok: boolean }>("/channels/whatsapp/phone", { phoneNumberId, wabaId }),
  setWhatsAppVerifyToken: (verifyToken: string) =>
    api.put<{ ok: boolean }>("/channels/whatsapp/verify-token", { verifyToken }),
  setWhatsAppContacts: (contacts: string[]) =>
    api.put<{ ok: boolean }>("/channels/whatsapp/contacts", { contacts }),
  setWhatsAppRouting: (companyId: string | null) =>
    api.put<{ ok: boolean }>("/channels/whatsapp/routing", { companyId }),
  registerWhatsAppWebhook: (url: string) =>
    api.post<{ ok: boolean; webhookUrl: string }>("/channels/whatsapp/webhook", { url }),
  testWhatsApp: () =>
    api.post<{ ok: boolean }>("/channels/whatsapp/test", {}),

  listMessages: (companyId: string, platform?: string) => {
    const qs = platform ? `?platform=${encodeURIComponent(platform)}` : "";
    return api.get<ChannelMessage[]>(`/companies/${companyId}/channels/messages${qs}`);
  },
};
