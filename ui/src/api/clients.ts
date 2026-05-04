import { api } from "./client";
import type { ClientStorageInfo } from "@paperclipai/shared";

export interface Client {
  id: string;
  companyId: string;
  name: string;
  emailDomain: string | null;
  extraEmails: string[];
  trustLevel: string;
  isMyCompany: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClientCreateRequest {
  name: string;
  emailDomain?: string | null;
  extraEmails?: string[];
  trustLevel?: string;
  isMyCompany?: boolean;
  notes?: string | null;
}

export type ClientUpdateRequest = Partial<ClientCreateRequest>;

export const clientsApi = {
  list: (companyId: string) =>
    api.get<Client[]>(`/companies/${encodeURIComponent(companyId)}/clients`),
  get: (id: string) =>
    api.get<Client>(`/clients/${encodeURIComponent(id)}`),
  create: (companyId: string, data: ClientCreateRequest) =>
    api.post<Client>(`/companies/${encodeURIComponent(companyId)}/clients`, data),
  update: (id: string, data: ClientUpdateRequest) =>
    api.patch<Client>(`/clients/${encodeURIComponent(id)}`, data),
  delete: (id: string) => api.delete<void>(`/clients/${encodeURIComponent(id)}`),
  getStorage: (id: string) =>
    api.get<ClientStorageInfo>(`/clients/${encodeURIComponent(id)}/storage`),
  setStorage: (id: string, body: { localPath?: string | null; driveFolderId?: string | null; autoCreate?: boolean }) =>
    api.put<ClientStorageInfo>(`/clients/${encodeURIComponent(id)}/storage`, body),
  getProjectStorage: (clientId: string, projectId: string) =>
    api.get<ClientStorageInfo>(`/clients/${encodeURIComponent(clientId)}/projects/${encodeURIComponent(projectId)}/storage`),
};
