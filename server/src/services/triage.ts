// v3: rule-based triage for inbound email. Decides whether to propose a
// create_issue plan (with a structured plan text the operator reviews) or
// ask the sender for more info via request_clarification. Returns proposal
// text, kind, confidence. Intended to be replaced by an LLM pass that reads
// the email + client history + agent capabilities later — the interface is
// stable so callers don't change.

import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companySkills, projects } from "@paperclipai/db";

export type TriageKind = "create_issue" | "request_clarification";

export interface TriageInput {
  companyId: string;
  emailMessageId: string;
  fromAddr: string;
  subject: string;
  body: string;
  attachmentCount: number;
  client: { id: string; name: string } | null;
  project: { id: string; name: string } | null;
}

export interface TriageResult {
  kind: TriageKind;
  confidence: "low" | "medium" | "high";
  proposalText: string;
  /** When kind === 'request_clarification', the plaintext body to send back. */
  clarificationText?: string;
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function matchSkills(subject: string, body: string, skills: { name: string; description: string | null }[]): string[] {
  const haystack = `${subject} ${body}`.toLowerCase();
  const matches: string[] = [];
  for (const s of skills) {
    const token = s.name.toLowerCase();
    if (!token) continue;
    if (haystack.includes(token)) matches.push(s.name);
    else if (s.description && haystack.includes(s.description.toLowerCase().slice(0, 20))) {
      matches.push(s.name);
    }
  }
  return matches.slice(0, 5);
}

export function triageService(db: Db) {
  async function triageEmail(input: TriageInput): Promise<TriageResult> {
    const bodyWords = wordCount(input.body);
    const subjectWords = wordCount(input.subject);
    // Very thin email + no attachments → ask for more info before creating work.
    const enoughSignal =
      input.attachmentCount > 0 || bodyWords >= 20 || (bodyWords >= 8 && subjectWords >= 4);

    const [companyAgents, skills] = await Promise.all([
      db
        .select({ id: agents.id, name: agents.name, role: agents.role, capabilities: agents.capabilities })
        .from(agents)
        .where(eq(agents.companyId, input.companyId)),
      db
        .select({ name: companySkills.name, description: companySkills.description })
        .from(companySkills)
        .where(eq(companySkills.companyId, input.companyId)),
    ]);

    const matchedSkills = matchSkills(input.subject, input.body, skills);
    const agentsByRole = new Map<string, typeof companyAgents>();
    for (const a of companyAgents) {
      const list = agentsByRole.get(a.role) ?? [];
      list.push(a);
      agentsByRole.set(a.role, list);
    }
    const agentSummary = [...agentsByRole.entries()]
      .map(([role, list]) => `${role}: ${list.map((a) => a.name).join(", ")}`)
      .join(" | ");

    if (!enoughSignal) {
      const clarificationText = [
        `Hi,`,
        ``,
        `Thanks for reaching out. Before we get started, could you share a little more detail so we can help you fastest:`,
        ``,
        `  • What outcome are you hoping for?`,
        `  • Any deadline or budget constraints?`,
        `  • Existing materials (documents, links, examples) you can attach?`,
        ``,
        `Looking forward to your reply.`,
      ].join("\n");

      const proposalText = [
        `PROPOSED PLAN — Ask sender for more information`,
        ``,
        `Reason: inbound email is too thin (${bodyWords} words, ${input.attachmentCount} attachments) to confidently scope work.`,
        `Client: ${input.client?.name ?? "(unknown — not matched)"}`,
        `Project: ${input.project?.name ?? "(none)"}`,
        ``,
        `Draft reply:`,
        clarificationText.split("\n").map((l) => `  ${l}`).join("\n"),
        ``,
        `Approve to send this reply from the inbox that received the message.`,
      ].join("\n");

      return {
        kind: "request_clarification",
        confidence: "low",
        proposalText,
        clarificationText,
      };
    }

    const confidence: TriageResult["confidence"] =
      input.client && input.project ? "high" : input.client ? "medium" : "low";

    const proposalText = [
      `PROPOSED PLAN — Create issue and route to agents`,
      ``,
      `Summary: ${input.subject || "(no subject)"}`,
      `Client: ${input.client?.name ?? "(unknown — not matched to any client)"}`,
      `Project: ${input.project?.name ?? "(none — will be linked after operator picks one)"}`,
      `Confidence: ${confidence}`,
      ``,
      `Approach:`,
      `  1. Create a tracked issue linked to client/project above.`,
      `  2. Triage owner reviews the email and routes to the right agent.`,
      `  3. Agent executes using matched skills (listed below) and reports back.`,
      ``,
      `Matched skills: ${matchedSkills.length ? matchedSkills.join(", ") : "(none matched — triage agent picks)"}`,
      `Available agents: ${agentSummary || "(none)"}`,
      ``,
      `Source: inbound email from ${input.fromAddr} — ${input.attachmentCount} attachments.`,
      `Issue body will reference the email; full content stays in /email/inbox.`,
    ].join("\n");

    return {
      kind: "create_issue",
      confidence,
      proposalText,
    };
  }

  return { triageEmail };
}

// Unused helpers exported for symmetry; routeInbound composes its own fetches
// but this lets callers build a triage input without coupling to the schema.
export async function findSingleActiveProject(
  db: Db,
  clientId: string,
): Promise<{ id: string; name: string } | null> {
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.clientId, clientId), isNull(projects.archivedAt)))
    .limit(2);
  if (rows.length === 1) return rows[0]!;
  return null;
}
