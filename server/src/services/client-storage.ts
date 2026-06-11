// v3: manages per-client and per-project document folder creation in Drive or local FS.
// Each client gets: <companyRoot>/Clients/<ClientName>/Emails/
// Each project gets: <companyRoot>/Clients/<ClientName>/Projects/<ProjectName>/Emails/ + Issues/
// A documentSource is auto-created pointing to each folder so docs sync automatically.

import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { clients, projects, documentSources, companies, emailAttachments, emailMessages, operatorMessages } from "@paperclipai/db";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { createDriveFolder, getAuthenticatedDriveClient } from "./gdrive-auth.js";
import { notifyOperator } from "./telegram-polling.js";
import { logger } from "../middleware/logger.js";

// ── Company storage root ──────────────────────────────────────────────────────

export interface StorageRoot {
  localPath: string | null;
  driveFolderId: string | null;
}

/**
 * Extracts the bare Drive folder ID from values that may have been stored as
 * full google-drive:// URLs (e.g. "google-drive://user@gmail.com/root/a/b/folderId").
 * The Drive API only accepts the bare folder ID as a parent.
 */
function normalizeDriveFolderId(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("google-drive:")) {
    const segments = value.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? null;
  }
  return value;
}

export async function getCompanyStorageRoot(db: Db, companyId: string): Promise<StorageRoot> {
  const [row] = await db
    .select({ storageLocalPath: companies.storageLocalPath, storageDriveFolderId: companies.storageDriveFolderId })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);

  const rawLocal = row?.storageLocalPath ?? null;
  const rawDrive = row?.storageDriveFolderId ?? null;

  // If storageLocalPath was incorrectly set to a google-drive: URL, treat it as the Drive folder ID.
  // This happens when old UI code saved the Drive URL into the local path field.
  if (rawLocal?.startsWith("google-drive:")) {
    // Heal the DB in the background — swap the value into the correct column
    db.update(companies)
      .set({ storageLocalPath: null, storageDriveFolderId: rawDrive ?? rawLocal, updatedAt: new Date() })
      .where(eq(companies.id, companyId))
      .catch(() => {});
    return {
      localPath: null,
      driveFolderId: normalizeDriveFolderId(rawDrive ?? rawLocal),
    };
  }

  return {
    localPath: rawLocal,
    driveFolderId: normalizeDriveFolderId(rawDrive),
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
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const existing = res.data.files?.[0]?.id;
  if (existing) return existing;
  return createDriveFolder(db, name, parentId);
}

// ── Client folder ─────────────────────────────────────────────────────────────

/**
 * Creates <root>/Clients/<ClientName>/Emails/ in Drive or local FS.
 * Stores the folder path/ID on the client row and creates a documentSource.
 * Safe to call multiple times — no-ops if already configured.
 */
export async function ensureClientFolder(db: Db, clientId: string): Promise<void> {
  let [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) return;

  // Detect bogus localPath — a google-drive:// URL stored as a local path.
  // Clear it so we fall through and create the proper Drive folder structure.
  if (client.localPath?.startsWith("google-drive:")) {
    await db.update(clients).set({ localPath: null, updatedAt: new Date() }).where(eq(clients.id, clientId));
    client = { ...client, localPath: null };
    logger.warn({ clientId }, "client-storage: cleared bogus google-drive: localPath, will re-create Drive folder");
  }

  // If localPath already set, just ensure the directory exists on disk (handles
  // cases where the folder was deleted or storage root moved after initial setup).
  if (client.localPath) {
    await ensureLocalDir(path.join(client.localPath, "Emails")).catch(() => {});
    return;
  }
  if (client.driveFolderId) return;

  const root = await getCompanyStorageRoot(db, client.companyId);
  const folderName = safeName(client.name);

  try {
    if (root.driveFolderId) {
      logger.info({ clientId, rootFolderId: root.driveFolderId, folderName }, "client-storage: creating Drive client folder");
      const clientsParentId = await getOrCreateDriveSubfolder(db, root.driveFolderId, "Clients");
      logger.info({ clientId, clientsParentId }, "client-storage: got Clients folder");
      const clientFolderId = await createDriveFolder(db, folderName, clientsParentId);
      logger.info({ clientId, clientFolderId }, "client-storage: created client folder");
      await createDriveFolder(db, "Emails", clientFolderId);

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
      await ensureLocalDir(path.join(clientDir, "Emails"));

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
    if (!root.localPath && !root.driveFolderId) {
      logger.debug({ clientId, companyId: client.companyId }, "client-storage: no storage root configured, skipping folder creation");
    }
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

  // If localPath already set (and not a bogus google-drive: value), ensure subdirs exist on disk.
  if (project.localPath && !project.localPath.startsWith("google-drive:")) {
    await Promise.all([
      ensureLocalDir(path.join(project.localPath, "Emails")).catch(() => {}),
      ensureLocalDir(path.join(project.localPath, "Issues")).catch(() => {}),
    ]);
    return;
  }
  if (project.driveFolderId) return;

  const folderName = safeName(project.name);
  let parentDriveId: string | null = null;
  let parentLocalPath: string | null = null;

  if (project.clientId) {
    const [client] = await db.select().from(clients).where(eq(clients.id, project.clientId)).limit(1);
    if (client?.driveFolderId) {
      parentDriveId = await getOrCreateDriveSubfolder(db, client.driveFolderId, "Projects").catch(() => null);
    } else if (client?.localPath && !client.localPath.startsWith("google-drive:")) {
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
      await Promise.all([
        createDriveFolder(db, "Emails", projectFolderId),
        createDriveFolder(db, "Issues", projectFolderId),
      ]);
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
      await ensureLocalDir(path.join(projectDir, "Emails"));
      await ensureLocalDir(path.join(projectDir, "Issues"));
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
 * Copies a local attachment file into the client's Emails/ folder.
 * Works for both Drive and local storage. Non-fatal — logs warn on failure.
 */
export async function fileAttachmentToClientFolder(
  db: Db,
  storagePath: string,
  filename: string,
  clientId: string,
  _subdirDeprecated = "Emails",
  attachmentId?: string,
): Promise<void> {
  let [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) return;

  // If no valid storage configured yet, create the folder now before trying to upload.
  const hasValidLocal = client.localPath && !client.localPath.startsWith("google-drive:");
  if (!hasValidLocal && !client.driveFolderId) {
    await ensureClientFolder(db, clientId).catch((err) =>
      logger.warn({ err, clientId }, "client-storage: ensureClientFolder failed before filing"),
    );
    const [refreshed] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    if (!refreshed) return;
    client = refreshed;
  }

  let filedPath: string | null = null;
  try {
    if (client.localPath && !client.localPath.startsWith("google-drive:")) {
      const destDir = path.join(client.localPath, "Emails");
      await ensureLocalDir(destDir);
      const dest = path.join(destDir, filename);
      await fs.copyFile(storagePath, dest);
      filedPath = dest;
      logger.info({ clientId, dest }, "client-storage: attachment filed locally");

    } else if (client.driveFolderId) {
      const drive = await getAuthenticatedDriveClient(db);
      if (!drive) return;
      const emailsId = await getOrCreateDriveSubfolder(db, client.driveFolderId, "Emails");
      const result = await drive.files.create({
        requestBody: { name: filename, parents: [emailsId] },
        media: { body: createReadStream(storagePath) },
        fields: "id",
        supportsAllDrives: true,
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
  // Ensure folder exists — handles case where storage root was added after client was created
  await ensureClientFolder(db, clientId);

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
    await fileAttachmentToClientFolder(db, att.storagePath, att.filename, clientId, "Emails", att.id);
  }
}

/**
 * Copies a local attachment file into a project's Emails/ folder.
 * Works for both Drive and local storage. Non-fatal — logs warn on failure.
 */
export async function fileAttachmentToProjectFolder(
  db: Db,
  storagePath: string,
  filename: string,
  projectId: string,
  subfolder: "Emails" | "Issues" = "Emails",
  attachmentId?: string,
): Promise<void> {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) return;

  let filedPath: string | null = null;
  try {
    if (project.localPath) {
      const destDir = path.join(project.localPath, subfolder);
      await ensureLocalDir(destDir);
      const dest = path.join(destDir, filename);
      await fs.copyFile(storagePath, dest);
      filedPath = dest;
      logger.info({ projectId, dest }, "client-storage: attachment filed to project folder");

    } else if (project.driveFolderId) {
      const drive = await getAuthenticatedDriveClient(db);
      if (!drive) return;
      const folderId = await getOrCreateDriveSubfolder(db, project.driveFolderId, subfolder);
      const result = await drive.files.create({
        requestBody: { name: filename, parents: [folderId] },
        media: { body: createReadStream(storagePath) },
        fields: "id",
        supportsAllDrives: true,
      });
      filedPath = result.data.id ? `drive:${result.data.id}` : `drive:${folderId}/${filename}`;
      logger.info({ projectId, filename }, "client-storage: attachment uploaded to project Drive folder");
    }

    if (filedPath && attachmentId) {
      await db.update(emailAttachments)
        .set({ filedAt: new Date(), filedPath })
        .where(eq(emailAttachments.id, attachmentId));
    }
  } catch (err) {
    logger.warn({ err, projectId, filename }, "client-storage: project attachment filing failed");
  }
}

// ── Storage warning ───────────────────────────────────────────────────────────

const STORAGE_WARN_BODY = "No storage root configured. Use the set_storage_root MCP tool or reply with: set storage to <path>";

// In-process guard: prevents concurrent email ingest from firing multiple
// simultaneous Telegram sends before the DB dedup record has been written.
const storageWarnInFlight = new Set<string>();

/**
 * Sends a Telegram notification to the operator if no storage root is configured.
 * Throttled to once per day per company — non-fatal.
 */
export async function notifyStorageNotConfigured(db: Db, companyId: string): Promise<void> {
  if (process.env.NODE_ENV === "test") return;
  // Synchronous guard prevents concurrent calls from all passing the DB check
  // before any of them has written the dedup record.
  if (storageWarnInFlight.has(companyId)) return;
  storageWarnInFlight.add(companyId);
  try {
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

    // Insert the dedup record BEFORE sending so a crash/rejection after send
    // still prevents a retry within the same day.
    await db.insert(operatorMessages).values({
      companyId,
      direction: "outbound",
      platform: "telegram",
      source: "system",
      body: STORAGE_WARN_BODY,
    });
    await notifyOperator(db, STORAGE_WARN_BODY, "high_risk_detected");
  } catch {
    // Non-fatal
  } finally {
    storageWarnInFlight.delete(companyId);
  }
}
