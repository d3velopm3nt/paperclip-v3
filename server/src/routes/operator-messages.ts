import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { emailAccounts, operatorMessages } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { operatorMessagingService } from "../services/operator-messaging.js";

export function operatorMessageRoutes(db: Db) {
  const router = Router();

  // POST /api/companies/:companyId/operator-messages
  // Agents call this to send a message to the operator.
  router.post("/companies/:companyId/operator-messages", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const body = req.body as {
      body?: string;
      issueId?: string | null;
      roomId?: string | null;
      urgent?: boolean;
    };
    if (!body.body?.trim()) throw badRequest("body required");

    const actor = getActorInfo(req);
    if (!actor.agentId) throw badRequest("only agents can send operator messages via this endpoint");

    const [voiceAcct] = await db
      .select({ id: emailAccounts.id })
      .from(emailAccounts)
      .where(and(eq(emailAccounts.companyId, companyId), eq(emailAccounts.role, "agent_voice")))
      .limit(1);

    if (voiceAcct) {
      await operatorMessagingService(db).sendToOperator(
        companyId,
        voiceAcct.id,
        actor.agentId,
        body.body,
        body.issueId ?? null,
      );
    }

    res.status(201).json({ ok: true });
  });

  // GET /api/companies/:companyId/operator-messages
  router.get("/companies/:companyId/operator-messages", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const issueId = req.query.issueId as string | undefined;
    const roomId = req.query.roomId as string | undefined;

    const conditions: ReturnType<typeof eq>[] = [eq(operatorMessages.companyId, companyId)];
    if (issueId) conditions.push(eq(operatorMessages.issueId, issueId));
    if (roomId) conditions.push(eq(operatorMessages.roomId, roomId));

    const msgs = await db
      .select()
      .from(operatorMessages)
      .where(and(...conditions))
      .orderBy(desc(operatorMessages.createdAt))
      .limit(100);
    res.json(msgs);
  });

  // GET /api/rooms/:id/messages — thread for a room
  router.get("/rooms/:id/messages", async (req, res) => {
    const msgs = await db
      .select()
      .from(operatorMessages)
      .where(eq(operatorMessages.roomId, req.params.id))
      .orderBy(desc(operatorMessages.createdAt))
      .limit(100);
    res.json(msgs.reverse());
  });

  return router;
}
