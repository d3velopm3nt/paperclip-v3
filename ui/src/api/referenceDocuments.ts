import type {
  ReferenceDocument,
  ReferenceDocumentWithContent,
  DocumentSource,
  CreateDocumentSourceInput,
  UpdateReferenceDocumentInput,
  GoogleDriveStatus,
  CompanyStorageRoot,
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

  updateSource: (companyId: string, sourceId: string, patch: { name?: string; localPath?: string }) =>
    api.patch<import("@paperclipai/shared").DocumentSource>(`/companies/${companyId}/document-sources/${sourceId}`, patch),

  deleteSource: (companyId: string, sourceId: string) =>
    api.delete<void>(`/companies/${companyId}/document-sources/${sourceId}`),

  triggerSync: (companyId: string) =>
    api.post<{ ok: boolean }>(`/companies/${companyId}/document-sources/sync`, {}),

  listDriveFolders: (parentId?: string) =>
    api.get<{ folders: { id: string; name: string }[]; parentId: string }>(
      `/instance/storage/gdrive/folders${parentId ? `?parentId=${encodeURIComponent(parentId)}` : ""}`,
    ),

  getGoogleAppCreds: () =>
    api.get<{ configured: boolean; clientId: string | null; fromEnv: boolean }>(
      "/instance/storage/gdrive/app-credentials",
    ),

  saveGoogleAppCreds: (clientId: string, clientSecret: string) =>
    api.put<{ ok: boolean }>("/instance/storage/gdrive/app-credentials", { clientId, clientSecret }),

  deleteGoogleAppCreds: () =>
    api.delete<{ ok: boolean }>("/instance/storage/gdrive/app-credentials"),

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
  getCompanyStorageRoot: (companyId: string) =>
    api.get<CompanyStorageRoot>(`/companies/${encodeURIComponent(companyId)}/storage/root`),
  setCompanyStorageRoot: (companyId: string, body: CompanyStorageRoot & { copyFromCompanyId?: string }) =>
    api.put<{ ok: boolean }>(`/companies/${encodeURIComponent(companyId)}/storage/root`, body),
  listCompaniesWithStorage: () =>
    api.get<Array<{ id: string; name: string; localPath: string | null; driveFolderId: string | null }>>(
      "/instance/storage/companies-with-storage",
    ),
};
