// server/src/routes/mcp-tool-server.ts
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agents, agentMemories, issues, projects, activityLog, emailMessages, emailAttachments, emailAccounts, clients, contacts, issueComments, approvals, operatorMessages, instanceSettings, companies, workflowRuns, workflowStageResults, memoryItems, topics, topicIssues, blockedSenderDomains } from "@paperclipai/db";
import { and, desc, eq, gte, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { verifyMcpToken } from "../services/mcp-session-token.js";
import { heartbeatService } from "../services/index.js";
import { issueService } from "../services/issues.js";
import { topicsService } from "../services/topics.js";
import { eaConversationsService } from "../services/ea-conversations.js";
import type { ConversationMessage } from "../services/ea-conversations.js";
import { eaAgentsService } from "../services/ea-agents.js";
import { planGateService } from "../services/plan-gate.js";
import { logActivity } from "../services/activity-log.js";
import { logger } from "../middleware/logger.js";
import { sendTelegramMessage } from "../services/telegram-adapter.js";
import { notifyOperator } from "../services/telegram-polling.js";
import { sendWhatsAppMessage } from "../services/whatsapp-adapter.js";
import { readInstanceToken } from "../services/instance-token-store.js";
import {
  setCompanyStorageRoot,
  ensureClientFolder,
  ensureProjectFolder,
  backfillClientAttachments,
} from "../services/client-storage.js";
import { clientService } from "../services/clients.js";
import { contactService } from "../services/contacts.js";
import { routineService } from "../services/routines.js";
import { sendEmailFromAccount } from "../services/email-sender.js";

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

function ok(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function err(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function textContent(text: string) {
  return { content: [{ type: "text", text }] };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "list_issues",
    description: "List issues for a company. Filter by status, priority, or assignee agent. As operator you have cross-company access — pass companyId to query a specific company.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "UUID of the company to query. Required when querying a company other than the default." },
        status: { type: "string", description: "Filter by status: backlog|todo|in_progress|in_review|done|cancelled" },
        priority: { type: "string", description: "Filter by priority: critical|high|medium|low" },
        limit: { type: "number", description: "Max results (default 20, max 50)" },
      },
    },
  },
  {
    name: "create_issue",
    description: "Create a new issue. Returns the created issue with its identifier (e.g. PAP-042). Pass companyId to create in a specific company.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        companyId: { type: "string", description: "UUID of the company. Required when creating in a company other than the default." },
        title: { type: "string", description: "Issue title" },
        description: { type: "string", description: "Issue description" },
        priority: { type: "string", description: "critical|high|medium|low (default: medium)" },
        status: { type: "string", description: "backlog|todo|in_progress (default: backlog)" },
        projectId: { type: "string", description: "UUID of project to assign to" },
        assigneeAgentId: { type: "string", description: "UUID of agent to assign to" },
      },
    },
  },
  {
    name: "update_issue",
    description: "Update an existing issue's status, priority, or assignee.",
    inputSchema: {
      type: "object",
      required: ["issueId"],
      properties: {
        issueId: { type: "string", description: "UUID of the issue to update" },
        status: { type: "string", description: "New status" },
        priority: { type: "string", description: "New priority" },
        assigneeAgentId: { type: "string", description: "New assignee agent UUID, or null to unassign" },
        title: { type: "string", description: "New title" },
        description: { type: "string", description: "New description" },
      },
    },
  },
  {
    name: "list_agents",
    description: "List all agents in a company with their current status and role. Pass companyId to query a specific company.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "UUID of the company to query." },
        status: { type: "string", description: "Filter by status: active|idle|paused|error|terminated" },
      },
    },
  },
  {
    name: "list_projects",
    description: "List all projects in a company. Pass companyId to query a specific company.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "UUID of the company to query." },
      },
    },
  },
  {
    name: "get_activity",
    description: "Get recent activity log entries for this company.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max entries (default 20, max 50)" },
        agentId: { type: "string", description: "Filter by agent UUID" },
      },
    },
  },
  {
    name: "search_emails",
    description: "Search inbound emails across all companies (operator) or this company (agent). Filter by sender, subject keyword, processing state, or date. Optionally pass companyId to narrow to one company.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "UUID of a specific company to narrow results to. Omit to search all companies (operator only)." },
        from: { type: "string", description: "Filter by sender address (partial match)" },
        subject: { type: "string", description: "Filter by subject line (partial match)" },
        state: { type: "string", description: "Filter by processing state: pending|analyzing|plan_proposed|clarifying|approved|declined|executed|ignored|error" },
        since: { type: "string", description: "ISO 8601 datetime — only emails received after this (e.g. 2025-01-01T00:00:00Z)" },
        limit: { type: "number", description: "Max results (default 20, max 50)" },
      },
    },
  },
  {
    name: "get_email",
    description: "Get full details of a single email: body, headers, processing state, matched agent/client, and attachment list. Pass companyId to access email from a specific company (operator only).",
    inputSchema: {
      type: "object",
      required: ["emailId"],
      properties: {
        companyId: { type: "string", description: "UUID of the company this email belongs to. Required when accessing email from a company other than the default." },
        emailId: { type: "string", description: "UUID of the email message" },
      },
    },
  },
  {
    name: "list_email_attachments",
    description: "List all attachments for an email message, including filename, MIME type, size in bytes, storage paths, and whether it is inline. Pass companyId to access email from a specific company (operator only).",
    inputSchema: {
      type: "object",
      required: ["emailId"],
      properties: {
        companyId: { type: "string", description: "UUID of the company this email belongs to. Required when accessing email from a company other than the default." },
        emailId: { type: "string", description: "UUID of the email message" },
      },
    },
  },
  {
    name: "list_clients",
    description: "List clients for a company. Returns names, email domains, and extra contact addresses. Pass companyId to query a specific company.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "UUID of the company to query." },
        name: { type: "string", description: "Filter by client name (partial match)" },
      },
    },
  },
  {
    name: "search_contacts",
    description: "Search contacts (individual people) by name or email. Call this FIRST when the operator mentions a person by name to get their email address. Pass companyId to query a specific company.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "UUID of the company to query." },
        query: { type: "string", description: "First name, last name, or email address (partial match). Omit to list all contacts." },
      },
    },
  },
  {
    name: "update_contact",
    description: "Save or update a contact's name and details. Use this when the operator tells you who an unnamed contact is (e.g. 'That is Kevin O Neill, Sales Manager'). Returns the updated contact.",
    inputSchema: {
      type: "object",
      required: ["contactId"],
      properties: {
        contactId: { type: "string", description: "UUID of the contact to update" },
        firstName: { type: "string", description: "First name" },
        lastName: { type: "string", description: "Last name" },
        phone: { type: "string", description: "Phone number (optional)" },
        role: { type: "string", description: "Job title or role (optional)" },
        notes: { type: "string", description: "Notes about this contact (optional)" },
      },
    },
  },
  {
    name: "create_plan",
    description: "Create a plan for operator approval. Two modes: (1) issue-linked: pass issueId to propose work on an existing issue; (2) email-sourced: pass emailMessageId (no issueId) to propose creating a new issue from an inbound email — used by the EA triage flow. Returns planId and approvalId.",
    inputSchema: {
      type: "object",
      required: ["proposalText"],
      properties: {
        issueId: { type: "string", description: "UUID of an existing issue this plan addresses. Omit when proposing issue creation from an email." },
        emailMessageId: { type: "string", description: "UUID of the source email_messages row. Required when proposing issue creation (no issueId). The EA triage flow passes this." },
        title: { type: "string", description: "Proposed issue title (used when kind=create_issue without an existing issue)" },
        proposalText: { type: "string", description: "Full human-readable plan shown to operator for approval" },
        assigneeAgentId: { type: "string", description: "UUID of the specialist agent to assign the new issue to on approval" },
        steps: { type: "array", items: { type: "string" }, description: "Ordered list of plan steps (optional, rendered inside proposalText)" },
      },
    },
  },
  {
    name: "add_issue_comment",
    description: "Add a comment to an issue. Use for progress updates, agent questions, or blocking reasons.",
    inputSchema: {
      type: "object",
      required: ["issueId", "body"],
      properties: {
        issueId: { type: "string" },
        body: { type: "string", description: "Comment body (markdown supported)" },
      },
    },
  },
  {
    name: "create_project",
    description: "Create a new project. Pass companyId to create in a specific company.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        companyId: { type: "string", description: "UUID of the company. Required when creating in a company other than the default." },
        name: { type: "string" },
        description: { type: "string" },
        clientId: { type: "string", description: "UUID of client to associate" },
        status: { type: "string", description: "backlog|active (default: backlog)" },
      },
    },
  },
  {
    name: "notify_operator",
    description: "Send an immediate notification to the operator via Telegram (or store in-app if Telegram not configured). Use for alerts, updates, and questions that don't need a formal approval.",
    inputSchema: {
      type: "object",
      required: ["body"],
      properties: {
        body: { type: "string", description: "Message text to send to operator" },
        issueId: { type: "string", description: "Optional — attaches message to this issue thread" },
      },
    },
  },
  {
    name: "send_operator_email",
    description: "Send an HTML email to the operator (company owner). Use for daily briefs, reports, and routine outputs that should be delivered as a nicely formatted email. The email is sent immediately — no approval required.",
    inputSchema: {
      type: "object",
      required: ["subject", "html"],
      properties: {
        subject: { type: "string", description: "Email subject line" },
        html: { type: "string", description: "Full HTML body of the email" },
        text: { type: "string", description: "Optional plain-text fallback body" },
      },
    },
  },
  {
    name: "send_client_reply",
    description: "Prepare an outbound reply to a client. Creates a 'client_reply' approval for operator review (unless approval is disabled in settings). The message is NOT sent until the operator approves it. Returns the approval ID.",
    inputSchema: {
      type: "object",
      required: ["clientId", "body", "channel"],
      properties: {
        clientId: { type: "string", description: "UUID of the client to reply to" },
        body: { type: "string", description: "Full message body to send to the client" },
        channel: { type: "string", description: "email | whatsapp — channel to use for sending" },
        threadKey: { type: "string", description: "Reply-to thread key (email Message-ID or WhatsApp phone number)" },
        issueId: { type: "string", description: "Optional issue this reply relates to" },
        subject: { type: "string", description: "Email subject (only for email channel)" },
      },
    },
  },
  {
    name: "set_issue_blocked",
    description: "Mark an issue as blocked and add a comment explaining why. Automatically notifies the operator via Telegram.",
    inputSchema: {
      type: "object",
      required: ["issueId", "reason"],
      properties: {
        issueId: { type: "string" },
        reason: { type: "string", description: "Why the issue is blocked — shown in the comment and operator notification" },
      },
    },
  },
  {
    name: "get_client",
    description: "Get details for a specific client: name, email domain, extra emails, open issues, and storage info.",
    inputSchema: {
      type: "object",
      required: ["clientId"],
      properties: {
        clientId: { type: "string" },
      },
    },
  },
  {
    name: "get_issue_plans",
    description: "Get all plans/approvals for an issue, including their proposal text and current status (pending/approved/declined).",
    inputSchema: {
      type: "object",
      required: ["issueId"],
      properties: {
        issueId: { type: "string", description: "UUID of the issue" },
      },
    },
  },
  {
    name: "get_issue_comments",
    description: "Get all comments for an issue in chronological order. Useful for reading the full activity thread on an issue.",
    inputSchema: {
      type: "object",
      required: ["issueId"],
      properties: {
        issueId: { type: "string", description: "UUID of the issue" },
      },
    },
  },
  {
    name: "list_issue_emails",
    description: "List emails linked to an issue. Returns sender, subject, body preview, and attachment file paths on disk so the agent can read them directly.",
    inputSchema: {
      type: "object",
      required: ["issueId"],
      properties: {
        issueId: { type: "string", description: "UUID of the issue" },
      },
    },
  },
  {
    name: "get_email_message",
    description: "Read a single inbound email by ID. Returns sender, subject, body, attachments, and the thread history for any prior emails in the same thread. Also returns existingIssueId if any thread email is already linked to an issue — use this to detect reply threads before creating a new issue.",
    inputSchema: {
      type: "object",
      required: ["emailMessageId"],
      properties: {
        emailMessageId: { type: "string", description: "UUID of the email_messages row" },
      },
    },
  },
  {
    name: "get_issue_context",
    description: "Read full context for an existing issue: the issue record, all comments, and all linked emails (with attachments). Use when a reply email arrives with an existingIssueId to understand prior history before adding a comment.",
    inputSchema: {
      type: "object",
      required: ["issueId"],
      properties: {
        issueId: { type: "string", description: "UUID of the issue" },
      },
    },
  },
  {
    name: "list_companies",
    description: "List all companies you have access to. Returns id, name, and slug for each. Use the id to query issues, clients, or projects for a specific company.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_topics",
    description: "List all EA topics (memory boxes). Use to see active workstreams across companies.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status: active|archived. Default: active" },
      },
    },
  },
  {
    name: "create_topic",
    description: "Create a new EA topic. REQUIRES prior operator approval — always call notify_operator first, wait for JayJay's confirmation in a subsequent message before calling this.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Topic name (e.g. 'SafeX Proposal', 'Finance')" },
        companyId: { type: "string", description: "UUID of the company this topic belongs to. Omit for cross-company topics." },
      },
    },
  },
  {
    name: "update_topic_memory",
    description: "Update a topic's markdown memory content and/or current state summary.",
    inputSchema: {
      type: "object",
      required: ["topicId"],
      properties: {
        topicId: { type: "string", description: "UUID of the topic" },
        summary: { type: "string", description: "Full markdown memory content for the topic" },
        currentState: { type: "string", description: "Short single-line status (e.g. 'Awaiting contract sign-off')" },
      },
    },
  },
  {
    name: "link_issue_to_topic",
    description: "Link an existing issue to an EA topic so it appears in the topic's context panel.",
    inputSchema: {
      type: "object",
      required: ["topicId", "issueId"],
      properties: {
        topicId: { type: "string", description: "UUID of the topic" },
        issueId: { type: "string", description: "UUID of the issue to link" },
      },
    },
  },
  {
    name: "resolve_conversation",
    description:
      "REQUIRED on every EA message. After matching a topic, call this to resolve or create the active conversation for that topic. Returns conversationId, runId, topic memory, and expiry info. Pass the returned runId to complete_conversation_turn at the end.",
    inputSchema: {
      type: "object",
      required: ["topicId"],
      properties: {
        topicId: { type: "string", description: "UUID of the matched topic" },
        messagePreview: { type: "string", description: "First 300 chars of the inbound message (for workflow log)" },
      },
    },
  },
  {
    name: "extend_conversation",
    description:
      "Extend an active conversation by 14 more days. Use when warningDays < 3 and JayJay confirms he wants to continue.",
    inputSchema: {
      type: "object",
      required: ["conversationId"],
      properties: {
        conversationId: { type: "string", description: "UUID of the conversation to extend" },
      },
    },
  },
  {
    name: "complete_conversation_turn",
    description:
      "REQUIRED at the end of every EA message. Records final workflow stages and marks the run as passed.",
    inputSchema: {
      type: "object",
      required: ["runId"],
      properties: {
        runId: { type: "string", description: "runId returned by resolve_conversation" },
        actionSummary: { type: "string", description: "One-line summary of what you did this turn (e.g. 'Notified operator, linked issue PC-12')" },
        issuesLinked: { type: "boolean", description: "true if link_issue_to_topic was called this turn" },
      },
    },
  },
  {
    name: "approve_plan",
    description: "Approve or decline a pending plan approval on JayJay's behalf. Approved plans move the issue to in_progress and wake the assignee agent. Use when JayJay says 'approve', 'go ahead', 'decline', etc.",
    inputSchema: {
      type: "object",
      required: ["approvalId"],
      properties: {
        approvalId: { type: "string", description: "UUID of the plan approval to resolve" },
        approved: { type: "boolean", description: "true to approve, false to decline (default: true)" },
        decisionNote: { type: "string", description: "Optional note explaining the decision" },
      },
    },
  },
  {
    name: "update_memory",
    description:
      "Store a persistent memory fact for future conversations. Call when you learn something worth remembering: client preferences, project states, JayJay's patterns, key decisions. Call BEFORE complete_conversation_turn.",
    inputSchema: {
      type: "object",
      required: ["title", "content", "category"],
      properties: {
        title: { type: "string", description: "Short memory title (e.g. 'Kevin O Neill is main InnoTrack contact')" },
        content: { type: "string", description: "Full memory content — specific and actionable" },
        category: { type: "string", description: "pattern | preference | decision | learning | feedback" },
        companyId: { type: "string", description: "Company UUID this memory belongs to. Defaults to current company context." },
      },
    },
  },
  {
    name: "search_memory",
    description: "Search memory items for prior messages, context, or sender history. Use before classifying a new message to understand sender relationship and prior interactions.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Full-text search query" },
        senderIdentifier: { type: "string", description: "Filter by sender email/phone/telegram user" },
        companyId: { type: "string", description: "Filter by company UUID" },
        channel: { type: "string", description: "Filter by channel: email | whatsapp | telegram | manual" },
        memoryType: { type: "string", description: "passive | active | all (default: all)" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
  },
  {
    name: "create_memory",
    description: "Store a message or context in memory. Use memoryType='passive' for low-importance items. Use memoryType='active' when creating operational context alongside an issue.",
    inputSchema: {
      type: "object",
      required: ["content", "sourceChannel", "memoryType"],
      properties: {
        content: { type: "string" },
        summary: { type: "string" },
        sourceChannel: { type: "string", description: "email | whatsapp | telegram | manual" },
        sourceId: { type: "string" },
        sourceEmailMessageId: { type: "string" },
        senderIdentifier: { type: "string" },
        companyId: { type: "string" },
        intentCategory: { type: "string" },
        importanceScore: { type: "number", description: "0-100" },
        memoryType: { type: "string", description: "passive | active" },
        tags: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "search_topics",
    description: "Search existing topics. Always check before creating a new topic to avoid duplicates. Topics group related issues under one business context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search name and summary" },
        companyId: { type: "string" },
        status: { type: "string", description: "active | archived | all (default: active)" },
        limit: { type: "number", description: "Max results (default 20)" },
      },
    },
  },
  {
    name: "create_topic",
    description: "Create a new topic (active memory container). A topic groups related issues under one business context (e.g. 'SafeX Proposal', 'Kevin — Teaming Agreement').",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        summary: { type: "string" },
        currentState: { type: "string" },
        companyId: { type: "string" },
      },
    },
  },
  {
    name: "link_topic_to_issue",
    description: "Link a topic to an issue. Topics can have multiple linked issues.",
    inputSchema: {
      type: "object",
      required: ["topicId", "issueId"],
      properties: {
        topicId: { type: "string" },
        issueId: { type: "string" },
      },
    },
  },
  {
    name: "set_storage_root",
    description: "Set the company storage root for filing attachments and client folders. Pass localPath for a local filesystem path (including a mounted Google Drive path). Pass driveFolderId for a native Google Drive folder ID.",
    inputSchema: {
      type: "object",
      properties: {
        localPath: { type: "string", description: "Absolute local path (e.g. /home/user/Google Drive/Paperclip)" },
        driveFolderId: { type: "string", description: "Google Drive folder ID" },
        companyId: { type: "string", description: "Company UUID. Defaults to agent's company." },
      },
    },
  },
  {
    name: "ensure_client_folder",
    description: "Create the storage folder for a client (if it does not exist) and backfill all unfiled email attachments into it. Call after set_storage_root or after creating a client.",
    inputSchema: {
      type: "object",
      required: ["clientId"],
      properties: {
        clientId: { type: "string", description: "UUID of the client" },
      },
    },
  },
  {
    name: "ensure_project_folder",
    description: "Create the storage folder for a project under its client folder.",
    inputSchema: {
      type: "object",
      required: ["projectId"],
      properties: {
        projectId: { type: "string", description: "UUID of the project" },
      },
    },
  },
  {
    name: "create_client",
    description: "Create a new client record. Automatically creates their storage folder and backfills existing email attachments into it. Use when an unknown sender is confirmed as a new client.",
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "Client display name" },
        emailDomain: { type: "string", description: "Primary email domain (e.g. acme.com)" },
        extraEmails: { type: "array", items: { type: "string" }, description: "Individual email addresses to route to this client" },
        companyId: { type: "string", description: "Company UUID. Defaults to agent's company." },
      },
    },
  },
  {
    name: "create_contact",
    description: "Register a specific email address as a contact with a role (partner, vendor, referral, internal, client). Link to an existing client with clientId.",
    inputSchema: {
      type: "object",
      required: ["email", "role"],
      properties: {
        email: { type: "string", description: "Contact email address" },
        firstName: { type: "string", description: "Contact first name" },
        lastName: { type: "string", description: "Contact last name" },
        role: { type: "string", description: "partner | vendor | referral | internal | client" },
        clientId: { type: "string", description: "UUID of client to link this contact to" },
        companyId: { type: "string", description: "Company UUID. Defaults to agent's company." },
      },
    },
  },
  {
    name: "block_sender_domain",
    description: "Block all future emails from a domain. Emails from blocked domains are silently discarded without creating issues or notifying the operator.",
    inputSchema: {
      type: "object",
      required: ["domain"],
      properties: {
        domain: { type: "string", description: "Domain to block (e.g. spam.com)" },
        reason: { type: "string", description: "Why this domain is blocked" },
        companyId: { type: "string", description: "Company UUID. Defaults to agent's company." },
      },
    },
  },
  {
    name: "list_routines",
    description: "List routines (scheduled recurring tasks) for a company. Returns each routine with its triggers (cron schedules), assignee agent, and last run status.",
    inputSchema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "UUID of the company to query. Required when querying a company other than the default." },
      },
    },
  },
  {
    name: "create_routine",
    description: "Create a new routine (recurring scheduled task) assigned to an agent. Optionally attach a cron schedule trigger so it runs automatically.",
    inputSchema: {
      type: "object",
      required: ["projectId", "title", "assigneeAgentId"],
      properties: {
        companyId: { type: "string", description: "UUID of the company. Defaults to agent's company." },
        projectId: { type: "string", description: "UUID of the project this routine belongs to." },
        title: { type: "string", description: "Short title for the routine (max 200 chars)." },
        description: { type: "string", description: "What the agent should do when this routine fires." },
        assigneeAgentId: { type: "string", description: "UUID of the agent that will execute this routine." },
        priority: { type: "string", description: "low | medium | high | urgent (default: medium)" },
        cronExpression: { type: "string", description: "Cron expression for automatic scheduling (e.g. '0 8 * * 1-5' for weekdays at 8am). Omit for manual-only." },
        timezone: { type: "string", description: "IANA timezone for the cron schedule (e.g. Africa/Johannesburg). Default: UTC." },
      },
    },
  },
  {
    name: "run_routine",
    description: "Manually trigger a routine to run immediately.",
    inputSchema: {
      type: "object",
      required: ["routineId"],
      properties: {
        routineId: { type: "string", description: "UUID of the routine to run." },
        payload: { type: "object", description: "Optional JSON payload passed to the agent." },
      },
    },
  },
  {
    name: "discard_message",
    description: "Mark a specific operator message as discarded. One-off action — does not block the sender's domain. Use for single irrelevant messages.",
    inputSchema: {
      type: "object",
      required: ["messageId"],
      properties: {
        messageId: { type: "string", description: "UUID of the operator_messages row to discard" },
        reason: { type: "string", description: "Why this message is discarded (optional, for logging)" },
      },
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

function getClientFolderPath(client: { localPath: string | null; driveFolderId: string | null } | null | undefined): string | null {
  if (!client) return null;
  if (client.localPath) return client.localPath;
  if (client.driveFolderId) return `drive:${client.driveFolderId}`;
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function appendStageToActiveRun(
  db: Db,
  callerAgentId: string | null,
  stage: { stageId: string; label: string; status: string; actuals: Record<string, unknown> },
) {
  if (!callerAgentId) return;
  const [activeRun] = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.agentId, callerAgentId), eq(workflowRuns.overallStatus, "running")))
    .orderBy(desc(workflowRuns.startedAt))
    .limit(1);
  if (!activeRun) return;
  const [lastStage] = await db
    .select({ ord: workflowStageResults.ord })
    .from(workflowStageResults)
    .where(eq(workflowStageResults.runId, activeRun.id))
    .orderBy(desc(workflowStageResults.ord))
    .limit(1);
  await db.insert(workflowStageResults).values({
    runId: activeRun.id,
    stageId: stage.stageId,
    label: stage.label,
    status: stage.status,
    expectations: [],
    actuals: stage.actuals,
    errorText: null,
    ord: (lastStage?.ord ?? 2) + 1,
    computedAt: new Date(),
  });
}

async function handleTool(
  db: Db,
  companyId: string,
  callerAgentIdRaw: string | null,
  name: string,
  args: Record<string, unknown>,
  isOperator = false,
): Promise<string> {
  // Only pass callerAgentId to DB columns that are UUID FKs if it's a real UUID
  const callerAgentId = callerAgentIdRaw && UUID_RE.test(callerAgentIdRaw) ? callerAgentIdRaw : null;
  // Operator can override companyId per tool call (cross-company EA access)
  const effectiveCompanyId =
    isOperator && typeof args.companyId === "string" && UUID_RE.test(args.companyId)
      ? args.companyId
      : companyId;
  if (name === "list_issues") {
    const limit = Math.min(Number(args.limit ?? 20), 50);
    const filters = [eq(issues.companyId, effectiveCompanyId)];
    if (args.status) filters.push(eq(issues.status, String(args.status)));
    if (args.priority) filters.push(eq(issues.priority, String(args.priority)));

    const rows = await db
      .select({
        id: issues.id, identifier: issues.identifier, title: issues.title,
        status: issues.status, priority: issues.priority,
        assigneeAgentId: issues.assigneeAgentId, description: issues.description,
        clientId: issues.clientId,
      })
      .from(issues)
      .where(and(...filters))
      .orderBy(desc(issues.updatedAt))
      .limit(limit);

    const clientIds = [...new Set(rows.flatMap((r) => r.clientId ? [r.clientId] : []))];
    const clientRows = clientIds.length > 0
      ? await db.select({ id: clients.id, localPath: clients.localPath, driveFolderId: clients.driveFolderId })
          .from(clients).where(inArray(clients.id, clientIds))
      : [];
    const folderMap = new Map(clientRows.map((c) => [c.id, getClientFolderPath(c)]));
    const enriched = rows.map((r) => ({ ...r, clientFolderPath: r.clientId ? (folderMap.get(r.clientId) ?? null) : null }));

    return JSON.stringify(enriched, null, 2);
  }

  if (name === "create_issue") {
    const title = String(args.title ?? "").trim();
    if (!title) return "Error: title is required";

    const [created] = await db
      .insert(issues)
      .values({
        companyId: effectiveCompanyId,
        title,
        description: args.description ? String(args.description) : null,
        priority: (args.priority as string) ?? "medium",
        status: (args.status as string) ?? "backlog",
        projectId: args.projectId ? String(args.projectId) : null,
        assigneeAgentId: args.assigneeAgentId ? String(args.assigneeAgentId) : null,
        createdByAgentId: callerAgentId,
        originKind: "chat",
      })
      .returning();

    void logActivity(db, {
      companyId, actorType: "agent", actorId: callerAgentId ?? "chat",
      action: "issue.created", entityType: "issue", entityId: created!.id,
      agentId: callerAgentId,
      details: { title, via: "mcp-chat" },
    });

    let issueClientFolderPath: string | null = null;
    if (args.clientId) {
      const [cl] = await db
        .select({ localPath: clients.localPath, driveFolderId: clients.driveFolderId })
        .from(clients).where(eq(clients.id, String(args.clientId))).limit(1);
      issueClientFolderPath = getClientFolderPath(cl ?? null);
    }
    return JSON.stringify({ ...created, clientFolderPath: issueClientFolderPath }, null, 2);
  }

  if (name === "update_issue") {
    const issueId = String(args.issueId ?? "").trim();
    if (!issueId) return "Error: issueId is required";

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (args.status !== undefined) patch.status = String(args.status);
    if (args.priority !== undefined) patch.priority = String(args.priority);
    if (args.title !== undefined) patch.title = String(args.title);
    if (args.description !== undefined) patch.description = String(args.description);
    if ("assigneeAgentId" in args) patch.assigneeAgentId = args.assigneeAgentId ? String(args.assigneeAgentId) : null;

    const [updated] = await db
      .update(issues)
      .set(patch)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
      .returning();

    if (!updated) return "Error: issue not found or access denied";

    void logActivity(db, {
      companyId, actorType: "agent", actorId: callerAgentId ?? "chat",
      action: "issue.updated", entityType: "issue", entityId: issueId,
      agentId: callerAgentId, details: { patch, via: "mcp-chat" },
    });

    // Notify operator when agent sets status to blocked
    if (patch.status === "blocked") {
      await notifyOperator(db, `🚫 Issue blocked: *${updated.title ?? issueId}*\n\nID: \`${updated.identifier ?? issueId}\``, "agent_blocked").catch(() => {});
    }

    return JSON.stringify(updated, null, 2);
  }

  if (name === "list_agents") {
    const filters = [eq(agents.companyId, effectiveCompanyId)];
    if (args.status) filters.push(eq(agents.status, String(args.status)));

    const rows = await db
      .select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status })
      .from(agents)
      .where(and(...filters))
      .orderBy(agents.name);

    return JSON.stringify(rows, null, 2);
  }

  if (name === "list_projects") {
    const rows = await db
      .select({ id: projects.id, name: projects.name, status: projects.status, description: projects.description })
      .from(projects)
      .where(eq(projects.companyId, effectiveCompanyId))
      .orderBy(projects.name);

    return JSON.stringify(rows, null, 2);
  }

  if (name === "get_activity") {
    const limit = Math.min(Number(args.limit ?? 20), 50);
    const filters = [eq(activityLog.companyId, effectiveCompanyId)];
    if (args.agentId) filters.push(eq(activityLog.agentId, String(args.agentId)));

    const rows = await db
      .select({
        id: activityLog.id, action: activityLog.action,
        actorType: activityLog.actorType, entityType: activityLog.entityType,
        details: activityLog.details, createdAt: activityLog.createdAt,
      })
      .from(activityLog)
      .where(and(...filters))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit);

    return JSON.stringify(rows, null, 2);
  }

  if (name === "search_emails") {
    const limit = Math.min(Number(args.limit ?? 20), 50);
    // Operators see all companies by default; passing companyId narrows to one.
    // Non-operators are always scoped to their token company.
    const filters: ReturnType<typeof eq>[] = [];
    if (!isOperator) {
      filters.push(eq(emailAccounts.companyId, companyId));
    } else if (effectiveCompanyId !== companyId) {
      filters.push(eq(emailAccounts.companyId, effectiveCompanyId));
    }
    if (args.from) filters.push(ilike(emailMessages.fromAddr, `%${String(args.from)}%`));
    if (args.subject) filters.push(ilike(emailMessages.subject, `%${String(args.subject)}%`));
    if (args.state) filters.push(eq(emailMessages.processingState, String(args.state)));
    if (args.since) {
      const since = new Date(String(args.since));
      if (!isNaN(since.getTime())) filters.push(gte(emailMessages.receivedAt, since));
    }

    const rows = await db
      .select({
        id: emailMessages.id,
        fromAddr: emailMessages.fromAddr,
        toAddrs: emailMessages.toAddrs,
        subject: emailMessages.subject,
        receivedAt: emailMessages.receivedAt,
        processingState: emailMessages.processingState,
        matchedAgentId: emailMessages.matchedAgentId,
        matchedClientId: emailMessages.matchedClientId,
        issueId: emailMessages.issueId,
        hasAttachments: emailMessages.attachmentsPath,
      })
      .from(emailMessages)
      .innerJoin(emailAccounts, eq(emailMessages.emailAccountId, emailAccounts.id))
      .$dynamic()
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(emailMessages.receivedAt))
      .limit(limit);

    // Fetch attachment counts in one query
    const ids = rows.map((r) => r.id);
    const attachCounts =
      ids.length > 0
        ? await db
            .select({ emailMessageId: emailAttachments.emailMessageId, id: emailAttachments.id })
            .from(emailAttachments)
            .where(
              or(...ids.map((id) => eq(emailAttachments.emailMessageId, id))),
            )
        : [];
    const countById = attachCounts.reduce<Record<string, number>>((acc, a) => {
      acc[a.emailMessageId] = (acc[a.emailMessageId] ?? 0) + 1;
      return acc;
    }, {});

    const result = rows.map(({ hasAttachments: _, ...r }) => ({
      ...r,
      attachmentCount: countById[r.id] ?? 0,
    }));

    return JSON.stringify(result, null, 2);
  }

  if (name === "get_email") {
    const emailId = String(args.emailId ?? "").trim();
    if (!emailId) return "Error: emailId is required";

    const [row] = await db
      .select({
        id: emailMessages.id,
        fromAddr: emailMessages.fromAddr,
        toAddrs: emailMessages.toAddrs,
        subject: emailMessages.subject,
        body: emailMessages.body,
        receivedAt: emailMessages.receivedAt,
        processedAt: emailMessages.processedAt,
        processingState: emailMessages.processingState,
        inReplyToHeader: emailMessages.inReplyToHeader,
        referencesHeaders: emailMessages.referencesHeaders,
        matchedAgentId: emailMessages.matchedAgentId,
        matchedClientId: emailMessages.matchedClientId,
        issueId: emailMessages.issueId,
        approvalId: emailMessages.approvalId,
        errorText: emailMessages.errorText,
      })
      .from(emailMessages)
      .innerJoin(emailAccounts, eq(emailMessages.emailAccountId, emailAccounts.id))
      .where(and(eq(emailMessages.id, emailId), eq(emailAccounts.companyId, effectiveCompanyId)))
      .limit(1);

    if (!row) return "Error: email not found or access denied";

    const attachments = await db
      .select({
        id: emailAttachments.id,
        filename: emailAttachments.filename,
        contentType: emailAttachments.contentType,
        sizeBytes: emailAttachments.sizeBytes,
        isInline: emailAttachments.isInline,
        contentId: emailAttachments.contentId,
      })
      .from(emailAttachments)
      .where(eq(emailAttachments.emailMessageId, emailId));

    return JSON.stringify({ ...row, attachments }, null, 2);
  }

  if (name === "list_email_attachments") {
    const emailId = String(args.emailId ?? "").trim();
    if (!emailId) return "Error: emailId is required";

    // Verify company access via the parent message
    const [msg] = await db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .innerJoin(emailAccounts, eq(emailMessages.emailAccountId, emailAccounts.id))
      .where(and(eq(emailMessages.id, emailId), eq(emailAccounts.companyId, effectiveCompanyId)))
      .limit(1);

    if (!msg) return "Error: email not found or access denied";

    const attachments = await db
      .select({
        id: emailAttachments.id,
        filename: emailAttachments.filename,
        contentType: emailAttachments.contentType,
        sizeBytes: emailAttachments.sizeBytes,
        isInline: emailAttachments.isInline,
        contentId: emailAttachments.contentId,
        createdAt: emailAttachments.createdAt,
      })
      .from(emailAttachments)
      .where(eq(emailAttachments.emailMessageId, emailId))
      .orderBy(emailAttachments.createdAt);

    return JSON.stringify(attachments, null, 2);
  }

  if (name === "list_clients") {
    const filters = [eq(clients.companyId, effectiveCompanyId)];
    if (args.name) filters.push(ilike(clients.name, `%${String(args.name)}%`));

    const rows = await db
      .select({
        id: clients.id,
        name: clients.name,
        emailDomain: clients.emailDomain,
        extraEmails: clients.extraEmails,
        trustLevel: clients.trustLevel,
        notes: clients.notes,
      })
      .from(clients)
      .where(and(...filters))
      .orderBy(clients.name);

    return JSON.stringify(rows, null, 2);
  }

  if (name === "search_contacts") {
    const query = String(args.query ?? "").trim();
    const baseWhere = eq(contacts.companyId, effectiveCompanyId);
    const rows = query
      ? await db
          .select({
            id: contacts.id,
            email: contacts.email,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            role: contacts.role,
            clientId: contacts.clientId,
          })
          .from(contacts)
          .where(
            and(
              baseWhere,
              or(
                ilike(contacts.firstName, `%${query}%`),
                ilike(contacts.lastName, `%${query}%`),
                ilike(contacts.email, `%${query}%`),
              ),
            ),
          )
          .orderBy(contacts.lastName, contacts.firstName)
      : await db
          .select({
            id: contacts.id,
            email: contacts.email,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            role: contacts.role,
            clientId: contacts.clientId,
          })
          .from(contacts)
          .where(baseWhere)
          .orderBy(contacts.lastName, contacts.firstName);

    if (rows.length === 0 && query) {
      return `No contacts found matching "${query}". They may exist as an unnamed contact — try search_emails to find their email, then ask the operator who they are, then call update_contact to save the name.`;
    }
    return JSON.stringify(rows, null, 2);
  }

  if (name === "update_contact") {
    const contactId = String(args.contactId ?? "").trim();
    if (!contactId) return "Error: contactId is required";

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (args.firstName !== undefined) patch.firstName = String(args.firstName);
    if (args.lastName !== undefined) patch.lastName = String(args.lastName);
    if (args.phone !== undefined) patch.phone = String(args.phone);
    if (args.role !== undefined) patch.role = String(args.role);
    if (args.notes !== undefined) patch.notes = String(args.notes);

    const [updated] = await db
      .update(contacts)
      .set(patch)
      .where(and(eq(contacts.id, contactId), eq(contacts.companyId, companyId)))
      .returning();

    if (!updated) return "Error: contact not found or access denied";

    void logActivity(db, {
      companyId, actorType: "agent", actorId: callerAgentId ?? "chat",
      action: "contact.updated", entityType: "contact", entityId: contactId,
      agentId: callerAgentId, details: { patch, via: "mcp-chat" },
    });

    return JSON.stringify(updated, null, 2);
  }

  if (name === "create_plan") {
    const { issueId, emailMessageId, title, proposalText, assigneeAgentId, steps } = args as {
      issueId?: string;
      emailMessageId?: string;
      title?: string;
      proposalText: string;
      assigneeAgentId?: string;
      steps?: string[];
    };
    const stepsText = steps?.length ? "\n\nSteps:\n" + steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n") : "";
    const fullProposal = `${proposalText}${stepsText}`;

    if (emailMessageId && !issueId) {
      // EA email-sourced path: propose a new issue without an existing issue.
      if (!callerAgentId) return "Error: create_plan with emailMessageId requires an authenticated agent caller";
      const [emailRow] = await db
        .select({ matchedCompanyId: emailMessages.matchedCompanyId })
        .from(emailMessages)
        .where(eq(emailMessages.id, emailMessageId))
        .limit(1);
      if (!emailRow?.matchedCompanyId) return `Error: email ${emailMessageId} not found or has no matchedCompanyId`;
      const { planId, approvalId } = await planGateService(db).proposePlan({
        companyId: emailRow.matchedCompanyId,
        agentId: callerAgentId,
        actionType: "create_issue",
        kind: "create_issue",
        proposalText: fullProposal,
        sourceEmailMessageId: emailMessageId,
        assigneeAgentId: assigneeAgentId ?? null,
        bypassReadinessGate: true,
      });
      try {
        const planNotice = `📋 *New lead — approval required*\n\n${title ? `**${title}**\n\n` : ""}${fullProposal.slice(0, 600)}${fullProposal.length > 600 ? "…" : ""}\n\nPlan ID: \`${planId}\``;
        await notifyOperator(db, planNotice, "new_lead_created");
      } catch { /* non-fatal */ }
      return JSON.stringify({ planId, approvalId });
    }

    // Legacy issue-linked path
    if (!issueId) return "Error: create_plan requires either issueId or emailMessageId";
    const [issueRow] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!issueRow) return `Error: issue ${issueId} not found`;
    const [approval] = await db.insert(approvals).values({
      companyId: issueRow.companyId,
      type: "plan",
      requestedByAgentId: null,
      status: "pending",
      payload: { issueId, proposalText: fullProposal, steps: steps ?? [] },
    }).returning({ id: approvals.id });

    try {
      const planNotice = `📋 *Plan awaiting approval*\n\n${fullProposal.slice(0, 600)}${fullProposal.length > 600 ? "…" : ""}\n\nApproval ID: \`${approval!.id}\`\n\nReply "approve" or "decline" — EA will call approve_plan.`;
      await notifyOperator(db, planNotice, "approval_required");
    } catch { /* non-fatal */ }

    return `Plan created. Approval ID: ${approval!.id}. Awaiting operator approval.`;
  }

  if (name === "add_issue_comment") {
    const { issueId, body: commentBody } = args as { issueId: string; body: string };
    const [existing] = await db.select({ companyId: issues.companyId, title: issues.title, identifier: issues.identifier }).from(issues).where(eq(issues.id, issueId)).limit(1);
    if (!existing) return `Issue ${issueId} not found`;
    await db.insert(issueComments).values({
      issueId,
      companyId: existing.companyId,
      body: commentBody,
      authorAgentId: null,
    });

    // Notify operator whenever an agent adds a comment
    {
      const issueRef = existing.identifier ?? issueId.slice(0, 8);
      const preview = commentBody.replace(/#+\s*/g, "").slice(0, 400);
      await notifyOperator(db, `📋 *${issueRef}:* ${existing.title ?? ""}\n\n${preview}`, "urgent_item_detected").catch(() => {});
    }

    return `Comment added to issue ${issueId}.`;
  }

  if (name === "create_project") {
    const { name: projectName, description, clientId, status } = args as {
      name: string; description?: string; clientId?: string; status?: string;
    };
    const [project] = await db.insert(projects).values({
      companyId: effectiveCompanyId,
      name: projectName,
      description: description ?? null,
      clientId: clientId ?? null,
      status: status ?? "backlog",
    }).returning({ id: projects.id, name: projects.name });
    return `Project created: "${project!.name}" (ID: ${project!.id})`;
  }

  if (name === "notify_operator") {
    const { body: notifyBody, issueId: notifyIssueId } = args as { body: string; issueId?: string };
    await notifyOperator(db, notifyBody, "urgent_item_detected").catch((err) => {
      logger.warn({ err }, "notify_operator: telegram send failed");
    });
    await db.insert(operatorMessages).values({
      companyId,
      issueId: notifyIssueId ?? null,
      direction: "outbound",
      platform: "telegram",
      source: "orchestrator",
      body: notifyBody,
      rawPayload: null,
    });
    await appendStageToActiveRun(db, callerAgentId, {
      stageId: "operator_notified",
      label: "Operator notified",
      status: "passed",
      actuals: { message: notifyBody.slice(0, 300) },
    });
    // Append notification to inbox conversation so operator replies have context.
    // Without this, when JayJay replies to a notification, Claude sees an empty inbox history.
    try {
      const topicSvc = topicsService(db);
      const convSvc = eaConversationsService(db);
      const allTopics = await topicSvc.list("active");
      const inboxTopic = allTopics.find((t) => t.name === "EA Inbox");
      if (inboxTopic) {
        const active = await convSvc.listAllActive();
        const inboxConv = active.find((c) => c.topicId === inboxTopic.id);
        if (inboxConv) {
          await convSvc.appendMessage(inboxConv.id, "assistant", notifyBody);
        }
      }
    } catch (err) {
      logger.warn({ err }, "notify_operator: failed to append to inbox conversation");
    }
    return `Operator notified.`;
  }

  if (name === "send_operator_email") {
    const { subject: emailSubject, html: emailHtml, text: emailText } = args as { subject: string; html: string; text?: string };

    const [company] = await db
      .select({ ownerEmail: companies.ownerEmail })
      .from(companies)
      .where(eq(companies.id, effectiveCompanyId))
      .limit(1);
    const toAddr = company?.ownerEmail;
    if (!toAddr) throw new Error("Company has no ownerEmail configured — cannot send operator email.");

    const [account] = await db
      .select({ id: emailAccounts.id })
      .from(emailAccounts)
      .where(eq(emailAccounts.companyId, effectiveCompanyId))
      .limit(1);
    if (!account) throw new Error("No email account configured for this company — cannot send operator email.");

    await sendEmailFromAccount(db, {
      accountId: account.id,
      to: toAddr,
      subject: emailSubject,
      html: emailHtml,
      text: emailText,
    });

    await db.insert(operatorMessages).values({
      companyId: effectiveCompanyId,
      issueId: null,
      direction: "outbound",
      platform: "email",
      source: "orchestrator",
      body: `[HTML email] ${emailSubject}`,
      rawPayload: null,
    });

    await appendStageToActiveRun(db, callerAgentId, {
      stageId: "operator_email_sent",
      label: "Operator email sent",
      status: "passed",
      actuals: { subject: emailSubject, to: toAddr },
    });

    return `Email sent to ${toAddr}: "${emailSubject}"`;
  }

  if (name === "send_client_reply") {
    const { clientId: replyClientId, body: replyBody, channel, threadKey: replyThreadKey, issueId: replyIssueId, subject: replySubject } = args as {
      clientId: string; body: string; channel: string; threadKey?: string; issueId?: string; subject?: string;
    };
    const [settings] = await db.select({ general: instanceSettings.general }).from(instanceSettings).limit(1);
    const general = (settings?.general ?? {}) as Record<string, unknown>;
    const requireApproval = (general.requireClientReplyApproval as boolean | undefined) ?? true;

    if (!requireApproval && channel === "whatsapp" && replyThreadKey) {
      const waToken = (await readInstanceToken(db, "whatsappToken")) ?? (process.env.WHATSAPP_TOKEN ?? "");
      const waPhone = (await readInstanceToken(db, "whatsappPhoneNumberId")) ?? (process.env.WHATSAPP_PHONE_NUMBER_ID ?? "");
      if (waToken && waPhone) {
        const phone = replyThreadKey.replace(/\D/g, "");
        await sendWhatsAppMessage(waToken, waPhone, phone, replyBody);
        await appendStageToActiveRun(db, callerAgentId, {
          stageId: "client_reply_sent",
          label: "Client reply sent",
          status: "passed",
          actuals: { channel, message: replyBody.slice(0, 300) },
        });
        return `Reply sent directly to client via WhatsApp (approval bypassed per company settings).`;
      }
    }

    const [approval] = await db.insert(approvals).values({
      companyId,
      type: "client_reply",
      requestedByAgentId: null,
      status: "pending",
      payload: {
        clientId: replyClientId,
        body: replyBody,
        channel,
        threadKey: replyThreadKey ?? null,
        issueId: replyIssueId ?? null,
        subject: replySubject ?? null,
      },
    }).returning({ id: approvals.id });
    await appendStageToActiveRun(db, callerAgentId, {
      stageId: "client_reply_queued",
      label: "Client reply queued for approval",
      status: "passed",
      actuals: { channel, approvalId: approval!.id, message: replyBody.slice(0, 300) },
    });
    return `Client reply queued for approval. Approval ID: ${approval!.id}. Operator must approve before message is sent.`;
  }

  if (name === "set_issue_blocked") {
    const { issueId: blockedId, reason } = args as { issueId: string; reason: string };
    const [existing] = await db.select({ companyId: issues.companyId, title: issues.title }).from(issues).where(eq(issues.id, blockedId)).limit(1);
    if (!existing) return `Issue ${blockedId} not found`;
    await db.update(issues).set({ status: "blocked", updatedAt: new Date() }).where(eq(issues.id, blockedId));
    await db.insert(issueComments).values({
      issueId: blockedId,
      companyId: existing.companyId,
      body: `🚫 **Blocked:** ${reason}`,
      authorAgentId: null,
    });
    await notifyOperator(db, `🚫 Issue blocked: *${existing.title ?? blockedId}*\n\nReason: ${reason}\n\nIssue ID: \`${blockedId}\``, "agent_blocked").catch(() => {});
    return `Issue marked as blocked. Operator notified.`;
  }

  if (name === "get_client") {
    const { clientId: gcId } = args as { clientId: string };
    const [client] = await db
      .select({ id: clients.id, name: clients.name, emailDomain: clients.emailDomain, extraEmails: clients.extraEmails, notes: clients.notes, localPath: clients.localPath, driveFolderId: clients.driveFolderId })
      .from(clients)
      .where(and(eq(clients.id, gcId), eq(clients.companyId, effectiveCompanyId)))
      .limit(1);
    if (!client) return `Client ${gcId} not found`;
    const openIssues = await db
      .select({ id: issues.id, title: issues.title, status: issues.status })
      .from(issues)
      .where(and(eq(issues.companyId, effectiveCompanyId), eq(issues.clientId, gcId)))
      .limit(10);
    return JSON.stringify({ ...client, clientFolderPath: getClientFolderPath(client), openIssues }, null, 2);
  }

  if (name === "get_issue_plans") {
    const { issueId: planIssueId } = args as { issueId: string };
    const rows = await db
      .select({
        id: approvals.id,
        status: approvals.status,
        payload: approvals.payload,
        decisionNote: approvals.decisionNote,
        createdAt: approvals.createdAt,
        decidedAt: approvals.decidedAt,
      })
      .from(approvals)
      .where(and(eq(approvals.companyId, effectiveCompanyId), eq(approvals.type, "plan")))
      .orderBy(desc(approvals.createdAt))
      .limit(10);
    const forIssue = rows.filter((r) => (r.payload as Record<string, unknown>)?.issueId === planIssueId);
    if (!forIssue.length) return `No plans found for issue ${planIssueId}`;
    return JSON.stringify(
      forIssue.map((r) => ({
        approvalId: r.id,
        status: r.status,
        proposalText: (r.payload as Record<string, unknown>)?.proposalText ?? "",
        steps: (r.payload as Record<string, unknown>)?.steps ?? [],
        decisionNote: r.decisionNote,
        createdAt: r.createdAt,
        decidedAt: r.decidedAt,
      })),
      null,
      2,
    );
  }

  if (name === "get_issue_comments") {
    const { issueId: commentIssueId } = args as { issueId: string };
    const rows = await db
      .select({
        id: issueComments.id,
        body: issueComments.body,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(eq(issueComments.issueId, commentIssueId))
      .orderBy(issueComments.createdAt)
      .limit(50);
    if (!rows.length) return `No comments on issue ${commentIssueId}`;
    return JSON.stringify(rows, null, 2);
  }

  if (name === "list_issue_emails") {
    const { issueId: emailIssueId } = args as { issueId: string };
    const msgs = await db
      .select({
        id: emailMessages.id,
        fromAddr: emailMessages.fromAddr,
        subject: emailMessages.subject,
        body: emailMessages.body,
        receivedAt: emailMessages.receivedAt,
        processingState: emailMessages.processingState,
      })
      .from(emailMessages)
      .where(eq(emailMessages.issueId, emailIssueId))
      .orderBy(desc(emailMessages.receivedAt));
    if (!msgs.length) return `No emails linked to issue ${emailIssueId}`;

    const result = await Promise.all(msgs.map(async (msg) => {
      const atts = await db
        .select({ id: emailAttachments.id, filename: emailAttachments.filename, contentType: emailAttachments.contentType, storagePath: emailAttachments.storagePath, sizeBytes: emailAttachments.sizeBytes })
        .from(emailAttachments)
        .where(and(eq(emailAttachments.emailMessageId, msg.id), eq(emailAttachments.isInline, false)));
      return {
        ...msg,
        bodyPreview: msg.body.slice(0, 300),
        attachments: atts,
      };
    }));
    return JSON.stringify(result, null, 2);
  }

  if (name === "get_email_message") {
    const { emailMessageId } = args as { emailMessageId: string };
    const [row] = await db
      .select({
        id: emailMessages.id,
        fromAddr: emailMessages.fromAddr,
        subject: emailMessages.subject,
        body: emailMessages.body,
        receivedAt: emailMessages.receivedAt,
        inReplyToHeader: emailMessages.inReplyToHeader,
        referencesHeaders: emailMessages.referencesHeaders,
        emailAccountId: emailMessages.emailAccountId,
        issueId: emailMessages.issueId,
      })
      .from(emailMessages)
      .where(eq(emailMessages.id, emailMessageId))
      .limit(1);
    if (!row) return `Email message not found: ${emailMessageId}`;

    const attachments = await db
      .select({ filename: emailAttachments.filename, contentType: emailAttachments.contentType, sizeBytes: emailAttachments.sizeBytes })
      .from(emailAttachments)
      .where(and(eq(emailAttachments.emailMessageId, emailMessageId), eq(emailAttachments.isInline, false)));

    const referencedMsgIds = [
      ...(row.referencesHeaders ?? []),
      ...(row.inReplyToHeader ? [row.inReplyToHeader] : []),
    ];
    let threadHistory: Array<{ id: string; fromAddr: string; subject: string | null; body: string; receivedAt: Date; issueId: string | null }> = [];
    if (referencedMsgIds.length > 0) {
      threadHistory = await db
        .select({ id: emailMessages.id, fromAddr: emailMessages.fromAddr, subject: emailMessages.subject, body: emailMessages.body, receivedAt: emailMessages.receivedAt, issueId: emailMessages.issueId })
        .from(emailMessages)
        .where(and(eq(emailMessages.emailAccountId, row.emailAccountId), inArray(emailMessages.messageIdHeader, referencedMsgIds)))
        .orderBy(emailMessages.receivedAt);
    }
    const existingIssueId = threadHistory.find((t) => t.issueId)?.issueId ?? row.issueId ?? null;

    return JSON.stringify({
      id: row.id,
      fromAddr: row.fromAddr,
      subject: row.subject,
      body: row.body,
      receivedAt: row.receivedAt,
      attachmentSummaries: attachments,
      threadHistory: threadHistory.map((t) => ({ id: t.id, fromAddr: t.fromAddr, subject: t.subject, body: t.body, receivedAt: t.receivedAt, issueId: t.issueId })),
      existingIssueId,
    }, null, 2);
  }

  if (name === "get_issue_context") {
    const { issueId: ctxIssueId } = args as { issueId: string };
    const [issueRow] = await db
      .select({ id: issues.id, identifier: issues.identifier, title: issues.title, description: issues.description, status: issues.status, priority: issues.priority, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, ctxIssueId))
      .limit(1);
    if (!issueRow) return `Issue not found: ${ctxIssueId}`;

    const commentRows = await db
      .select({ id: issueComments.id, body: issueComments.body, authorAgentId: issueComments.authorAgentId, authorUserId: issueComments.authorUserId, createdAt: issueComments.createdAt })
      .from(issueComments)
      .where(eq(issueComments.issueId, ctxIssueId))
      .orderBy(issueComments.createdAt);

    const emailRows = await db
      .select({ id: emailMessages.id, fromAddr: emailMessages.fromAddr, subject: emailMessages.subject, body: emailMessages.body, receivedAt: emailMessages.receivedAt })
      .from(emailMessages)
      .where(eq(emailMessages.issueId, ctxIssueId))
      .orderBy(emailMessages.receivedAt);

    const emailsWithAttachments = await Promise.all(emailRows.map(async (msg) => {
      const atts = await db
        .select({ filename: emailAttachments.filename, contentType: emailAttachments.contentType, sizeBytes: emailAttachments.sizeBytes })
        .from(emailAttachments)
        .where(and(eq(emailAttachments.emailMessageId, msg.id), eq(emailAttachments.isInline, false)));
      return { ...msg, attachmentSummaries: atts };
    }));

    return JSON.stringify({
      issue: issueRow,
      comments: commentRows,
      emails: emailsWithAttachments,
    }, null, 2);
  }

  if (name === "list_companies") {
    const rows = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .orderBy(companies.name);
    return JSON.stringify(rows, null, 2);
  }

  if (name === "list_topics") {
    const svc = topicsService(db);
    const status = typeof args.status === "string" ? args.status : "active";
    const topics = await svc.list(status);
    if (!topics.length) return `No ${status} topics found.`;
    return JSON.stringify(topics, null, 2);
  }

  if (name === "create_topic") {
    const svc = topicsService(db);
    const topic = await svc.create({
      name: String(args.name),
      companyId: typeof args.companyId === "string" ? args.companyId : null,
    });
    return `Topic "${topic.name}" created. topic-id: ${topic.id}. IMPORTANT: The NEXT message about this topic MUST call resolve_conversation with topicId="${topic.id}" to start a fresh conversation — do NOT continue the current Inbox or any other active conversation.`;
  }

  if (name === "update_topic_memory") {
    const svc = topicsService(db);
    const updates: { summary?: string; currentState?: string | null } = {};
    if (typeof args.summary === "string") updates.summary = args.summary;
    if (typeof args.currentState === "string") updates.currentState = args.currentState;
    const topic = await svc.update(String(args.topicId), updates);
    if (!topic) return `Error: topic ${args.topicId} not found`;
    return `Topic updated: ${topic.name} — state: ${topic.currentState ?? "none"}`;
  }

  if (name === "link_issue_to_topic") {
    const svc = topicsService(db);
    await svc.linkIssue(String(args.topicId), String(args.issueId));
    return `Issue ${args.issueId} linked to topic ${args.topicId}`;
  }

  if (name === "resolve_conversation") {
    const topicId = String(args.topicId);
    const messagePreview = typeof args.messagePreview === "string" ? args.messagePreview.slice(0, 300) : undefined;
    const topicSvc = topicsService(db);
    const topic = await topicSvc.getById(topicId);
    if (!topic) return `Error: topic ${topicId} not found`;

    const convSvc = eaConversationsService(db);
    const conversation = await convSvc.resolveActive(topicId);

    const runCompanyId = topic.companyId ?? effectiveCompanyId;
    const now = new Date();

    // Adopt existing running stub run (created by orchestrator) — avoids duplicate runs per message.
    // Fall back to creating a new run if no stub exists (e.g. direct tool call).
    let run: { id: string } | undefined;
    if (callerAgentId) {
      const [existing] = await db
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(and(eq(workflowRuns.agentId, callerAgentId), eq(workflowRuns.overallStatus, "running")))
        .orderBy(desc(workflowRuns.startedAt))
        .limit(1);
      if (existing) {
        run = existing;
        // Update sourceId to point at the conversation now that we know it
        await db.update(workflowRuns).set({ sourceTable: "ea_conversations", sourceId: conversation.id }).where(eq(workflowRuns.id, existing.id));
      }
    }
    if (!run) {
      const [inserted] = await db
        .insert(workflowRuns)
        .values({
          companyId: runCompanyId,
          agentId: callerAgentId ?? undefined,
          workflowType: "ea_conversation",
          sourceTable: "ea_conversations",
          sourceId: conversation.id,
          overallStatus: "running",
          startedAt: now,
        })
        .returning();
      run = inserted;
    }

    if (callerAgentId) {
      eaAgentsService(db).setProcessing(callerAgentId, topic.id, topic.name, messagePreview ?? "").catch(() => {});
    }

    await db.insert(workflowStageResults).values([
      {
        runId: run!.id,
        stageId: "message_received",
        label: "Message received",
        status: "passed",
        expectations: ["Inbound message arrived"],
        actuals: messagePreview ? { messagePreview } : {},
        errorText: null,
        ord: 0,
        computedAt: now,
      },
      {
        runId: run!.id,
        stageId: "topic_matched",
        label: "Topic matched",
        status: "passed",
        expectations: ["EA identified topic from message context"],
        actuals: { topicId, topicName: topic.name },
        errorText: null,
        ord: 1,
        computedAt: now,
      },
      {
        runId: run!.id,
        stageId: "conversation_resolved",
        label: "Conversation resolved",
        status: "passed",
        expectations: ["Active conversation found or created"],
        actuals: {
          conversationId: conversation.id,
          messageCount: conversation.messageCount,
          isNew: conversation.messageCount === 1,
        },
        errorText: null,
        ord: 2,
        computedAt: now,
      },
    ]);

    const msUntilExpiry = conversation.expiresAt.getTime() - Date.now();
    const warningDays = Math.ceil(msUntilExpiry / 86_400_000);

    return JSON.stringify({
      conversationId: conversation.id,
      runId: run!.id,
      topicName: topic.name,
      summary: topic.summary,
      currentState: topic.currentState,
      expiresAt: conversation.expiresAt.toISOString(),
      messageCount: conversation.messageCount,
      warningDays,
      recentMessages: (conversation.recentMessages as ConversationMessage[]) ?? [],
      _REMINDER: "call notify_operator BEFORE complete_conversation_turn — JayJay sees nothing without it",
    });
  }

  if (name === "extend_conversation") {
    const convSvc = eaConversationsService(db);
    const result = await convSvc.extend(String(args.conversationId));
    return `Conversation extended until ${result.expiresAt.toISOString()}.`;
  }

  if (name === "complete_conversation_turn") {
    const runId = String(args.runId);
    const actionSummary = typeof args.actionSummary === "string" ? args.actionSummary.slice(0, 500) : undefined;
    const issuesLinked = Boolean(args.issuesLinked);

    const existing = await db
      .select({ ord: workflowStageResults.ord })
      .from(workflowStageResults)
      .where(eq(workflowStageResults.runId, runId))
      .orderBy(desc(workflowStageResults.ord))
      .limit(1);
    const nextOrd = (existing[0]?.ord ?? 2) + 1;

    const now = new Date();
    await db.insert(workflowStageResults).values([
      {
        runId,
        stageId: "memory_updated",
        label: "Memory updated",
        status: "passed",
        expectations: ["Conversation messages saved"],
        actuals: {},
        errorText: null,
        ord: nextOrd,
        computedAt: now,
      },
      {
        runId,
        stageId: "action_taken",
        label: "Action taken",
        status: "passed",
        expectations: ["EA completed turn with response"],
        actuals: { ...(actionSummary ? { actionSummary } : {}), issuesLinked },
        errorText: null,
        ord: nextOrd + 1,
        computedAt: now,
      },
    ]);

    await db
      .update(workflowRuns)
      .set({ overallStatus: "passed", finishedAt: now })
      .where(eq(workflowRuns.id, runId));

    // Auto-notify operator if agent forgot to call notify_operator.
    // Check by looking for an operator_notified or client_reply stage in this run.
    const notifyStages = await db
      .select({ stageId: workflowStageResults.stageId })
      .from(workflowStageResults)
      .where(and(
        eq(workflowStageResults.runId, runId),
        or(
          eq(workflowStageResults.stageId, "operator_notified"),
          eq(workflowStageResults.stageId, "client_reply_sent"),
          eq(workflowStageResults.stageId, "client_reply_queued"),
        ),
      ));
    if (notifyStages.length === 0 && actionSummary) {
      await notifyOperator(db, actionSummary, "thread_reply_received").catch((err) => {
        logger.warn({ err }, "complete_conversation_turn: auto-notify fallback failed");
      });
      await db.insert(workflowStageResults).values({
        runId,
        stageId: "operator_notified",
        label: "Operator notified (auto-fallback)",
        status: "passed",
        expectations: [],
        actuals: { message: actionSummary, autoFallback: true },
        errorText: null,
        ord: nextOrd + 2,
        computedAt: now,
      });
    }

    return "Turn complete.";
  }

  if (name === "update_memory") {
    const { title, content, category, companyId: memCompanyId } = args as {
      title: string;
      content: string;
      category: string;
      companyId?: string;
    };
    if (!callerAgentId) return "Error: no agent identity";
    const targetCompanyId = memCompanyId ?? effectiveCompanyId;
    if (!targetCompanyId) return "Error: companyId required for memory storage";
    const validCategories = ["pattern", "preference", "decision", "learning", "feedback"];
    const safeCategory = validCategories.includes(category) ? category : "learning";
    await db.insert(agentMemories).values({
      agentId: callerAgentId,
      companyId: targetCompanyId,
      scope: "global",
      category: safeCategory as "pattern" | "preference" | "decision" | "learning" | "feedback",
      title,
      content,
      source: "self",
      confidence: 0.8,
    });
    return `Memory stored: "${title}"`;
  }

  if (name === "approve_plan") {
    const { approvalId, approved = true, decisionNote } = args as {
      approvalId: string;
      approved?: boolean;
      decisionNote?: string;
    };
    if (!UUID_RE.test(approvalId)) return "Error: invalid approvalId";
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, approvalId)).limit(1);
    if (!approval) return `Error: approval ${approvalId} not found`;
    if (approval.type !== "plan") return "Error: not a plan approval";
    if (approval.status !== "pending") return `Error: already ${approval.status}`;

    const newStatus = approved ? "approved" : "declined";
    await db
      .update(approvals)
      .set({ status: newStatus, decisionNote: decisionNote ?? null, decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(approvals.id, approvalId));

    if (approved) {
      const payload = approval.payload as Record<string, unknown>;
      const issueId = payload.issueId as string | undefined;

      let resolvedIssue: { id: string; assigneeAgentId: string | null; status: string } | null = null;

      if (issueId) {
        const [existing] = await db
          .select({ id: issues.id, assigneeAgentId: issues.assigneeAgentId, status: issues.status })
          .from(issues)
          .where(eq(issues.id, issueId))
          .limit(1);
        resolvedIssue = existing ?? null;
      }

      // Issue missing (deleted or hallucinated ID) — create one from plan details
      if (!resolvedIssue && approval.companyId) {
        const proposalText = typeof payload.proposalText === "string" ? payload.proposalText : "";
        const steps = Array.isArray(payload.steps) ? (payload.steps as string[]) : [];

        // Extract title: strip first markdown heading prefix
        const titleLine = proposalText.split("\n").find((l) => l.trim()) ?? "";
        const title = titleLine.replace(/^#+\s*(Plan:\s*)?/i, "").trim() || "Approved plan";
        const description = steps.length
          ? steps.map((s, i) => `${i + 1}. ${s}`).join("\n")
          : proposalText.slice(0, 500);

        const svc = issueService(db);
        const created = await svc.create(approval.companyId, {
          title,
          description: description || null,
          status: "todo",
          priority: "medium",
          originKind: "chat",
        });

        resolvedIssue = created ? { id: created.id, assigneeAgentId: created.assigneeAgentId ?? null, status: created.status } : null;
        logger.info({ approvalId, issueId: created?.id, identifier: created?.identifier, title }, "approve_plan: created missing issue from plan");
      }

      if (resolvedIssue) {
        if (["backlog", "todo"].includes(resolvedIssue.status)) {
          await db.update(issues).set({ status: "in_progress", updatedAt: new Date() }).where(eq(issues.id, resolvedIssue.id));
        }
        if (resolvedIssue.assigneeAgentId) {
          const hb = heartbeatService(db);
          await hb.wakeup(resolvedIssue.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "plan_approved",
            payload: { approvalId, issueId: resolvedIssue.id },
            requestedByActorType: "system",
            requestedByActorId: "ea",
            contextSnapshot: { source: "plan.approved", approvalId, issueId: resolvedIssue.id },
          }).catch(() => {});
        }
      }
    }

    return `Plan ${newStatus}. Approval ID: ${approvalId}.`;
  }

  if (name === "search_memory") {
    const { query, senderIdentifier, companyId: filterCompanyId, channel, memoryType, limit = 20 } = args as {
      query?: string; senderIdentifier?: string; companyId?: string; channel?: string; memoryType?: string; limit?: number;
    };
    const conditions = [];
    if (filterCompanyId) conditions.push(eq(memoryItems.companyId, filterCompanyId));
    if (senderIdentifier) conditions.push(eq(memoryItems.senderIdentifier, senderIdentifier));
    if (channel) conditions.push(eq(memoryItems.sourceChannel, channel));
    if (memoryType && memoryType !== "all") conditions.push(eq(memoryItems.memoryType, memoryType));
    if (query) conditions.push(
      sql`(${memoryItems.content} ILIKE ${'%' + query + '%'} OR ${memoryItems.summary} ILIKE ${'%' + query + '%'})`
    );
    const rows = await db.select().from(memoryItems)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(memoryItems.createdAt))
      .limit(Math.min(Number(limit), 50));
    return JSON.stringify(rows, null, 2);
  }

  if (name === "create_memory") {
    const { content, summary, sourceChannel, sourceId, sourceEmailMessageId, senderIdentifier,
      companyId: memCompanyId, intentCategory, importanceScore, memoryType, tags } = args as {
      content: string; summary?: string; sourceChannel: string; sourceId?: string;
      sourceEmailMessageId?: string; senderIdentifier?: string; companyId?: string;
      intentCategory?: string; importanceScore?: number; memoryType: string; tags?: string[];
    };
    if (!content || !sourceChannel || !memoryType) return "Error: content, sourceChannel, and memoryType are required";
    const [row] = await db.insert(memoryItems).values({
      companyId: memCompanyId ?? null,
      sourceChannel,
      sourceId: sourceId ?? null,
      sourceEmailMessageId: sourceEmailMessageId ?? null,
      senderIdentifier: senderIdentifier ?? null,
      content,
      summary: summary ?? null,
      intentCategory: intentCategory ?? null,
      importanceScore: importanceScore ?? null,
      memoryType,
      tags: tags ?? [],
    }).returning({ id: memoryItems.id });
    return `Memory item created: ${row!.id}`;
  }

  if (name === "search_topics") {
    const { query, companyId: topicCompanyId, status = "active", limit = 20 } = args as {
      query?: string; companyId?: string; status?: string; limit?: number;
    };
    const conditions = [];
    if (topicCompanyId) conditions.push(eq(topics.companyId, topicCompanyId));
    if (status !== "all") conditions.push(eq(topics.status, status));
    if (query) conditions.push(
      sql`(${topics.name} ILIKE ${'%' + query + '%'} OR ${topics.summary} ILIKE ${'%' + query + '%'})`
    );
    const rows = await db.select().from(topics)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(topics.updatedAt))
      .limit(Math.min(Number(limit), 50));
    return JSON.stringify(rows, null, 2);
  }

  if (name === "create_topic") {
    const { name: topicName, summary, currentState, companyId: topicCompanyId } = args as {
      name: string; summary?: string; currentState?: string; companyId?: string;
    };
    if (!topicName) return "Error: name is required";
    const [row] = await db.insert(topics).values({
      name: topicName,
      summary: summary ?? "",
      currentState: currentState ?? null,
      companyId: topicCompanyId ?? null,
      status: "active",
    }).returning({ id: topics.id });
    return `Topic created: ${row!.id}`;
  }

  if (name === "link_topic_to_issue") {
    const { topicId, issueId: linkIssueId } = args as { topicId: string; issueId: string };
    if (!topicId || !linkIssueId) return "Error: topicId and issueId are required";
    await db.insert(topicIssues).values({ topicId, issueId: linkIssueId }).onConflictDoNothing();
    return `Linked topic ${topicId} to issue ${linkIssueId}`;
  }

  if (name === "set_storage_root") {
    const { localPath, driveFolderId } = args as { localPath?: string; driveFolderId?: string };
    await setCompanyStorageRoot(db, effectiveCompanyId, {
      localPath: localPath ?? null,
      driveFolderId: driveFolderId ?? null,
    });
    return JSON.stringify({ localPath: localPath ?? null, driveFolderId: driveFolderId ?? null });
  }

  if (name === "ensure_client_folder") {
    const { clientId } = args as { clientId: string };
    await ensureClientFolder(db, clientId);
    void backfillClientAttachments(db, clientId).catch((e) =>
      logger.warn({ err: e, clientId }, "mcp: backfillClientAttachments failed"),
    );
    return `Client folder ensured for ${clientId}. Backfill started.`;
  }

  if (name === "ensure_project_folder") {
    const { projectId } = args as { projectId: string };
    await ensureProjectFolder(db, projectId);
    return `Project folder ensured for ${projectId}.`;
  }

  if (name === "create_client") {
    const { name: clientName, emailDomain, extraEmails } = args as {
      name: string; emailDomain?: string; extraEmails?: string[];
    };
    if (!clientName) return "Error: name is required";
    const svc = clientService(db);
    const client = await svc.create(effectiveCompanyId, {
      name: clientName,
      emailDomain: emailDomain ?? null,
      extraEmails: extraEmails ?? [],
    });
    void backfillClientAttachments(db, client.id).catch((e) =>
      logger.warn({ err: e, clientId: client.id }, "mcp: backfillClientAttachments failed"),
    );
    return JSON.stringify({ clientId: client.id, name: client.name, emailDomain: client.emailDomain });
  }

  if (name === "create_contact") {
    const { email, firstName, lastName, role, clientId: contactClientId } = args as {
      email: string; firstName?: string; lastName?: string; role?: string; clientId?: string;
    };
    if (!email) return "Error: email is required";
    const svc = contactService(db);
    const contact = await svc.upsertByEmail(effectiveCompanyId, email, contactClientId ?? null);
    if (firstName !== undefined || lastName !== undefined || role !== undefined) {
      await svc.update(effectiveCompanyId, contact.id, { firstName, lastName, role });
    }
    return JSON.stringify({ contactId: contact.id, email: contact.email });
  }

  if (name === "block_sender_domain") {
    const { domain, reason } = args as { domain: string; reason?: string };
    if (!domain) return "Error: domain is required";
    const normalised = domain.trim().toLowerCase().replace(/^@+/, "");
    await db
      .insert(blockedSenderDomains)
      .values({ companyId: effectiveCompanyId, domain: normalised, reason: reason ?? null })
      .onConflictDoNothing();
    return `Domain ${normalised} blocked.`;
  }

  if (name === "discard_message") {
    const { messageId } = args as { messageId: string };
    if (!messageId) return "Error: messageId is required";
    await db
      .update(operatorMessages)
      .set({ discardedAt: new Date() })
      .where(and(eq(operatorMessages.id, messageId), eq(operatorMessages.companyId, effectiveCompanyId)));
    return `Message ${messageId} discarded.`;
  }

  if (name === "list_routines") {
    const svc = routineService(db);
    const routines = await svc.list(effectiveCompanyId);
    return JSON.stringify(routines, null, 2);
  }

  if (name === "create_routine") {
    const svc = routineService(db);
    const { projectId, title, description, assigneeAgentId, priority, cronExpression, timezone } =
      args as {
        projectId: string;
        title: string;
        description?: string;
        assigneeAgentId: string;
        priority?: string;
        cronExpression?: string;
        timezone?: string;
      };
    if (!projectId) return "Error: projectId is required";
    if (!title) return "Error: title is required";
    if (!assigneeAgentId) return "Error: assigneeAgentId is required";

    const routine = await svc.create(
      effectiveCompanyId,
      {
        projectId,
        title,
        description: description ?? null,
        assigneeAgentId,
        priority: (priority as "low" | "medium" | "high" | "critical") ?? "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
      },
      { agentId: callerAgentId },
    );

    if (cronExpression) {
      await svc.createTrigger(
        routine.id,
        { kind: "schedule", cronExpression, timezone: timezone ?? "UTC", enabled: true },
        { agentId: callerAgentId },
      );
    }

    return JSON.stringify({ routineId: routine.id, title: routine.title }, null, 2);
  }

  if (name === "run_routine") {
    const svc = routineService(db);
    const { routineId, payload } = args as { routineId: string; payload?: Record<string, unknown> };
    if (!routineId) return "Error: routineId is required";
    const run = await svc.runRoutine(routineId, {
      source: "api",
      payload: payload ?? null,
    });
    return JSON.stringify({ runId: run.id, status: run.status }, null, 2);
  }

  return `Error: unknown tool "${name}"`;
}

// ── Route ─────────────────────────────────────────────────────────────────────

export function mcpToolServerRoutes(db: Db): Router {
  const router = Router();

  router.post("/mcp", async (req, res) => {
    // Validate Bearer token
    const authHeader = req.headers.authorization ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const payload = verifyMcpToken(token);
    if (!payload) {
      res.status(401).json(err(null, -32600, "Unauthorized: invalid or expired MCP session token"));
      return;
    }

    const { companyId, agentId } = payload;
    const body = req.body as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };

    if (body.jsonrpc !== "2.0") {
      res.json(err(body.id ?? null, -32600, "Invalid JSON-RPC version"));
      return;
    }

    const method = body.method ?? "";
    const id = body.id ?? null;

    if (method === "initialize") {
      res.json(ok(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "paperclip", version: "1.0.0" },
      }));
      return;
    }

    if (method === "notifications/initialized") {
      res.status(204).end();
      return;
    }

    if (method === "ping") {
      res.json(ok(id, {}));
      return;
    }

    if (method === "tools/list") {
      res.json(ok(id, { tools: TOOLS }));
      return;
    }

    if (method === "tools/call") {
      const params = body.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
      const toolName = params?.name ?? "";
      const toolArgs = params?.arguments ?? {};

      try {
        const result = await handleTool(db, companyId, agentId, toolName, toolArgs, payload.isOperator ?? false);
        res.json(ok(id, textContent(result)));
      } catch (toolErr) {
        const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
        res.json(ok(id, textContent(`Error executing ${toolName}: ${msg}`)));
      }
      return;
    }

    res.json(err(id, -32601, `Method not found: ${method}`));
  });

  return router;
}
