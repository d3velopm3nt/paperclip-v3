// Reusable processing log for a single email.
// Accepts either a full EmailMessageDetail or a lightweight EmailMessageSummary.
// When given a summary, attachment filing detail is not shown (requires full detail).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Terminal,
  Paperclip,
  FolderOpen,
  ExternalLink,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { clientsApi } from "../api/clients";
import { agentsApi } from "../api/agents";
import { emailMessagesApi } from "../api/emailMessages";
import type { EmailMessageDetail, EmailMessageSummary } from "../api/emailMessages";

export type EmailMessage = EmailMessageSummary | EmailMessageDetail;

function isDetail(m: EmailMessage): m is EmailMessageDetail {
  return "attachments" in m;
}

interface LogEntry {
  icon: "ok" | "fail" | "info" | "pending";
  label: string;
  extra?: string;
  // Set on filed attachment entries to enable click-to-inspect
  attachmentId?: string;
  messageId?: string;
}

const ICONS = {
  ok: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />,
  fail: <XCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />,
  info: <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />,
  pending: <AlertCircle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />,
};

function shortFiledPath(p: string): string {
  if (p.startsWith("drive:")) {
    // drive:fileId — just say Drive
    return "Drive";
  }
  if (p.startsWith("google-drive://")) {
    // google-drive://user@.../folder/.../filename — show last segment
    const segs = p.split("/").filter(Boolean);
    const last = segs[segs.length - 1] ?? "Drive";
    return `Drive: ${decodeURIComponent(last)}`;
  }
  // Local path — show last 2 segments
  const segs = p.split(/[/\\]/).filter(Boolean);
  return segs.slice(-2).join("/");
}

const STATE_LABELS: Record<string, string> = {
  pending: "Routing in progress…",
  analyzing: "Analyzing",
  plan_proposed: "Plan proposed",
  clarifying: "Clarifying",
  approved: "Approved",
  declined: "Declined",
  executed: "Executed",
  ignored: "Ignored",
  error: "Error during processing",
};

interface Props {
  message: EmailMessage;
  companyId: string;
  companyName?: string;
  defaultOpen?: boolean;
}

interface FiledCheckDialogProps {
  messageId: string;
  attachmentId: string;
  filename: string;
  onClose: () => void;
}

export function FiledCheckDialog({ messageId, attachmentId, filename, onClose }: FiledCheckDialogProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["filed-check", messageId, attachmentId],
    queryFn: () => emailMessagesApi.checkFiledPath(messageId, attachmentId),
  });

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <FolderOpen className="h-4 w-4 shrink-0" />
            Filed attachment
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <span className="text-muted-foreground text-xs">Filename</span>
            <p className="font-mono text-xs mt-0.5 break-all">{filename}</p>
          </div>

          {isLoading && (
            <p className="text-muted-foreground text-xs">Checking path…</p>
          )}

          {error && (
            <div className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-destructive text-xs">
              Failed to check path: {String(error)}
            </div>
          )}

          {data && (
            <>
              <div>
                <span className="text-muted-foreground text-xs">Filed path</span>
                {data.path ? (
                  <p className="font-mono text-xs mt-0.5 break-all text-foreground/80">{data.path}</p>
                ) : (
                  <p className="text-muted-foreground text-xs mt-0.5 italic">No path recorded</p>
                )}
              </div>

              {data.type && (
                <div>
                  <span className="text-muted-foreground text-xs">Storage type</span>
                  <p className="text-xs mt-0.5 capitalize">{data.type === "drive" ? "Google Drive" : "Local filesystem"}</p>
                </div>
              )}

              {data.filedAt && (
                <div>
                  <span className="text-muted-foreground text-xs">Filed at</span>
                  <p className="text-xs mt-0.5">{new Date(data.filedAt).toLocaleString()}</p>
                </div>
              )}

              <div className="rounded-md border px-3 py-2 flex items-start gap-2">
                {data.exists ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-emerald-700 dark:text-emerald-400 text-xs font-medium">File exists</p>
                      {data.type === "drive" && data.driveFileId && (
                        <a
                          href={`https://drive.google.com/file/d/${data.driveFileId}/view`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-blue-500 hover:underline flex items-center gap-1 mt-0.5"
                        >
                          Open in Drive <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <XCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                    <div>
                      <p className="text-destructive text-xs font-medium">
                        {data.legacy ? "Not uploaded — path format outdated" : "File not found"}
                      </p>
                      <p className="text-muted-foreground text-xs mt-0.5">
                        {data.legacy
                          ? "This path was recorded before the Drive uploader was fixed. The file was never actually uploaded. Reprocess this email to re-file the attachment correctly."
                          : data.path
                          ? data.type === "drive"
                            ? "Drive file may have been deleted or moved."
                            : "File not found at the recorded path. It may have been moved or the storage root changed."
                          : "No path was recorded for this attachment."}
                      </p>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function EmailProcessingLog({ message, companyId, companyName, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [inspecting, setInspecting] = useState<{ attachmentId: string; filename: string } | null>(null);

  const clientQuery = useQuery({
    queryKey: ["client", message.matchedClientId],
    queryFn: () => clientsApi.get(message.matchedClientId!),
    enabled: !!message.matchedClientId,
  });
  const clientStorageQuery = useQuery({
    queryKey: ["client-storage", message.matchedClientId],
    queryFn: () => clientsApi.getStorage(message.matchedClientId!),
    enabled: !!message.matchedClientId && open,
  });
  const agentQuery = useQuery({
    queryKey: ["agent", message.matchedAgentId],
    queryFn: () => agentsApi.get(message.matchedAgentId!, companyId),
    enabled: !!message.matchedAgentId && open,
  });

  const entries: LogEntry[] = [];

  // Received
  entries.push({
    icon: "ok",
    label: "Received",
    extra: new Date(message.receivedAt).toLocaleString(),
  });

  // Company — always known from inbox context (email account links to company)
  entries.push({
    icon: "ok",
    label: `Company: ${companyName ?? companyId.slice(0, 8)}`,
  });

  // Processing state
  const state = message.processingState;
  const isProcessed = state !== "pending" && state !== "analyzing";
  const stateLabel = STATE_LABELS[state] ?? state;
  if (message.processedAt) {
    entries.push({
      icon: isProcessed ? "ok" : "pending",
      label: stateLabel,
      extra: new Date(message.processedAt).toLocaleString(),
    });
  } else if (state === "pending") {
    entries.push({ icon: "pending", label: "Routing in progress…" });
  } else {
    entries.push({ icon: "pending", label: stateLabel });
  }

  // Client match
  if (message.matchedClientId) {
    const clientName = clientQuery.data?.name ?? message.matchedClientId.slice(0, 8);
    const localPath = clientStorageQuery.data?.localPath;
    entries.push({
      icon: "ok",
      label: `Client matched: ${clientName}`,
      extra: localPath
        ? `${localPath}/Emails/`
        : clientStorageQuery.isFetching
        ? "loading…"
        : "no storage folder configured",
    });
  } else if (isProcessed) {
    entries.push({ icon: "info", label: "No client matched" });
  }

  // Agent assignment
  if (message.matchedAgentId) {
    const agentName = agentQuery.data?.name ?? message.matchedAgentId.slice(0, 8);
    entries.push({ icon: "ok", label: `Agent assigned: ${agentName}` });
  } else if (isProcessed) {
    entries.push({ icon: "info", label: "No agent assigned" });
  }

  // Issue / approval
  if (message.issueId) {
    entries.push({ icon: "ok", label: "Issue created", extra: message.issueId.slice(0, 8) });
  }
  if (message.approvalId) {
    entries.push({ icon: "ok", label: "Approval created", extra: message.approvalId.slice(0, 8) });
  }

  // Error
  if (message.errorText) {
    entries.push({ icon: "fail", label: "Processing error", extra: message.errorText });
  }

  // Attachments — full detail only on EmailMessageDetail
  if (isDetail(message)) {
    const allAtts = message.attachments.filter((a) => !a.isInline);
    if (allAtts.length > 0) {
      entries.push({ icon: "info", label: `Attachments (${allAtts.length})` });
      for (const att of allAtts) {
        if (att.filedAt && att.filedPath) {
          entries.push({
            icon: "ok",
            label: `  ${att.filename}`,
            extra: `→ ${shortFiledPath(att.filedPath)}`,
            attachmentId: att.id,
            messageId: message.id,
          });
        } else if (message.attachmentsPath) {
          entries.push({
            icon: "pending",
            label: `  ${att.filename}`,
            extra: "saved to inbox — not yet filed to client folder",
          });
        } else {
          entries.push({ icon: "fail", label: `  ${att.filename}`, extra: "not saved" });
        }
      }
    }
  } else if (message.attachmentsPath) {
    entries.push({
      icon: "info",
      label: "Has attachments",
      extra: "open email to see filing status",
    });
  }

  return (
    <>
      <div className="rounded-md border border-border/60 bg-muted/20">
        <button
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <Terminal className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 text-left truncate">
            Processing Log
            {!isDetail(message) && (
              <span className="ml-2 text-muted-foreground/60 font-normal truncate">
                — {message.subject || message.fromAddr || message.id.slice(0, 8)}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            {message.attachmentsPath && (
              <Paperclip className="h-3 w-3 text-muted-foreground/60" />
            )}
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </span>
        </button>
        {open && (
          <div className="border-t border-border/60 px-3 py-3 space-y-1.5 font-mono text-xs">
            {entries.map((e, i) => {
              const isClickable = !!(e.attachmentId && e.messageId);
              const filename = e.label.trimStart();
              return (
                <div
                  key={i}
                  className={`flex items-start gap-2 ${isClickable ? "cursor-pointer hover:bg-muted/40 rounded -mx-1 px-1 py-0.5 transition-colors group" : ""}`}
                  onClick={
                    isClickable
                      ? () => setInspecting({ attachmentId: e.attachmentId!, filename })
                      : undefined
                  }
                >
                  {ICONS[e.icon]}
                  <span
                    className={
                      e.icon === "fail"
                        ? "text-destructive"
                        : e.icon === "pending"
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-foreground/80"
                    }
                  >
                    {e.label}
                    {e.extra && <span className="text-muted-foreground ml-1 break-all">{e.extra}</span>}
                  </span>
                  {isClickable && (
                    <FolderOpen className="h-3 w-3 text-muted-foreground/40 group-hover:text-muted-foreground shrink-0 mt-0.5 ml-auto transition-colors" />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {inspecting && (
        <FiledCheckDialog
          messageId={message.id}
          attachmentId={inspecting.attachmentId}
          filename={inspecting.filename}
          onClose={() => setInspecting(null)}
        />
      )}
    </>
  );
}
