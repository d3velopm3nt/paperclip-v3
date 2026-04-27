export type DocumentSourceType = "local" | "gdrive" | "upload";
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
  type: "local" | "gdrive";
  name: string;
  localPath: string | null;
  driveFolderId: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  createdAt: string;
}

export interface CreateDocumentSourceInput {
  type: "local" | "gdrive";
  name: string;
  localPath?: string;
  driveFolderId?: string;
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
