import { Router } from "express";
import multer from "multer";
import type { Db } from "@paperclipai/db";
import { referenceDocuments } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { referenceDocumentsService } from "../services/reference-documents.js";
import { syncCompanyDocuments } from "../services/document-sync.js";
import { extractTextFromBuffer, computeChecksum } from "../services/document-extractor.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

export function referenceDocumentsRoutes(db: Db): Router {
  const router = Router();
  const svc = referenceDocumentsService(db);

  // List documents
  router.get("/companies/:companyId/documents", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const { projectId, scope, sourceType } = req.query as Record<string, string | undefined>;
    res.json(await svc.listDocuments(req.params.companyId, { projectId, scope, sourceType }));
  });

  // Get document metadata
  router.get("/companies/:companyId/documents/:docId", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const doc = await svc.getDocument(req.params.companyId, req.params.docId);
    if (!doc) { res.status(404).json({ error: "Not found" }); return; }
    res.json(doc);
  });

  // Get document content (extractedText)
  router.get("/companies/:companyId/documents/:docId/content", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const doc = await svc.getDocumentContent(req.params.companyId, req.params.docId);
    if (!doc) { res.status(404).json({ error: "Not found" }); return; }
    res.json(doc);
  });

  // Manual upload
  router.post(
    "/companies/:companyId/documents",
    upload.single("file"),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const file = req.file;
      if (!file) { res.status(400).json({ error: "file required" }); return; }

      const text = await extractTextFromBuffer(file.buffer, file.mimetype);
      const checksum = computeChecksum(file.buffer);
      const { scope, projectId } = req.body as { scope?: string; projectId?: string };

      const [row] = await db
        .insert(referenceDocuments)
        .values({
          companyId,
          title: file.originalname.replace(/\.[^.]+$/, ""),
          mimeType: file.mimetype,
          sourceType: "upload",
          extractedText: text?.slice(0, 50_000) ?? null,
          checksum,
          scope: (scope as "company" | "project") ?? "company",
          projectId: projectId ?? null,
          includeInContext: true,
          syncedAt: new Date(),
        })
        .returning();

      res.status(201).json(row);
    },
  );

  // Update document metadata
  router.patch("/companies/:companyId/documents/:docId", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const doc = await svc.updateDocument(req.params.companyId, req.params.docId, req.body);
    if (!doc) { res.status(404).json({ error: "Not found" }); return; }
    res.json(doc);
  });

  // Delete document
  router.delete("/companies/:companyId/documents/:docId", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    await svc.deleteDocument(req.params.companyId, req.params.docId);
    res.status(204).end();
  });

  // List sync sources
  router.get("/companies/:companyId/document-sources", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json(await svc.listSources(req.params.companyId));
  });

  // Add sync source
  router.post("/companies/:companyId/document-sources", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    const source = await svc.createSource(req.params.companyId, req.body);
    res.status(201).json(source);
  });

  // Delete sync source
  router.delete("/companies/:companyId/document-sources/:sourceId", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    await svc.deleteSource(req.params.companyId, req.params.sourceId);
    res.status(204).end();
  });

  // Trigger sync (fire-and-forget)
  router.post("/companies/:companyId/document-sources/sync", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ ok: true });
    syncCompanyDocuments(db, req.params.companyId).catch(() => {});
  });

  return router;
}
