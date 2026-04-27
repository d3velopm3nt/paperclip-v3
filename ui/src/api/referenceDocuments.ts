import type {
  ReferenceDocument,
  ReferenceDocumentWithContent,
  DocumentSource,
  CreateDocumentSourceInput,
  UpdateReferenceDocumentInput,
  GoogleDriveStatus,
} from "@paperclipai/shared";
import { api } from "./client";

export const referenceDocumentsApi = {
  list: (companyId: string, params?: { projectId?: string; scope?: string; sourceType?: string }) => {
    const qs = new URLSearchParams();
    if (params?.projectId) qs.set("projectId", params.projectId);
    if (params?.scope) qs.set("scope", params.scope);
    if (params?.sourceType) qs.set("sourceType", params.sourceType);
    const q = qs.toString();
    return api.get<ReferenceDocument[]>(`/companies/${companyId}/documents${q ? `?${q}` : ""}`);
  },

  get: (companyId: string, docId: string) =>
    api.get<ReferenceDocument>(`/companies/${companyId}/documents/${docId}`),

  getContent: (companyId: string, docId: string) =>
    api.get<ReferenceDocumentWithContent>(`/companies/${companyId}/documents/${docId}/content`),

  upload: (companyId: string, file: File, scope: "company" | "project", projectId?: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("scope", scope);
    if (projectId) form.append("projectId", projectId);
    return api.postForm<ReferenceDocument>(`/companies/${companyId}/documents`, form);
  },

  update: (companyId: string, docId: string, input: UpdateReferenceDocumentInput) =>
    api.patch<ReferenceDocument>(`/companies/${companyId}/documents/${docId}`, input),

  delete: (companyId: string, docId: string) =>
    api.delete<void>(`/companies/${companyId}/documents/${docId}`),

  listSources: (companyId: string) =>
    api.get<DocumentSource[]>(`/companies/${companyId}/document-sources`),

  createSource: (companyId: string, input: CreateDocumentSourceInput) =>
    api.post<DocumentSource>(`/companies/${companyId}/document-sources`, input),

  deleteSource: (companyId: string, sourceId: string) =>
    api.delete<void>(`/companies/${companyId}/document-sources/${sourceId}`),

  triggerSync: (companyId: string) =>
    api.post<{ ok: boolean }>(`/companies/${companyId}/document-sources/sync`, {}),

  getGDriveStatus: () =>
    api.get<GoogleDriveStatus>("/instance/storage/gdrive/status"),

  getGDriveAuthUrl: () =>
    api.get<{ url: string }>("/instance/storage/gdrive/auth"),

  disconnectGDrive: () =>
    api.delete<{ ok: boolean }>("/instance/storage/gdrive/auth"),

  testLocalPath: (localPath: string) =>
    api.post<{ ok: boolean; fileCount?: number; message?: string; error?: string }>(
      "/instance/storage/local/test",
      { localPath },
    ),
};
