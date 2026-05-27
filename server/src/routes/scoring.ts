// v3: scoring routes — submit and list agent scores
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest } from "../errors.js";
import { scoringService } from "../services/scoring.js";

export function scoringRoutes(db: Db) {
  const router = Router();
  const svc = scoringService(db);

  // POST /api/agents/:agentId/scores
  router.post("/agents/:agentId/scores", async (req, res) => {
    const { agentId } = req.params;
    const { score, planId, issueId, comment } = req.body as {
      score?: number;
      planId?: string;
      issueId?: string;
      comment?: string;
    };

    if (!score || score < 1 || score > 5) {
      throw badRequest("score must be 1-5");
    }

    if (!req.actor.userId) {
      throw badRequest("User ID required");
    }

    const result = await svc.createScore({
      agentId,
      planId,
      issueId,
      scoredByUserId: req.actor.userId,
      score,
      comment,
    });

    res.status(201).json(result);
  });

  // GET /api/agents/:agentId/scores
  router.get("/agents/:agentId/scores", async (req, res) => {
    const { agentId } = req.params;
    const scores = await svc.listScoresForAgent(agentId);
    res.json(scores);
  });

  return router;
}
