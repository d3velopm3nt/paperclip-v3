import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { roomService } from "../services/rooms.js";
import { badRequest, notFound } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";

export function roomRoutes(db: Db) {
  const router = Router();
  const svc = roomService(db);

  router.get("/companies/:companyId/rooms", async (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json(await svc.list(req.params.companyId));
  });

  router.post("/companies/:companyId/rooms", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const body = req.body as { name?: string; slug?: string; description?: string; requireApproval?: boolean };
    if (!body.name) throw badRequest("name required");
    if (!body.slug) throw badRequest("slug required");
    const room = await svc.create(companyId, {
      name: body.name,
      slug: body.slug,
      description: body.description,
      requireApproval: body.requireApproval,
    });
    res.status(201).json(room);
  });

  router.get("/rooms/:id", async (req, res) => {
    const detail = await svc.getById(req.params.id);
    if (!detail) throw notFound("Room not found");
    assertCompanyAccess(req, detail.companyId);
    res.json(detail);
  });

  router.patch("/rooms/:id", async (req, res) => {
    const existing = await svc.getById(req.params.id);
    if (!existing) throw notFound("Room not found");
    assertCompanyAccess(req, existing.companyId);
    const body = req.body as { name?: string; slug?: string; description?: string; requireApproval?: boolean };
    const updated = await svc.update(req.params.id, body);
    res.json(updated);
  });

  router.delete("/rooms/:id", async (req, res) => {
    const existing = await svc.getById(req.params.id);
    if (!existing) throw notFound("Room not found");
    assertCompanyAccess(req, existing.companyId);
    await svc.remove(req.params.id);
    res.status(204).end();
  });

  router.post("/rooms/:id/members", async (req, res) => {
    const room = await svc.getById(req.params.id);
    if (!room) throw notFound("Room not found");
    assertCompanyAccess(req, room.companyId);
    const body = req.body as { agentId?: string; isOperator?: boolean; notifyOnMessage?: boolean };
    const member = await svc.addMember(req.params.id, body);
    res.status(201).json(member);
  });

  router.delete("/rooms/:id/members/:memberId", async (req, res) => {
    const room = await svc.getById(req.params.id);
    if (!room) throw notFound("Room not found");
    assertCompanyAccess(req, room.companyId);
    await svc.removeMember(req.params.memberId);
    res.status(204).end();
  });

  return router;
}
