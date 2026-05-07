import { api } from "./client";

export interface Topic {
  id: string;
  name: string;
  summary: string;
  currentState: string | null;
  companyId: string | null;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  issueCount: number;
}

export interface LinkedIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  companyId: string;
}

export interface TopicWithIssues extends Omit<Topic, "issueCount"> {
  issues: LinkedIssue[];
}

export const topicsApi = {
  list: (status?: string) =>
    api.get<Topic[]>(`/ecc/topics${status ? `?status=${encodeURIComponent(status)}` : ""}`),

  create: (data: { name: string; companyId?: string | null }) =>
    api.post<Topic>("/ecc/topics", data),

  getById: (id: string) =>
    api.get<TopicWithIssues>(`/ecc/topics/${id}`),

  update: (
    id: string,
    data: Partial<Pick<Topic, "name" | "summary" | "currentState" | "status" | "companyId">>,
  ) => api.patch<Topic>(`/ecc/topics/${id}`, data),

  remove: (id: string) =>
    api.delete<void>(`/ecc/topics/${id}`),

  linkIssue: (topicId: string, issueId: string) =>
    api.post<{ ok: boolean }>(`/ecc/topics/${topicId}/issues`, { issueId }),

  unlinkIssue: (topicId: string, issueId: string) =>
    api.delete<void>(`/ecc/topics/${topicId}/issues/${issueId}`),
};
