// v3: manages per-client and per-project document folder creation in Drive or local FS.
// Each client gets: <companyRoot>/Clients/<ClientName>/_shared/
// Each project gets: <companyRoot>/Clients/<ClientName>/Projects/<ProjectName>/
// A documentSource is auto-created pointing to each folder so docs sync automatically.

import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { clients, projects, documentSources, companies, emailAttachments, emailMessages, operatorMessages } from "@paperclipai/db";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { createDriveFolder, getAuthenticatedDriveClient } from "./gdrive-auth.js";
import { notifyOperatorTelegram } from "./telegram-polling.js";
import { logger } from "../middleware/logger.js";

// ── Company storage root ──────────────────────────────────────────────────────

export interface StorageRoot {
  localPath: string | null;
  driveFolderId: string | null;
}

export async function getCompanyStorageRoot(db: Db, companyId: string): Promise<StorageRoot> {
  const [row] = await db
    .select({ storageLocalPath: companies.storageLocalPath, storageDriveFolderId: companies.storageDriveFolderId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  return {
    localPath: row?.storageLocalPath ?? null,
    driveFolderId: row?.storageDriveFolderId ?? null,
  };
}

export async function setCompanyStorageRoot(db: Db, companyId: string, root: StorageRoot): Promise<void> {
  await db.update(companies).set({
    storageLocalPath: root.localPath ?? null,
    storageDriveFolderId: root.driveFolderId ?? null,
    updatedAt: new Date(),
  }).where(eq(companies.id, companyId));
}

/** List all companies that have a storage root configured — for the "copy from" picker. */
export async function listCompaniesWithStorage(db: Db): Promise<Array<{ id: string; name: string; localPath: string | null; driveFolderId: string | null }>> {
  const rows = await db
    .select({ id: companies.id, name: companies.name, localPath: companies.storageLocalPath, driveFolderId: companies.storageDriveFolderId })
    .from(companies);
  return rows.filter((r) => r.localPath || r.driveFolderId);
}

export async function hasStorageRoot(db: Db, companyId: string): Promise<boolean> {
  const root = await getCompanyStorageRoot(db, companyId);
  return !!(root.localPath || root.driveFolderId);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function ensureLocalDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

// Paperclip never deletes local storage files or folders.
// This function exists to make that contract explicit — call it instead of fs.rm/unlink.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _neverDeleteLocalFile(_path: string): never {
  throw new Error("paperclip: local storage file deletion is disabled");
}

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() || "unnamed";
}

/** Gets a named subfolder ID in Drive, creating it if absent. */
async function getOrCreateDriveSubfolder(db: Db, parentId: string, name: string): Promise<string> {
  const drive = await getAuthenticatedDriveClient(db);
  if (!drive) throw new Error("Google Drive not authenticated");
  const safeN = name.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name = '${safeN}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id)",
    pageSize: 1,
  });
  const existing = res.data.files?.[0]?.id;
  if (existing) return existing;
  return createDriveFolder(db, name, parentId);
}

// ── Client folder ─────────────────────────────────────────────────────────────

/**
 * Creates <root>/Clients/<ClientName>/ and /_shared/ in Drive or local FS.
 * Stores the folder path/ID on the client row and creates a documentSource.
 * Safe to call multiple times — no-ops if already configured.
 */
export async function ensureClientFolder(db: Db, clientId: string): Promise<void> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) return;
  if (client.localPath || client.driveFolderId) return;

  const root = await getCompanyStorageRoot(db, client.companyId);
  const folderName = safeName(client.name);

  try {
    if (root.driveFolderId) {
      const clientsParentId = await getOrCreateDriveSubfolder(db, root.driveFolderId, "Clients");
      const clientFolderId = await createDriveFolder(db, folderName, clientsParentId);
      await createDriveFolder(db, "_shared", clientFolderId);

      await db.update(clients)
        .set({ driveFolderId: clientFolderId, updatedAt: new Date() })
        .where(eq(clients.id, clientId));
      await db.insert(documentSources).values({
        companyId: client.companyId,
        clientId: client.id,
        projectId: null,
        type: "gdrive",
        name: `${client.name} (client)`,
        driveFolderId: clientFolderId,
      });
      logger.info({ clientId, driveFolderId: clientFolderId }, "client-storage: Drive client folder created");

    } else if (root.localPath) {
      const clientDir = path.join(root.localPath, "Clients", folderName);
      await ensureLocalDir(path.join(clientDir, "_shared"));

      await db.update(clients)
        .set({ localPath: clientDir, updatedAt: new Date() })
        .where(eq(clients.id, clientId));
      await db.insert(documentSources).values({
        companyId: client.companyId,
        clientId: client.id,
        projectId: null,
        type: "local",
        name: `${client.name} (client)`,
        localPath: clientDir,
      });
      logger.info({ clientId, localPath: clientDir }, "client-storage: local client folder created");
    }
    // No root configured — skip silently; operator can set root later
  } catch (err) {
    logger.warn({ err, clientId }, "client-storage: client folder creation failed");
  }
}

// ── Project folder ────────────────────────────────────────────────────────────

/**
 * Creates Projects/<ProjectName>/ under the client folder (or company root).
 * Stores the folder path/ID on the project row and creates a documentSource.
 * Safe to call multiple times.
 */
export async function ensureProjectFolder(db: Db, projectId: string): Promise<void> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return;
  if (project.localPath || project.driveFolderId) return;

  const folderName = safeName(project.name);
  let parentDriveId: string | null = null;
  let parentLocalPath: string | null = null;

  if (project.clientId) {
    const [client] = await db.select().from(clients).where(eq(clients.id, project.clientId)).limit(1);
    if (client?.driveFolderId) {
      parentDriveId = await getOrCreateDriveSubfolder(db, client.driveFolderId, "Projects").catch(() => null);
    } else if (client?.localPath) {
      parentLocalPath = path.join(client.localPath, "Projects");
    }
  }

  if (!parentDriveId && !parentLocalPath) {
    const root = await getCompanyStorageRoot(db, project.companyId);
    if (root.driveFolderId) parentDriveId = root.driveFolderId;
    else if (root.localPath) parentLocalPath = path.join(root.localPath, "Projects");
  }

  try {
    if (parentDriveId) {
      const projectFolderId = await createDriveFolder(db, folderName, parentDriveId);
      await db.update(projects)
        .set({ driveFolderId: projectFolderId, updatedAt: new Date() })
        .where(eq(projects.id, projectId));
      await db.insert(documentSources).values({
        companyId: project.companyId,
        clientId: project.clientId ?? null,
        projectId: project.id,
        type: "gdrive",
        name: `${project.name} (project)`,
        driveFolderId: projectFolderId,
      });
      logger.info({ projectId, driveFolderId: projectFolderId }, "client-storage: Drive project folder created");

    } else if (parentLocalPath) {
      const projectDir = path.join(parentLocalPath, folderName);
      await ensureLocalDir(projectDir);
      await db.update(projects)
        .set({ localPath: projectDir, updatedAt: new Date() })
        .where(eq(projects.id, projectId));
      await db.insert(documentSources).values({
        companyId: project.companyId,
        clientId: project.clientId ?? null,
        projectId: project.id,
        type: "local",
        name: `${project.name} (project)`,
        localPath: projectDir,
      });
      logger.info({ projectId, localPath: projectDir }, "client-storage: local project folder created");
    }
  } catch (err) {
    logger.warn({ err, projectId }, "client-storage: project folder creation failed");
  }
}

// ── Email attachment filing ───────────────────────────────────────────────────

/**
 * Copies a local attachment file into the client's _shared/<subdir>/ folder.
 * Works for both Drive and local storage. Non-fatal — logs warn on failure.
 */
export async function fileAttachmentToClientFolder(
  db: Db,
  storagePath: string,
  filename: string,
  clientId: string,
  subdir = "emails",
  attachmentId?: string,
): Promise<void> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) return;

  let filedPath: string | null = null;
  try {
    if (client.localPath) {
      const destDir = path.join(client.localPath, "_shared", subdir);
      await ensureLocalDir(destDir);
      const dest = path.join(destDir, filename);
      await fs.copyFile(storagePath, dest);
      filedPath = dest;
      logger.info({ clientId, dest }, "client-storage: attachment filed locally");

    } else if (client.driveFolderId) {
      const drive = await getAuthenticatedDriveClient(db);
      if (!drive) return;
      const sharedId = await getOrCreateDriveSubfolder(db, client.driveFolderId, "_shared");
      const emailsId = await getOrCreateDriveSubfolder(db, sharedId, subdir);
      const content = await fs.readFile(storagePath);
      const result = await drive.files.create({
        requestBody: { name: filename, parents: [emailsId] },
        media: { body: Buffer.from(content) },
        fields: "id",
      });
      filedPath = result.data.id ? `drive:${result.data.id}` : `drive:${emailsId}/${filename}`;
      logger.info({ clientId, filename }, "client-storage: attachment uploaded to Drive");
    }

    // Record filing status on the attachment row
    if (filedPath && attachmentId) {
      await db.update(emailAttachments)
        .set({ filedAt: new Date(), filedPath })
        .where(eq(emailAttachments.id, attachmentId));
    }
  } catch (err) {
    logger.warn({ err, clientId, filename }, "client-storage: attachment filing failed");
  }
}

// ── Backfill ──────────────────────────────────────────────────────────────────

/**
 * Files all unfiled email attachments for a client into their storage folder.
 * Fire-and-forget safe — caller should not await in hot paths.
 */
export async function backfillClientAttachments(db: Db, clientId: string): Promise<void> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client || (!client.localPath && !client.driveFolderId)) return;

  const emails = await db
    .select({ id: emailMessages.id })
    .from(emailMessages)
    .where(eq(emailMessages.matchedClientId, clientId));

  if (emails.length === 0) return;
  const emailIds = emails.map((e) => e.id);

  const unfiled = await db
    .select()
    .from(emailAttachments)
    .where(and(inArray(emailAttachments.emailMessageId, emailIds), isNull(emailAttachments.filedAt)));

  for (const att of unfiled) {
    if (!att.storagePath) continue;
    await fileAttachmentToClientFolder(db, att.storagePath, att.filename, clientId, "emails", att.id);
  }
}

// ── Storage warning ───────────────────────────────────────────────────────────

const STORAGE_WARN_BODY = "No storage root configured. Use the set_storage_root MCP tool or reply with: set storage to <path>";

/**
 * Sends a Telegram notification to the operator if no storage root is configured.
 * Throttled to once per day per company — non-fatal.
 */
export async function notifyStorageNotConfigured(db: Db, companyId: string): Promise<void> {
  if (process.env.NODE_ENV === "test") return;
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [recent] = await db
    .select({ id: operatorMessages.id })
    .from(operatorMessages)
    .where(and(
      eq(operatorMessages.companyId, companyId),
      eq(operatorMessages.body, STORAGE_WARN_BODY),
      gte(operatorMessages.createdAt, oneDayAgo),
    ))
    .orderBy(desc(operatorMessages.createdAt))
    .limit(1);
  if (recent) return;

  try {
    await notifyOperatorTelegram(db, STORAGE_WARN_BODY);
    await db.insert(operatorMessages).values({
      companyId,
      direction: "outbound",
      platform: "telegram",
      source: "system",
      body: STORAGE_WARN_BODY,
    });
  } catch {
    // Non-fatal
  }
}
