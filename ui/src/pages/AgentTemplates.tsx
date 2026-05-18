import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { LayoutTemplate, Plus, Trash2, X, Search, Sparkles } from "lucide-react";
import { agentTemplatesApi } from "../api/agentTemplates";
import type { AgentTemplateSummaryWithCount, GeneratedWorkforce } from "../api/agentTemplates";
import type { AgentTemplate, AgentTemplateDefinition, TeamStructureEntry } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { agentsApi } from "../api/agents";
import type { Agent } from "@paperclipai/shared";

// ── Layout constants ────────────────────────────────────────────────────────
const CARD_W = 180;
const CARD_H = 70;
const GAP_X = 28;
const GAP_Y = 60;
const PADDING = 40;

interface TemplateOrgNode {
  tempId: string;
  name: string;
  role: string;
  children: TemplateOrgNode[];
}

interface LayoutNode {
  tempId: string;
  name: string;
  role: string;
  x: number;
  y: number;
  children: LayoutNode[];
}

function subtreeWidth(node: TemplateOrgNode): number {
  if (node.children.length === 0) return CARD_W;
  const childrenW = node.children.reduce((sum, c) => sum + subtreeWidth(c), 0);
  const gaps = (node.children.length - 1) * GAP_X;
  return Math.max(CARD_W, childrenW + gaps);
}

function layoutTree(node: TemplateOrgNode, x: number, y: number): LayoutNode {
  const totalW = subtreeWidth(node);
  const layoutChildren: LayoutNode[] = [];

  if (node.children.length > 0) {
    const childrenW = node.children.reduce((sum, c) => sum + subtreeWidth(c), 0);
    const gaps = (node.children.length - 1) * GAP_X;
    let cx = x + (totalW - childrenW - gaps) / 2;
    for (const child of node.children) {
      const cw = subtreeWidth(child);
      layoutChildren.push(layoutTree(child, cx, y + CARD_H + GAP_Y));
      cx += cw + GAP_X;
    }
  }

  return {
    tempId: node.tempId,
    name: node.name,
    role: node.role,
    x: x + (totalW - CARD_W) / 2,
    y,
    children: layoutChildren,
  };
}

function layoutForest(roots: TemplateOrgNode[]): LayoutNode[] {
  if (roots.length === 0) return [];
  let x = PADDING;
  const y = PADDING;
  const result: LayoutNode[] = [];
  for (const root of roots) {
    const w = subtreeWidth(root);
    result.push(layoutTree(root, x, y));
    x += w + GAP_X;
  }
  return result;
}

function flattenLayout(nodes: LayoutNode[]): LayoutNode[] {
  const result: LayoutNode[] = [];
  function walk(n: LayoutNode) {
    result.push(n);
    n.children.forEach(walk);
  }
  nodes.forEach(walk);
  return result;
}

function collectEdges(nodes: LayoutNode[]): Array<{ parent: LayoutNode; child: LayoutNode }> {
  const edges: Array<{ parent: LayoutNode; child: LayoutNode }> = [];
  function walk(n: LayoutNode) {
    for (const c of n.children) {
      edges.push({ parent: n, child: c });
      walk(c);
    }
  }
  nodes.forEach(walk);
  return edges;
}

function buildOrgTree(
  agentDefinitions: AgentTemplateDefinition[],
  teamStructure: TeamStructureEntry[],
): TemplateOrgNode[] {
  const defMap = new Map<string, AgentTemplateDefinition>();
  for (const def of agentDefinitions) defMap.set(def.tempId, def);

  const childrenMap = new Map<string | null, string[]>();
  for (const entry of teamStructure) {
    const parent = entry.reportsTo ?? null;
    if (!childrenMap.has(parent)) childrenMap.set(parent, []);
    childrenMap.get(parent)!.push(entry.tempId);
  }

  function buildNode(tempId: string): TemplateOrgNode {
    const def = defMap.get(tempId);
    const childIds = childrenMap.get(tempId) ?? [];
    return {
      tempId,
      name: def?.name ?? tempId,
      role: def?.role ?? "",
      children: childIds.map(buildNode),
    };
  }

  const roots = teamStructure
    .filter((e) => e.reportsTo === null)
    .map((e) => buildNode(e.tempId));

  if (roots.length === 0 && agentDefinitions.length > 0) {
    return agentDefinitions.map((def) => ({ tempId: def.tempId, name: def.name, role: def.role, children: [] }));
  }

  return roots;
}

// ── Editor types + helpers ──────────────────────────────────────────────────
interface EditorAgent {
  tempId: string;
  name: string;
  role: string;
  adapterType: string;
  reportsTo: string | null;
}

type EditorMode = { kind: "new" } | { kind: "edit"; templateId: string } | { kind: "generate" } | null;

function toSlug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

function makeTempId(name: string): string {
  const slug = toSlug(name) || "agent";
  return `${slug}-${Math.random().toString(36).slice(2, 6)}`;
}

// ── Category badge ──────────────────────────────────────────────────────────
const categoryColors: Record<string, string> = {
  dev: "bg-blue-500/15 text-blue-400",
  sales: "bg-green-500/15 text-green-400",
  finance: "bg-yellow-500/15 text-yellow-400",
  support: "bg-purple-500/15 text-purple-400",
  custom: "bg-muted text-muted-foreground",
};

function CategoryBadge({ category }: { category: string }) {
  const cls = categoryColors[category] ?? categoryColors.custom;
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls}`}>
      {category}
    </span>
  );
}

// ── Template card (left pane) ───────────────────────────────────────────────
function TemplateCard({
  template,
  selected,
  onSelect,
}: {
  template: AgentTemplateSummaryWithCount;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        "w-full text-left rounded-lg border px-3 py-2.5 transition-colors",
        selected
          ? "border-foreground/30 bg-accent"
          : "border-border bg-card hover:bg-accent/50",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium leading-snug truncate">{template.name}</span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
            template.sourceType === "built_in"
              ? "bg-blue-500/10 text-blue-400"
              : "bg-orange-500/10 text-orange-400"
          }`}
        >
          {template.sourceType === "built_in" ? "Built-in" : "Custom"}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <CategoryBadge category={template.category} />
        <span className="text-[11px] text-muted-foreground">{template.agentCount} agent{template.agentCount !== 1 ? "s" : ""}</span>
      </div>
    </button>
  );
}

// ── Detail pane ─────────────────────────────────────────────────────────────
function TemplateDetail({ templateId, onEdit }: { templateId: string; onEdit: (template: AgentTemplate) => void }) {
  const { companies, selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const [deployCompanyId, setDeployCompanyId] = useState<string>(selectedCompanyId ?? "");

  const { data: template, isLoading } = useQuery({
    queryKey: queryKeys.agentTemplates.detail(templateId),
    queryFn: () => agentTemplatesApi.get(templateId),
  });

  const deploy = useMutation({
    mutationFn: () => agentTemplatesApi.deploy(templateId, deployCompanyId),
    onSuccess: (result) => {
      pushToast({
        tone: "success",
        title: `Deployed ${result.agentIds.length} agent${result.agentIds.length !== 1 ? "s" : ""}`,
        body: result.agentNames.join(", "),
      });
    },
    onError: (err) => {
      pushToast({
        tone: "error",
        title: "Deploy failed",
        body: err instanceof Error ? err.message : "Unknown error",
      });
    },
  });

  useEffect(() => {
    if (selectedCompanyId && !deployCompanyId) setDeployCompanyId(selectedCompanyId);
  }, [selectedCompanyId, deployCompanyId]);

  if (isLoading) return <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">Loading...</div>;
  if (!template) return null;

  return <TemplateDetailContent template={template} companies={companies} deployCompanyId={deployCompanyId} setDeployCompanyId={setDeployCompanyId} deploy={deploy} onEdit={onEdit} />;
}

function TemplateDetailContent({
  template,
  companies,
  deployCompanyId,
  setDeployCompanyId,
  deploy,
  onEdit,
}: {
  template: AgentTemplate;
  companies: Array<{ id: string; name: string }>;
  deployCompanyId: string;
  setDeployCompanyId: (id: string) => void;
  deploy: { mutate: () => void; isPending: boolean };
  onEdit: (template: AgentTemplate) => void;
}) {
  const orgRoots = useMemo(
    () => buildOrgTree(template.agentDefinitions, template.teamStructure),
    [template.agentDefinitions, template.teamStructure],
  );

  const layout = useMemo(() => layoutForest(orgRoots), [orgRoots]);
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const edges = useMemo(() => collectEdges(layout), [layout]);

  const svgBounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 400, height: 200 };
    let maxX = 0, maxY = 0;
    for (const n of allNodes) {
      maxX = Math.max(maxX, n.x + CARD_W);
      maxY = Math.max(maxY, n.y + CARD_H);
    }
    return { width: maxX + PADDING, height: maxY + PADDING };
  }, [allNodes]);

  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(new Set());

  return (
    <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-semibold">{template.name}</h2>
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                template.sourceType === "built_in"
                  ? "bg-blue-500/10 text-blue-400"
                  : "bg-orange-500/10 text-orange-400"
              }`}
            >
              {template.sourceType === "built_in" ? "Built-in" : "Custom"}
            </span>
            {template.metadata?.customized === true && (
              <span className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-yellow-500/10 text-yellow-400">
                Customized
              </span>
            )}
            <CategoryBadge category={template.category} />
          </div>
          {template.description && (
            <p className="text-sm text-muted-foreground">{template.description}</p>
          )}
        </div>
        <Button variant="outline" size="sm" className="h-7 text-xs shrink-0" onClick={() => onEdit(template)}>
          Edit
        </Button>
      </div>

      {/* Deploy row */}
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={deployCompanyId}
          onChange={(e) => setDeployCompanyId(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        >
          {companies.length === 0 && <option value="">No companies</option>}
          {companies.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={!deployCompanyId || deploy.isPending}
          onClick={() => deploy.mutate()}
        >
          {deploy.isPending ? "Deploying..." : "Deploy"}
        </Button>
      </div>

      {/* Org chart */}
      {allNodes.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Org Chart</h3>
          <div
            className="border border-border rounded-lg bg-muted/20 overflow-auto"
            style={{ maxHeight: 280 }}
          >
            <svg
              width={svgBounds.width}
              height={svgBounds.height}
              style={{ display: "block" }}
            >
              {edges.map(({ parent, child }) => {
                const x1 = parent.x + CARD_W / 2;
                const y1 = parent.y + CARD_H;
                const x2 = child.x + CARD_W / 2;
                const y2 = child.y;
                const midY = (y1 + y2) / 2;
                return (
                  <path
                    key={`${parent.tempId}-${child.tempId}`}
                    d={`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`}
                    fill="none"
                    stroke="var(--border)"
                    strokeWidth={1.5}
                  />
                );
              })}
              {allNodes.map((node) => (
                <g key={node.tempId} transform={`translate(${node.x}, ${node.y})`}>
                  <rect
                    width={CARD_W}
                    height={CARD_H}
                    rx={8}
                    fill="var(--card)"
                    stroke="var(--border)"
                    strokeWidth={1}
                  />
                  <text
                    x={CARD_W / 2}
                    y={26}
                    textAnchor="middle"
                    fontSize={12}
                    fontWeight={600}
                    fill="var(--foreground)"
                  >
                    {node.name.length > 20 ? node.name.slice(0, 18) + "…" : node.name}
                  </text>
                  <text
                    x={CARD_W / 2}
                    y={44}
                    textAnchor="middle"
                    fontSize={10}
                    fill="var(--muted-foreground)"
                  >
                    {node.role.length > 24 ? node.role.slice(0, 22) + "…" : node.role}
                  </text>
                </g>
              ))}
            </svg>
          </div>
        </div>
      )}

      {/* Agent list */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Agents ({template.agentDefinitions.length})
        </h3>
        <div className="space-y-1">
          {template.agentDefinitions.map((def) => {
            const expanded = expandedAgents.has(def.tempId);
            return (
              <div key={def.tempId} className="rounded-md border border-border overflow-hidden">
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-accent/40 transition-colors"
                  onClick={() => {
                    setExpandedAgents((prev) => {
                      const next = new Set(prev);
                      if (next.has(def.tempId)) next.delete(def.tempId);
                      else next.add(def.tempId);
                      return next;
                    });
                  }}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium truncate">{def.name}</span>
                    <span className="text-xs text-muted-foreground truncate hidden sm:block">{def.role}</span>
                  </div>
                  <span className="text-[10px] text-muted-foreground font-mono shrink-0 ml-2">{def.adapterType}</span>
                </button>
                {expanded && (
                  <div className="px-3 pb-2 pt-1 bg-muted/20 border-t border-border text-xs text-muted-foreground space-y-0.5">
                    <div><span className="font-medium text-foreground">Role:</span> {def.role}</div>
                    <div><span className="font-medium text-foreground">Adapter:</span> {def.adapterType}</div>
                    {def.capabilities && (
                      <div><span className="font-medium text-foreground">Capabilities:</span> {def.capabilities}</div>
                    )}
                    {def.skills.length > 0 && (
                      <div><span className="font-medium text-foreground">Skills:</span> {def.skills.join(", ")}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Template editor ─────────────────────────────────────────────────────────
const TEMPLATE_ROLES = ["orchestrator", "worker", "observer"] as const;
const TEMPLATE_ADAPTERS = ["ea", "claude_local", "codex_local", "gemini_local", "cursor", "opencode_local"] as const;

function AgentEditorList({
  agents,
  setAgents,
  onPickExisting,
}: {
  agents: EditorAgent[];
  setAgents: (v: EditorAgent[]) => void;
  onPickExisting: () => void;
}) {
  function addBlank() {
    const tempId = makeTempId("agent");
    const rootExists = agents.some((a) => a.reportsTo === null);
    setAgents([
      ...agents,
      {
        tempId,
        name: "",
        role: rootExists ? "worker" : "orchestrator",
        adapterType: "ea",
        reportsTo: rootExists ? (agents.find((a) => a.reportsTo === null)?.tempId ?? null) : null,
      },
    ]);
  }

  function updateAgent(tempId: string, patch: Partial<EditorAgent>) {
    setAgents(agents.map((a) => (a.tempId === tempId ? { ...a, ...patch } : a)));
  }

  function removeAgent(tempId: string) {
    setAgents(
      agents
        .filter((a) => a.tempId !== tempId)
        .map((a) => (a.reportsTo === tempId ? { ...a, reportsTo: null } : a)),
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Agents ({agents.length})
        </h3>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={addBlank}>
            <Plus className="h-3 w-3" />
            New
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={onPickExisting}>
            <Plus className="h-3 w-3" />
            From existing
          </Button>
        </div>
      </div>

      {agents.length === 0 && (
        <p className="text-xs text-muted-foreground py-2">Add at least one agent.</p>
      )}

      <div className="space-y-1.5">
        {agents.map((agent) => (
          <div key={agent.tempId} className="rounded-md border border-border bg-card px-3 py-2 space-y-2">
            <div className="flex items-center gap-2">
              <Input
                value={agent.name}
                onChange={(e) => updateAgent(agent.tempId, { name: e.target.value })}
                placeholder="Agent name"
                className="h-7 text-xs flex-1"
              />
              <button
                type="button"
                onClick={() => removeAgent(agent.tempId)}
                className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-0.5">
                <label className="text-[10px] text-muted-foreground">Role</label>
                <select
                  value={agent.role}
                  onChange={(e) => updateAgent(agent.tempId, { role: e.target.value })}
                  className="h-7 w-full rounded border border-border bg-background px-1.5 text-xs text-foreground focus:outline-none"
                >
                  {TEMPLATE_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="space-y-0.5">
                <label className="text-[10px] text-muted-foreground">Adapter</label>
                <select
                  value={agent.adapterType}
                  onChange={(e) => updateAgent(agent.tempId, { adapterType: e.target.value })}
                  className="h-7 w-full rounded border border-border bg-background px-1.5 text-xs text-foreground focus:outline-none"
                >
                  {TEMPLATE_ADAPTERS.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </div>
              <div className="space-y-0.5">
                <label className="text-[10px] text-muted-foreground">Reports to</label>
                <select
                  value={agent.reportsTo ?? ""}
                  onChange={(e) => updateAgent(agent.tempId, { reportsTo: e.target.value || null })}
                  className="h-7 w-full rounded border border-border bg-background px-1.5 text-xs text-foreground focus:outline-none"
                >
                  <option value="">— root —</option>
                  {agents
                    .filter((a) => a.tempId !== agent.tempId)
                    .map((a) => (
                      <option key={a.tempId} value={a.tempId}>
                        {a.name || a.tempId}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExistingAgentPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (agent: Pick<Agent, "name" | "role" | "adapterType">) => void;
}) {
  const { companies } = useCompany();
  const [search, setSearch] = useState("");
  const [allAgents, setAllAgents] = useState<Array<Agent & { companyName: string }>>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!open || companies.length === 0) return;
    setIsLoading(true);
    Promise.all(
      companies.map((c) =>
        agentsApi.list(c.id).then((agents) =>
          agents.map((a) => ({ ...a, companyName: c.name }))
        )
      )
    ).then((results) => {
      setAllAgents(results.flat());
      setIsLoading(false);
    }).catch(() => {
      setIsLoading(false);
    });
  }, [open, companies]);

  const filtered = allAgents.filter(
    (a) =>
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.companyName.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Pick an existing agent</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agents…"
              className="pl-8 h-8 text-sm"
            />
          </div>
          {isLoading && <p className="text-sm text-muted-foreground text-center py-4">Loading agents…</p>}
          {!isLoading && filtered.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No agents found.</p>
          )}
          <div className="max-h-72 overflow-y-auto space-y-0.5">
            {filtered.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => onPick({ name: agent.name, role: agent.role, adapterType: agent.adapterType })}
                className="w-full text-left flex items-center justify-between px-3 py-2 rounded-md hover:bg-accent/50 transition-colors"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{agent.name}</div>
                  <div className="text-xs text-muted-foreground">{agent.companyName}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  <span className="text-[10px] text-muted-foreground font-mono">{agent.adapterType}</span>
                  <span className="text-[10px] text-muted-foreground">{agent.role}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TemplateEditor({
  mode,
  name, setName,
  slug, setSlug,
  description, setDescription,
  category, setCategory,
  agents, setAgents,
  slugError, setSlugError,
  onCancel,
  onSaved,
}: {
  mode: { kind: "new" } | { kind: "edit"; templateId: string };
  name: string; setName: (v: string) => void;
  slug: string; setSlug: (v: string) => void;
  description: string; setDescription: (v: string) => void;
  category: string; setCategory: (v: string) => void;
  agents: EditorAgent[]; setAgents: (v: EditorAgent[]) => void;
  slugError: string | null; setSlugError: (v: string | null) => void;
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);

  const saveMutation = useMutation({
    mutationFn: () => {
      const agentDefinitions: AgentTemplateDefinition[] = agents.map((a) => ({
        tempId: a.tempId,
        name: a.name,
        role: a.role,
        adapterType: a.adapterType,
        adapterConfig: {},
        permissions: {},
        budgetMonthlyCents: 0,
        skills: [],
      }));
      const teamStructure: TeamStructureEntry[] = agents.map((a) => ({
        tempId: a.tempId,
        reportsTo: a.reportsTo,
      }));
      if (mode.kind === "new") {
        return agentTemplatesApi.create({ name, slug, description: description || undefined, category, agentDefinitions, teamStructure });
      }
      return agentTemplatesApi.update(mode.templateId, { name, description: description || undefined, category, agentDefinitions, teamStructure });
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTemplates.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTemplates.detail(saved.id) });
      pushToast({ tone: "success", title: "Template saved" });
      setSlugError(null);
      onSaved(saved.id);
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Failed to save template";
      if (msg.toLowerCase().includes("slug")) {
        setSlugError(msg);
      } else {
        pushToast({ tone: "error", title: "Save failed", body: msg });
      }
    },
  });

  return (
    <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5 space-y-5">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold">
          {mode.kind === "new" ? "New Template" : "Edit Template"}
        </h2>
        <Button variant="ghost" size="icon-xs" onClick={onCancel}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Name *</label>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (mode.kind === "new") setSlug(toSlug(e.target.value));
              }}
              placeholder="Dev Team"
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Slug *</label>
            <Input
              value={slug}
              onChange={(e) => { setSlug(e.target.value); setSlugError(null); }}
              placeholder="dev-team"
              pattern="[a-z0-9-]+"
              className="h-8 text-sm font-mono"
              readOnly={mode.kind === "edit"}
            />
            {slugError && <p className="text-xs text-destructive">{slugError}</p>}
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Description</label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this team does…"
            rows={2}
            className="text-sm resize-none"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            {["dev", "sales", "finance", "support", "custom"].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
      </div>

      <AgentEditorList
        agents={agents}
        setAgents={setAgents}
        onPickExisting={() => setPickerOpen(true)}
      />

      <ExistingAgentPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(agent) => {
          const tempId = makeTempId(agent.name);
          const rootExists = agents.some((a) => a.reportsTo === null);
          setAgents([
            ...agents,
            {
              tempId,
              name: agent.name,
              role: agent.role,
              adapterType: agent.adapterType,
              reportsTo: rootExists ? (agents.find((a) => a.reportsTo === null)?.tempId ?? null) : null,
            },
          ]);
          setPickerOpen(false);
        }}
      />

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={saveMutation.isPending}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={saveMutation.isPending || !name.trim() || !slug.trim() || agents.length === 0}
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? "Saving…" : "Save Template"}
        </Button>
      </div>
    </div>
  );
}

// ── Generation wizard ────────────────────────────────────────────────────────
type GenStep = "prompt" | "loading" | "preview";

function GenerationWizard({
  onCancel,
  onSaved,
}: {
  onCancel: () => void;
  onSaved: (id: string) => void;
}) {
  const { companies, selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<GenStep>("prompt");
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<GeneratedWorkforce | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [deployCompanyId, setDeployCompanyId] = useState<string>(selectedCompanyId ?? "");

  const orgRoots = useMemo(
    () => (result ? buildOrgTree(result.agentDefinitions, result.teamStructure) : []),
    [result],
  );
  const layout = useMemo(() => layoutForest(orgRoots), [orgRoots]);
  const allNodes = useMemo(() => flattenLayout(layout), [layout]);
  const edges = useMemo(() => collectEdges(layout), [layout]);
  const svgBounds = useMemo(() => {
    if (allNodes.length === 0) return { width: 400, height: 200 };
    let maxX = 0, maxY = 0;
    for (const n of allNodes) { maxX = Math.max(maxX, n.x + CARD_W); maxY = Math.max(maxY, n.y + CARD_H); }
    return { width: maxX + PADDING, height: maxY + PADDING };
  }, [allNodes]);

  const generateMutation = useMutation({
    mutationFn: () => agentTemplatesApi.generate(prompt),
    onSuccess: (data) => { setResult(data); setStep("preview"); setGenError(null); },
    onError: (err) => {
      setGenError(err instanceof Error ? err.message : "Generation failed. Please try again.");
      setStep("prompt");
    },
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      agentTemplatesApi.create({
        name: result!.name,
        slug: result!.slug,
        description: result!.description || undefined,
        category: result!.category,
        agentDefinitions: result!.agentDefinitions,
        teamStructure: result!.teamStructure,
      }),
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTemplates.all });
      pushToast({ tone: "success", title: "Template saved" });
      onSaved(saved.id);
    },
    onError: (err) => {
      pushToast({ tone: "error", title: "Save failed", body: err instanceof Error ? err.message : "Unknown error" });
    },
  });

  const deployMutation = useMutation({
    mutationFn: async () => {
      const saved = await agentTemplatesApi.create({
        name: result!.name,
        slug: result!.slug,
        description: result!.description || undefined,
        category: result!.category,
        agentDefinitions: result!.agentDefinitions,
        teamStructure: result!.teamStructure,
      });
      return agentTemplatesApi.deploy(saved.id, deployCompanyId);
    },
    onSuccess: (deployResult) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.agentTemplates.all });
      pushToast({
        tone: "success",
        title: `Deployed ${deployResult.agentIds.length} agent${deployResult.agentIds.length !== 1 ? "s" : ""}`,
        body: deployResult.agentNames.join(", "),
      });
      onCancel();
    },
    onError: (err) => {
      pushToast({ tone: "error", title: "Deploy failed", body: err instanceof Error ? err.message : "Unknown error" });
    },
  });

  if (step === "loading") {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <div className="animate-spin h-6 w-6 rounded-full border-2 border-border border-t-foreground" />
        <p className="text-sm text-muted-foreground">Generating your workforce…</p>
        <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    );
  }

  if (step === "preview" && result) {
    return (
      <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-semibold">{result.name}</h2>
              <CategoryBadge category={result.category} />
            </div>
            {result.description && <p className="text-sm text-muted-foreground">{result.description}</p>}
          </div>
        </div>

        {allNodes.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Org Chart</h3>
            <div className="border border-border rounded-lg bg-muted/20 overflow-auto" style={{ maxHeight: 280 }}>
              <svg width={svgBounds.width} height={svgBounds.height} style={{ display: "block" }}>
                {edges.map(({ parent, child }) => {
                  const x1 = parent.x + CARD_W / 2;
                  const y1 = parent.y + CARD_H;
                  const x2 = child.x + CARD_W / 2;
                  const y2 = child.y;
                  const midY = (y1 + y2) / 2;
                  return (
                    <path
                      key={`${parent.tempId}-${child.tempId}`}
                      d={`M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2}`}
                      fill="none" stroke="var(--border)" strokeWidth={1.5}
                    />
                  );
                })}
                {allNodes.map((node) => (
                  <g key={node.tempId} transform={`translate(${node.x}, ${node.y})`}>
                    <rect width={CARD_W} height={CARD_H} rx={8} fill="var(--card)" stroke="var(--border)" strokeWidth={1} />
                    <text x={CARD_W / 2} y={26} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--foreground)">
                      {node.name.length > 20 ? node.name.slice(0, 18) + "…" : node.name}
                    </text>
                    <text x={CARD_W / 2} y={44} textAnchor="middle" fontSize={10} fill="var(--muted-foreground)">
                      {node.role.length > 24 ? node.role.slice(0, 22) + "…" : node.role}
                    </text>
                  </g>
                ))}
              </svg>
            </div>
          </div>
        )}

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Agents ({result.agentDefinitions.length})
          </h3>
          <div className="space-y-1">
            {result.agentDefinitions.map((def) => (
              <div key={def.tempId} className="rounded-md border border-border px-3 py-2 space-y-0.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{def.name}</span>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-muted-foreground">{def.role}</span>
                    <span className="text-[10px] text-muted-foreground font-mono">{def.adapterType}</span>
                  </div>
                </div>
                {def.instructionsContent && (
                  <p className="text-xs text-muted-foreground line-clamp-2">{def.instructionsContent}</p>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 pt-2 border-t border-border flex-wrap">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setStep("prompt")}>Try Again</Button>
            <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              disabled={saveMutation.isPending || deployMutation.isPending}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? "Saving…" : "Save as Template"}
            </Button>
            <select
              value={deployCompanyId}
              onChange={(e) => setDeployCompanyId(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {companies.length === 0 && <option value="">No companies</option>}
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <Button
              size="sm"
              disabled={!deployCompanyId || deployMutation.isPending || saveMutation.isPending}
              onClick={() => deployMutation.mutate()}
            >
              {deployMutation.isPending ? "Deploying…" : "Deploy →"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0 overflow-y-auto px-6 py-5 space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-base font-semibold">Generate Workforce with AI</h2>
        </div>
        <Button variant="ghost" size="icon-xs" onClick={onCancel}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {genError && (
        <p className="text-sm text-destructive rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
          {genError}
        </p>
      )}

      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Describe the team you need</label>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder='e.g. "A sales team for a B2B SaaS company with a manager and 3 account executives"'
          rows={4}
          className="text-sm resize-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim()) {
              setStep("loading");
              generateMutation.mutate();
            }
          }}
        />
        <p className="text-[11px] text-muted-foreground">Tip: Cmd+Enter to generate</p>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
        <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        <Button
          size="sm"
          disabled={!prompt.trim() || generateMutation.isPending}
          onClick={() => { setStep("loading"); generateMutation.mutate(); }}
        >
          Generate →
        </Button>
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export function AgentTemplates() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editorMode, setEditorMode] = useState<EditorMode>(null);
  const [editorName, setEditorName] = useState("");
  const [editorSlug, setEditorSlug] = useState("");
  const [editorDescription, setEditorDescription] = useState("");
  const [editorCategory, setEditorCategory] = useState("custom");
  const [editorAgents, setEditorAgents] = useState<EditorAgent[]>([]);
  const [editorSlugError, setEditorSlugError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Instance Settings" }, { label: "Agent Templates" }]);
  }, [setBreadcrumbs]);

  const { data: templates, isLoading } = useQuery({
    queryKey: queryKeys.agentTemplates.all,
    queryFn: () => agentTemplatesApi.list(),
  });

  if (isLoading) return <PageSkeleton />;

  return (
    <div className="flex h-full min-h-0 gap-0">
      {/* Left pane */}
      <div className="w-72 shrink-0 flex flex-col border-r border-border h-full min-h-0">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h1 className="text-sm font-semibold">Agent Templates</h1>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => {
              setEditorMode({ kind: "new" });
              setEditorName("");
              setEditorSlug("");
              setEditorDescription("");
              setEditorCategory("custom");
              setEditorAgents([]);
              setEditorSlugError(null);
            }}
          >
            New Template
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-1.5">
          {(templates ?? []).map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              selected={t.id === selectedId}
              onSelect={() => setSelectedId(t.id)}
            />
          ))}
        </div>
      </div>

      {/* Right pane */}
      <div className="flex-1 min-w-0 flex flex-col h-full min-h-0">
        {editorMode?.kind === "generate" ? (
          <GenerationWizard
            onCancel={() => setEditorMode(null)}
            onSaved={(id) => { setEditorMode(null); setSelectedId(id); }}
          />
        ) : editorMode ? (
          <TemplateEditor
            mode={editorMode}
            name={editorName} setName={setEditorName}
            slug={editorSlug} setSlug={setEditorSlug}
            description={editorDescription} setDescription={setEditorDescription}
            category={editorCategory} setCategory={setEditorCategory}
            agents={editorAgents} setAgents={setEditorAgents}
            slugError={editorSlugError} setSlugError={setEditorSlugError}
            onCancel={() => setEditorMode(null)}
            onSaved={(id) => { setEditorMode(null); setSelectedId(id); }}
          />
        ) : selectedId ? (
          <TemplateDetail key={selectedId} templateId={selectedId} onEdit={(template) => {
            setEditorMode({ kind: "edit", templateId: template.id });
            setEditorName(template.name);
            setEditorSlug(template.slug);
            setEditorDescription(template.description ?? "");
            setEditorCategory(template.category);
            setEditorAgents(
              template.agentDefinitions.map((def) => {
                const entry = template.teamStructure.find((e) => e.tempId === def.tempId);
                return {
                  tempId: def.tempId,
                  name: def.name,
                  role: def.role,
                  adapterType: def.adapterType,
                  reportsTo: entry?.reportsTo ?? null,
                };
              })
            );
            setEditorSlugError(null);
          }} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            {(!templates || templates.length === 0) ? (
              <EmptyState icon={LayoutTemplate} message="No templates yet. Create one to get started." />
            ) : (
              <p className="text-sm text-muted-foreground">Select a template to view details.</p>
            )}
            <div className="flex items-center gap-2 mt-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => {
                  setEditorMode({ kind: "new" });
                  setEditorName("");
                  setEditorSlug("");
                  setEditorDescription("");
                  setEditorCategory("custom");
                  setEditorAgents([]);
                  setEditorSlugError(null);
                }}
              >
                New Template
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1"
                onClick={() => setEditorMode({ kind: "generate" })}
              >
                <Sparkles className="h-3 w-3" />
                Generate with AI
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
