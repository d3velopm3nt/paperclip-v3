import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import type { Db } from "@paperclipai/db";
import { documentSources, companies } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { buildAuthenticatedCloneUrl } from "./github-auth.js";

const execFileAsync = promisify(execFile);
import {
  extractTextFromFile,
  extractTextFromBuffer,
  computeChecksum,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_DRIVE_MIME_TYPES,
} from "./document-extractor.js";
import { referenceDocumentsService } from "./reference-documents.js";
import { getAuthenticatedDriveClient } from "./gdrive-auth.js";
import { logger } from "../middleware/logger.js";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", "dist", "build", ".next", ".nuxt",
  ".cache", ".parcel-cache", "coverage", ".nyc_output", "vendor",
  "__pycache__", ".venv", "venv", ".tox",
]);

async function walkDir(dir: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        results.push(...(await walkDir(path.join(dir, entry.name))));
      } else if (SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push(path.join(dir, entry.name));
      }
    }
  } catch {
    // unreadable directory
  }
  return results;
}

async function syncLocalSource(
  db: Db,
  companyId: string,
  sourceId: string,
  localPath: string,
): Promise<void> {
  const svc = referenceDocumentsService(db);
  const files = await walkDir(localPath);
  const processedPaths: string[] = [];

  for (const filePath of files) {
    try {
      const stat = await fs.stat(filePath).catch(() => null);
      if (!stat) continue;
      const raw = await fs.readFile(filePath);
      const checksum = computeChecksum(raw);
      const ext = path.extname(filePath).slice(1).toLowerCase();
      const mimeType = ext === "pdf" ? "application/pdf"
        : ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : `text/${ext}`;
      const title = path.basename(filePath, path.extname(filePath));
      await svc.upsertBySourcePath(companyId, filePath, {
        title,
        sourceType: "local",
        mimeType,
        extractedText: null, // extracted lazily on first read
        checksum,
        syncedAt: new Date(),
      });
      processedPaths.push(filePath);
    } catch (err) {
      logger.warn({ err, filePath }, "document-sync: local file error");
    }
  }

  await svc.deleteBySourcePathsNotIn(companyId, processedPaths);
  await svc.updateSourceSyncResult(sourceId, null);
  logger.info({ companyId, sourceId, count: processedPaths.length }, "document-sync: local sync complete");
}

async function syncDriveSource(
  db: Db,
  companyId: string,
  sourceId: string,
  folderId: string,
): Promise<void> {
  const drive = await getAuthenticatedDriveClient(db);
  if (!drive) {
    await referenceDocumentsService(db).updateSourceSyncResult(sourceId, "Google Drive not authenticated");
    return;
  }

  const svc = referenceDocumentsService(db);
  const processedIds: string[] = [];

  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, size)",
      pageToken,
      pageSize: 100,
    });
    const files = res.data.files ?? [];
    pageToken = res.data.nextPageToken ?? undefined;

    for (const file of files) {
      if (!file.id || !file.mimeType) continue;
      if (!SUPPORTED_DRIVE_MIME_TYPES.has(file.mimeType)) continue;
      if (Number(file.size ?? 0) > 10 * 1024 * 1024) continue;

      try {
        let buffer: Buffer;
        let mimeType = file.mimeType;

        if (file.mimeType === "application/vnd.google-apps.document") {
          const exportRes = await drive.files.export(
            { fileId: file.id, mimeType: "text/plain" },
            { responseType: "arraybuffer" },
          );
          buffer = Buffer.from(exportRes.data as ArrayBuffer);
          mimeType = "text/plain";
        } else {
          const dlRes = await drive.files.get(
            { fileId: file.id, alt: "media" },
            { responseType: "arraybuffer" },
          );
          buffer = Buffer.from(dlRes.data as ArrayBuffer);
        }

        const checksum = computeChecksum(buffer);
        const text = await extractTextFromBuffer(buffer, mimeType);
        if (!text) continue;

        await svc.upsertByDriveFileId(companyId, file.id, {
          title: file.name ?? "Untitled",
          sourceType: "gdrive",
          mimeType,
          driveWebUrl: file.webViewLink ?? null,
          extractedText: text.slice(0, 50_000),
          checksum,
          syncedAt: new Date(),
        });
        processedIds.push(file.id);
      } catch (err) {
        logger.warn({ err, fileId: file.id }, "document-sync: drive file error");
      }
    }
  } while (pageToken);

  await svc.deleteByDriveFileIdsNotIn(companyId, processedIds);
  await svc.updateSourceSyncResult(sourceId, null);
  logger.info({ companyId, sourceId, count: processedIds.length }, "document-sync: drive sync complete");
}

function githubCloneDir(sourceId: string): string {
  return path.join(os.homedir(), ".paperclip", "instances", "default", "github-repos", sourceId);
}

async function syncGithubSource(
  db: Db,
  companyId: string,
  sourceId: string,
  repoUrl: string,
  branch: string,
  overrideToken: string | null | undefined,
): Promise<void> {
  const cloneDir = githubCloneDir(sourceId);
  // Use per-source token if provided, otherwise fall back to the instance-level stored OAuth token
  const authUrl = await buildAuthenticatedCloneUrl(db, repoUrl, overrideToken);

  await fs.mkdir(cloneDir, { recursive: true });
  const hasGit = await fs.stat(path.join(cloneDir, ".git")).then(() => true).catch(() => false);

  if (!hasGit) {
    logger.info({ sourceId, repoUrl }, "document-sync: cloning GitHub repo");
    await execFileAsync("git", ["clone", "--depth=1", "--branch", branch, authUrl, cloneDir], { timeout: 120_000 });
    logger.info({ sourceId }, "document-sync: clone complete");
  } else {
    logger.info({ sourceId, repoUrl }, "document-sync: pulling GitHub repo");
    await execFileAsync("git", ["-C", cloneDir, "fetch", "--depth=1", "origin", branch], { timeout: 60_000 });
    await execFileAsync("git", ["-C", cloneDir, "reset", "--hard", `origin/${branch}`], { timeout: 30_000 });
    logger.info({ sourceId }, "document-sync: pull complete");
  }

  await syncLocalSource(db, companyId, sourceId, cloneDir);
}

export async function syncCompanyDocuments(db: Db, companyId: string): Promise<void> {
  logger.info({ companyId }, "document-sync: starting sync");
  const sources = await db
    .select()
    .from(documentSources)
    .where(eq(documentSources.companyId, companyId));

  for (const source of sources) {
    try {
      if (source.type === "local" && source.localPath) {
        await syncLocalSource(db, companyId, source.id, source.localPath);
      } else if (source.type === "gdrive" && source.driveFolderId) {
        await syncDriveSource(db, companyId, source.id, source.driveFolderId);
      } else if (source.type === "github" && source.githubRepoUrl) {
        await syncGithubSource(db, companyId, source.id, source.githubRepoUrl, source.githubBranch ?? "main", source.githubToken);
      }
    } catch (err) {
      logger.warn({ err, sourceId: source.id }, "document-sync: source sync failed");
      await referenceDocumentsService(db).updateSourceSyncResult(
        source.id,
        err instanceof Error ? err.message : "Unknown error",
      );
    }
  }
  logger.info({ companyId }, "document-sync: sync complete");
}

export async function syncAllCompaniesDocuments(db: Db): Promise<void> {
  const allCompanies = await db.select({ id: companies.id }).from(companies);
  for (const company of allCompanies) {
    await syncCompanyDocuments(db, company.id).catch((err) =>
      logger.warn({ err, companyId: company.id }, "document-sync: company sync failed"),
    );
  }
}
