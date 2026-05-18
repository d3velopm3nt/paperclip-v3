import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documentSources, referenceDocuments } from "@paperclipai/db";
import type {
  ReferenceDocument,
  ReferenceDocumentWithContent,
  DocumentSource,
  UpdateReferenceDocumentInput,
  CreateDocumentSourceInput,
} from "@paperclipai/shared";

function toDocument(row: typeof referenceDocuments.$inferSelect): ReferenceDocument {
  return {
    id: row.id,
    companyId: row.companyId,
    title: row.title,
    description: row.description,
    mimeType: row.mimeType,
    sourceType: row.sourceType as ReferenceDocument["sourceType"],
    sourcePath: row.sourcePath,
    driveFileId: row.driveFileId,
    driveWebUrl: row.driveWebUrl,
    scope: row.scope as ReferenceDocument["scope"],
    projectId: row.projectId,
    includeInContext: row.includeInContext,
    syncedAt: row.syncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDocumentWithContent(row: typeof referenceDocuments.$inferSelect): ReferenceDocumentWithContent {
  return { ...toDocument(row), extractedText: row.extractedText };
}

function toSource(row: typeof documentSources.$inferSelect): DocumentSource {
  return {
    id: row.id,
    companyId: row.companyId,
    clientId: row.clientId ?? null,
    projectId: row.projectId ?? null,
    type: row.type as DocumentSource["type"],
    name: row.name,
    localPath: row.localPath,
    driveFolderId: row.driveFolderId,
    githubRepoUrl: row.githubRepoUrl ?? null,
    githubBranch: row.githubBranch ?? null,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    lastSyncError: row.lastSyncError,
    createdAt: row.createdAt.toISOString(),
  };
}

export function referenceDocumentsService(db: Db) {
  return {
    listDocuments: async (
      companyId: string,
      filters?: { projectId?: string; scope?: string; sourceType?: string },
    ): Promise<ReferenceDocument[]> => {
      const conditions = [eq(referenceDocuments.companyId, companyId)];
      if (filters?.projectId) conditions.push(eq(referenceDocuments.projectId, filters.projectId));
      if (filters?.scope) conditions.push(eq(referenceDocuments.scope, filters.scope));
      if (filters?.sourceType) conditions.push(eq(referenceDocuments.sourceType, filters.sourceType));
      const rows = await db
        .select()
        .from(referenceDocuments)
        .where(and(...conditions))
        .orderBy(desc(referenceDocuments.updatedAt));
      return rows.map(toDocument);
    },

    getDocument: async (companyId: string, docId: string): Promise<ReferenceDocument | null> => {
      const [row] = await db
        .select()
        .from(referenceDocuments)
        .where(and(eq(referenceDocuments.companyId, companyId), eq(referenceDocuments.id, docId)))
        .limit(1);
      return row ? toDocument(row) : null;
    },

    getDocumentContent: async (companyId: string, docId: string): Promise<ReferenceDocumentWithContent | null> => {
      const [row] = await db
        .select()
        .from(referenceDocuments)
        .where(and(eq(referenceDocuments.companyId, companyId), eq(referenceDocuments.id, docId)))
        .limit(1);
      if (!row) return null;

      // Lazy extraction for local files that haven't been extracted yet
      if (row.sourceType === "local" && row.sourcePath && row.extractedText === null) {
        const { extractTextFromFile } = await import("../services/document-extractor.js");
        const text = await extractTextFromFile(row.sourcePath).catch(() => null);
        if (text) {
          const [updated] = await db
            .update(referenceDocuments)
            .set({ extractedText: text.slice(0, 50_000), updatedAt: new Date() })
            .where(eq(referenceDocuments.id, row.id))
            .returning();
          return updated ? toDocumentWithContent(updated) : toDocumentWithContent(row);
        }
      }

      return toDocumentWithContent(row);
    },

    updateDocument: async (
      companyId: string,
      docId: string,
      input: UpdateReferenceDocumentInput,
    ): Promise<ReferenceDocument | null> => {
      const [row] = await db
        .update(referenceDocuments)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(referenceDocuments.companyId, companyId), eq(referenceDocuments.id, docId)))
        .returning();
      return row ? toDocument(row) : null;
    },

    deleteDocument: async (companyId: string, docId: string): Promise<void> => {
      await db
        .delete(referenceDocuments)
        .where(and(eq(referenceDocuments.companyId, companyId), eq(referenceDocuments.id, docId)));
    },

    upsertBySourcePath: async (
      companyId: string,
      sourcePath: string,
      data: Partial<typeof referenceDocuments.$inferInsert>,
    ): Promise<void> => {
      const [existing] = await db
        .select({ id: referenceDocuments.id, checksum: referenceDocuments.checksum })
        .from(referenceDocuments)
        .where(and(eq(referenceDocuments.companyId, companyId), eq(referenceDocuments.sourcePath, sourcePath)))
        .limit(1);
      if (existing) {
        if (existing.checksum === data.checksum) return;
        await db
          .update(referenceDocuments)
          .set({ ...data, updatedAt: new Date() })
          .where(eq(referenceDocuments.id, existing.id));
      } else {
        await db.insert(referenceDocuments).values({
          companyId,
          title: data.title ?? (sourcePath.split("/").pop() ?? "Untitled"),
          sourceType: "local",
          sourcePath,
          scope: "company",
          includeInContext: true,
          ...data,
        });
      }
    },

    upsertByDriveFileId: async (
      companyId: string,
      driveFileId: string,
      data: Partial<typeof referenceDocuments.$inferInsert>,
    ): Promise<void> => {
      const [existing] = await db
        .select({ id: referenceDocuments.id, checksum: referenceDocuments.checksum })
        .from(referenceDocuments)
        .where(and(eq(referenceDocuments.companyId, companyId), eq(referenceDocuments.driveFileId, driveFileId)))
        .limit(1);
      if (existing) {
        if (existing.checksum === data.checksum) return;
        await db
          .update(referenceDocuments)
          .set({ ...data, updatedAt: new Date() })
          .where(eq(referenceDocuments.id, existing.id));
      } else {
        await db.insert(referenceDocuments).values({
          companyId,
          title: data.title ?? "Untitled",
          sourceType: "gdrive",
          driveFileId,
          scope: "company",
          includeInContext: true,
          ...data,
        });
      }
    },

    deleteBySourcePathsNotIn: async (companyId: string, keepPaths: string[]): Promise<void> => {
      const rows = await db
        .select({ id: referenceDocuments.id, sourcePath: referenceDocuments.sourcePath })
        .from(referenceDocuments)
        .where(and(eq(referenceDocuments.companyId, companyId), eq(referenceDocuments.sourceType, "local")));
      const toDelete = rows
        .filter((r) => r.sourcePath && !keepPaths.includes(r.sourcePath))
        .map((r) => r.id);
      if (toDelete.length > 0) {
        await db.delete(referenceDocuments).where(inArray(referenceDocuments.id, toDelete));
      }
    },

    deleteByDriveFileIdsNotIn: async (companyId: string, keepIds: string[]): Promise<void> => {
      const rows = await db
        .select({ id: referenceDocuments.id, driveFileId: referenceDocuments.driveFileId })
        .from(referenceDocuments)
        .where(and(eq(referenceDocuments.companyId, companyId), eq(referenceDocuments.sourceType, "gdrive")));
      const toDelete = rows
        .filter((r) => r.driveFileId && !keepIds.includes(r.driveFileId))
        .map((r) => r.id);
      if (toDelete.length > 0) {
        await db.delete(referenceDocuments).where(inArray(referenceDocuments.id, toDelete));
      }
    },

    getContextIndex: async (companyId: string, projectId?: string): Promise<ReferenceDocument[]> => {
      const conditions = [
        eq(referenceDocuments.companyId, companyId),
        eq(referenceDocuments.includeInContext, true),
      ];
      if (projectId) {
        conditions.push(
          or(
            eq(referenceDocuments.scope, "company"),
            and(eq(referenceDocuments.scope, "project"), eq(referenceDocuments.projectId, projectId))!,
          )!,
        );
      } else {
        conditions.push(eq(referenceDocuments.scope, "company"));
      }
      return (
        await db
          .select()
          .from(referenceDocuments)
          .where(and(...conditions))
          .orderBy(referenceDocuments.title)
          .limit(50)
      ).map(toDocument);
    },

    listSources: async (companyId: string): Promise<DocumentSource[]> => {
      const rows = await db
        .select()
        .from(documentSources)
        .where(eq(documentSources.companyId, companyId))
        .orderBy(documentSources.createdAt);
      return rows.map(toSource);
    },

    createSource: async (companyId: string, input: CreateDocumentSourceInput): Promise<DocumentSource> => {
      const [row] = await db
        .insert(documentSources)
        .values({ companyId, ...input })
        .returning();
      return toSource(row!);
    },

    deleteSource: async (companyId: string, sourceId: string): Promise<void> => {
      await db
        .delete(documentSources)
        .where(and(eq(documentSources.companyId, companyId), eq(documentSources.id, sourceId)));
    },

    updateSource: async (
      companyId: string,
      sourceId: string,
      patch: { name?: string; localPath?: string; driveFolderId?: string },
    ): Promise<DocumentSource | null> => {
      const [row] = await db
        .update(documentSources)
        .set(patch)
        .where(and(eq(documentSources.companyId, companyId), eq(documentSources.id, sourceId)))
        .returning();
      return row ? toSource(row) : null;
    },

    updateSourceSyncResult: async (sourceId: string, error: string | null): Promise<void> => {
      await db
        .update(documentSources)
        .set({ lastSyncedAt: new Date(), lastSyncError: error })
        .where(eq(documentSources.id, sourceId));
    },
  };
}
