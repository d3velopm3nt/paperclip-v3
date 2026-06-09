import { api } from "./client";

export interface EmailLabelDefinition {
  id: string;
  companyId: string;
  name: string;
  color: string;
  createdAt: string;
}

export const emailLabelDefinitionsApi = {
  list: (companyId: string) =>
    api.get<EmailLabelDefinition[]>(
      `/companies/${encodeURIComponent(companyId)}/email-label-definitions`,
    ),
  create: (companyId: string, name: string, color?: string) =>
    api.post<EmailLabelDefinition>(
      `/companies/${encodeURIComponent(companyId)}/email-label-definitions`,
      { name, color },
    ),
  remove: (companyId: string, labelId: string) =>
    api.delete<void>(
      `/companies/${encodeURIComponent(companyId)}/email-label-definitions/${encodeURIComponent(labelId)}`,
    ),
};
