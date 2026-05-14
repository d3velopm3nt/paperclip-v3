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
    api.get<Topic[]>(`/ea/topics${status ? `?status=${encodeURIComponent(status)}` : ""}`),

  create: (data: { name: string; companyId?: string | null }) =>
    api.post<Topic>("/ea/topics", data),

  getById: (id: string) =>
    api.get<TopicWithIssues>(`/ea/topics/${id}`),

  update: (
    id: string,
    data: Partial<Pick<Topic, "name" | "summary" | "currentState" | "status" | "companyId">>,
  ) => api.patch<Topic>(`/ea/topics/${id}`, data),

  remove: (id: string) =>
    api.delete<void>(`/ea/topics/${id}`),

  linkIssue: (topicId: string, issueId: string) =>
    api.post<{ ok: boolean }>(`/ea/topics/${topicId}/issues`, { issueId }),

  unlinkIssue: (topicId: string, issueId: string) =>
    api.delete<void>(`/ea/topics/${topicId}/issues/${issueId}`),
};
