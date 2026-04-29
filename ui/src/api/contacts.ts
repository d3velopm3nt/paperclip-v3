import { api } from "./client";

export interface Contact {
  id: string;
  companyId: string;
  clientId: string | null;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  role: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export function contactDisplayName(c: Contact): string {
  if (c.firstName || c.lastName) return [c.firstName, c.lastName].filter(Boolean).join(" ");
  return c.email;
}

export interface ContactCreateRequest {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  role?: string | null;
  notes?: string | null;
}

export type ContactUpdateRequest = Partial<Omit<ContactCreateRequest, "email">>;

export const contactsApi = {
  listForClient: (clientId: string) =>
    api.get<Contact[]>(`/clients/${encodeURIComponent(clientId)}/contacts`),
  listTeam: (companyId: string) =>
    api.get<Contact[]>(`/companies/${encodeURIComponent(companyId)}/team`),
  create: (clientId: string, data: ContactCreateRequest) =>
    api.post<Contact>(`/clients/${encodeURIComponent(clientId)}/contacts`, data),
  update: (id: string, data: ContactUpdateRequest) =>
    api.patch<Contact>(`/contacts/${encodeURIComponent(id)}`, data),
  delete: (id: string) => api.delete<void>(`/contacts/${encodeURIComponent(id)}`),
};
