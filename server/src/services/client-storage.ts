// v3: manages per-client and per-project document folder creation in Drive or local FS.
// Each client gets: <companyRoot>/Clients/<ClientName>/_shared/
// Each project gets: <companyRoot>/Clients/<ClientName>/Projects/<ProjectName>/
// A documentSource is auto-created pointing to each folder so docs sync automatically.

import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { clients, projects, documentSources, instanceSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { createDriveFolder, getAuthenticatedDriveClient } from "./gdrive-auth.js";
import { logger } from "../middleware/logger.js";

const SINGLETON_KEY = "default";

// ── Company storage root ──────────────────────────────────────────────────────

export interface StorageRoot {
  localPath: string | null;
  driveFolderId: string | null;
}

export async function getCompanyStorageRoot(db: Db): Promise<StorageRoot> {
  const [row] = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .limit(1);
  const g = (row?.general ?? {}) as Record<string, unknown>;
  return {
    localPath: (g.storageRootLocalPath as string | null) ?? null,
    driveFolderId: (g.storageRootDriveFolderId as string | null) ?? null,
  };
}

export async function setCompanyStorageRoot(db: Db, root: StorageRoot): Promise<void> {
  const [existing] = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .limit(1);
  const general = {
    ...((existing?.general ?? {}) as Record<string, unknown>),
    storageRootLocalPath: root.localPath ?? null,
    storageRootDriveFolderId: root.driveFolderId ?? null,
  };
  if (existing) {
    await db
      .update(instanceSettings)
      .set({ general, updatedAt: new Date() })
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY));
  } else {
    await db.insert(instanceSettings).values({
      singletonKey: SINGLETON_KEY,
      general,
      experimental: {},
    });
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function ensureLocalDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
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

  const root = await getCompanyStorageRoot(db);
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
    const root = await getCompanyStorageRoot(db);
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
): Promise<void> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) return;

  try {
    if (client.localPath) {
      const destDir = path.join(client.localPath, "_shared", subdir);
      await ensureLocalDir(destDir);
      const dest = path.join(destDir, filename);
      await fs.copyFile(storagePath, dest);
      logger.info({ clientId, dest }, "client-storage: attachment filed locally");

    } else if (client.driveFolderId) {
      const drive = await getAuthenticatedDriveClient(db);
      if (!drive) return;
      const sharedId = await getOrCreateDriveSubfolder(db, client.driveFolderId, "_shared");
      const emailsId = await getOrCreateDriveSubfolder(db, sharedId, subdir);
      const content = await fs.readFile(storagePath);
      await drive.files.create({
        requestBody: { name: filename, parents: [emailsId] },
        media: { body: Buffer.from(content) },
        fields: "id",
      });
      logger.info({ clientId, filename }, "client-storage: attachment uploaded to Drive");
    }
  } catch (err) {
    logger.warn({ err, clientId, filename }, "client-storage: attachment filing failed");
  }
}
