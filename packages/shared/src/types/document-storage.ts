export type DocumentSourceType = "local" | "gdrive" | "github" | "upload";
export type DocumentScope = "company" | "project";

export interface ReferenceDocument {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  mimeType: string | null;
  sourceType: DocumentSourceType;
  sourcePath: string | null;
  driveFileId: string | null;
  driveWebUrl: string | null;
  scope: DocumentScope;
  projectId: string | null;
  includeInContext: boolean;
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReferenceDocumentWithContent extends ReferenceDocument {
  extractedText: string | null;
}

export interface DocumentSource {
  id: string;
  companyId: string;
  clientId: string | null;
  projectId: string | null;
  type: "local" | "gdrive" | "github";
  name: string;
  localPath: string | null;
  driveFolderId: string | null;
  githubRepoUrl: string | null;
  githubBranch: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
}

export interface CreateDocumentSourceInput {
  type: "local" | "gdrive" | "github";
  name: string;
  localPath?: string;
  driveFolderId?: string;
  githubRepoUrl?: string;
  githubBranch?: string;
  githubToken?: string;
  clientId?: string;
  projectId?: string;
}

export interface UpdateReferenceDocumentInput {
  title?: string;
  description?: string;
  scope?: DocumentScope;
  projectId?: string | null;
  includeInContext?: boolean;
}

export interface GoogleDriveStatus {
  connected: boolean;
  email: string | null;
}

/** Storage location for a client or project folder. */
export interface ClientStorageInfo {
  localPath: string | null;
  driveFolderId: string | null;
  driveWebUrl: string | null;
}

/** Company-level storage root stored in instanceSettings. */
export interface CompanyStorageRoot {
  localPath: string | null;
  driveFolderId: string | null;
}
