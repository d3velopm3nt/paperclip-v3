import { api } from "./client";

export interface Client {
  id: string;
  companyId: string;
  name: string;
  emailDomain: string | null;
  extraEmails: string[];
  trustLevel: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientCreateRequest {
  name: string;
  emailDomain?: string | null;
  extraEmails?: string[];
  trustLevel?: string;
  notes?: string | null;
}

export type ClientUpdateRequest = Partial<ClientCreateRequest>;

export const clientsApi = {
  list: (companyId: string) =>
    api.get<Client[]>(`/companies/${encodeURIComponent(companyId)}/clients`),
  create: (companyId: string, data: ClientCreateRequest) =>
    api.post<Client>(`/companies/${encodeURIComponent(companyId)}/clients`, data),
  update: (id: string, data: ClientUpdateRequest) =>
    api.patch<Client>(`/clients/${encodeURIComponent(id)}`, data),
  delete: (id: string) => api.delete<void>(`/clients/${encodeURIComponent(id)}`),
};
