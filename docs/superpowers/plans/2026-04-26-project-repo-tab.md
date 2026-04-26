# Project Repo Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Repo" tab to the ProjectDetail page that shows git history, commit diffs, file tree, file content, and a board-only interactive terminal — all scoped to the project workspace `cwd`.

**Architecture:** Backend adds a `repoRoutes` Express router under `/projects/:id/repo/*` that shells out to `git` and `fs` using the primary workspace's `cwd`. Terminal is a board-only SSE-streamed GET endpoint. Frontend adds a `RepoTab` component and a reusable `Terminal` component, both wired into the existing `ProjectDetail` tab system.

**Tech Stack:** Node.js `child_process.execFile` + `spawn` (no new deps), Express 5 SSE, React 19, TanStack Query, native `EventSource`, Tailwind 4.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `server/src/routes/repo.ts` | git log, show, tree, file read, terminal SSE |
| Modify | `server/src/app.ts` | register `repoRoutes` |
| Create | `ui/src/api/repo.ts` | API client (typed fetchers + EventSource helper) |
| Create | `ui/src/components/Terminal.tsx` | reusable SSE terminal (input → stream → output) |
| Create | `ui/src/pages/RepoTab.tsx` | full repo tab UI: commit list, diff panel, file tree, viewer |
| Modify | `ui/src/pages/ProjectDetail.tsx` | add "repo" tab type, bar item, and content block |

---

### Task 1: Backend — read-only repo routes

**Files:**
- Create: `server/src/routes/repo.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/repo.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { companies, createDb, projects, projectWorkspaces } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import express from "express";
import request from "supertest";
import { repoRoutes } from "../routes/repo.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function makeTestRepo() {
  const dir = mkdtempSync(join(tmpdir(), "paperclip-repo-test-"));
  execSync("git init", { cwd: dir });
  execSync('git config user.email "test@test.com"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, "hello.txt"), "Hello world\n");
  execSync("git add .", { cwd: dir });
  execSync('git commit -m "initial commit"', { cwd: dir });
  writeFileSync(join(dir, "src/index.ts"), "export const x = 1;\n", { recursive: true } as any);
  execSync("mkdir -p src && git add . && git commit -m 'add index'", { cwd: dir, shell: true });
  return dir;
}

describeEmbeddedPostgres("repoRoutes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let repoDir: string;
  let projectId: string;
  let app: ReturnType<typeof express>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-repo-");
    db = createDb(tempDb.connectionString);

    repoDir = makeTestRepo();

    const [company] = await db.insert(companies).values({ name: "Co", issuePrefix: "CO" }).returning();
    const [project] = await db.insert(projects).values({ companyId: company!.id, name: "P", status: "active" }).returning();
    await db.insert(projectWorkspaces).values({
      companyId: company!.id,
      projectId: project!.id,
      name: "local",
      cwd: repoDir,
      isPrimary: true,
    });
    projectId = project!.id;

    app = express();
    app.use(express.json());
    // Fake board actor for all requests
    app.use((req, _res, next) => {
      (req as any).actor = { type: "board", source: "local_implicit" };
      next();
    });
    app.use(repoRoutes(db));
  }, 60_000);

  afterAll(async () => {
    rmSync(repoDir, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  it("GET /projects/:id/repo/log returns commits", async () => {
    const res = await request(app).get(`/projects/${projectId}/repo/log`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0]).toMatchObject({ sha: expect.any(String), message: expect.any(String) });
  });

  it("GET /projects/:id/repo/show/:sha returns diff", async () => {
    const logRes = await request(app).get(`/projects/${projectId}/repo/log`);
    const sha = logRes.body[0].sha;
    const res = await request(app).get(`/projects/${projectId}/repo/show/${sha}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.diff).toBe("string");
    expect(res.body.diff.length).toBeGreaterThan(0);
  });

  it("GET /projects/:id/repo/tree returns file list", async () => {
    const res = await request(app).get(`/projects/${projectId}/repo/tree`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const paths = res.body.map((f: any) => f.path);
    expect(paths).toContain("hello.txt");
  });

  it("GET /projects/:id/repo/file returns content", async () => {
    const res = await request(app).get(`/projects/${projectId}/repo/file?path=hello.txt`);
    expect(res.status).toBe(200);
    expect(res.body.content).toContain("Hello");
  });

  it("GET /projects/:id/repo/file rejects path traversal", async () => {
    const res = await request(app).get(`/projects/${projectId}/repo/file?path=../../etc/passwd`);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd /home/jayjay/Work/Develtech/paperclip-v3-phase-2
pnpm vitest run server/src/__tests__/repo.test.ts
```

Expected: FAIL — `Cannot find module '../routes/repo.js'`

- [ ] **Step 3: Create `server/src/routes/repo.ts`**

```typescript
import { Router } from "express";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projectWorkspaces, projects } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const execFileAsync = promisify(execFile);

async function resolveCwd(db: Db, projectId: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(projectWorkspaces)
    .where(and(eq(projectWorkspaces.projectId, projectId), eq(projectWorkspaces.isPrimary, true)))
    .limit(1);
  const cwd = rows[0]?.cwd;
  if (!cwd) return null;
  try {
    await access(cwd);
    return cwd;
  } catch {
    return null;
  }
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

const SEP = "\x1f";
const REC = "\x1e";

async function gitLog(cwd: string, n = 100) {
  const out = await git(
    ["log", `-${n}`, `--format=%H${SEP}%h${SEP}%an${SEP}%aI${SEP}%s${REC}`],
    cwd,
  );
  return out
    .split(REC)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, shortSha, author, date, message] = rec.split(SEP);
      return { sha, shortSha, author, date, message };
    });
}

async function gitShow(cwd: string, sha: string) {
  // Validate sha is a valid hex commit reference to prevent injection
  if (!/^[0-9a-f]{4,64}$/i.test(sha)) throw new Error("Invalid sha");
  const diff = await git(["show", "--stat", "--patch", sha], cwd);
  return { sha, diff };
}

async function gitTree(cwd: string) {
  const out = await git(["ls-files"], cwd);
  const files = out.split("\n").filter(Boolean);
  // Build nested tree
  const root: TreeNode[] = [];
  for (const filePath of files) {
    const parts = filePath.split("/");
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      const isFile = i === parts.length - 1;
      if (isFile) {
        current.push({ type: "file", name, path: filePath });
      } else {
        let dir = current.find((n) => n.type === "dir" && n.name === name);
        if (!dir) {
          dir = { type: "dir", name, path: parts.slice(0, i + 1).join("/"), children: [] };
          current.push(dir);
        }
        current = (dir as DirNode).children;
      }
    }
  }
  return root;
}

interface FileNode {
  type: "file";
  name: string;
  path: string;
}
interface DirNode {
  type: "dir";
  name: string;
  path: string;
  children: TreeNode[];
}
type TreeNode = FileNode | DirNode;

export function repoRoutes(db: Db) {
  const router = Router();

  async function getProjectWithCompany(projectId: string) {
    const rows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    return rows[0] ?? null;
  }

  router.get("/projects/:id/repo/log", async (req, res) => {
    const project = await getProjectWithCompany(req.params.id as string);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    assertCompanyAccess(req, project.companyId);
    const cwd = await resolveCwd(db, project.id);
    if (!cwd) { res.status(422).json({ error: "No local workspace configured" }); return; }
    const entries = await gitLog(cwd);
    res.json(entries);
  });

  router.get("/projects/:id/repo/show/:sha", async (req, res) => {
    const project = await getProjectWithCompany(req.params.id as string);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    assertCompanyAccess(req, project.companyId);
    const cwd = await resolveCwd(db, project.id);
    if (!cwd) { res.status(422).json({ error: "No local workspace configured" }); return; }
    const result = await gitShow(cwd, req.params.sha as string);
    res.json(result);
  });

  router.get("/projects/:id/repo/tree", async (req, res) => {
    const project = await getProjectWithCompany(req.params.id as string);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    assertCompanyAccess(req, project.companyId);
    const cwd = await resolveCwd(db, project.id);
    if (!cwd) { res.status(422).json({ error: "No local workspace configured" }); return; }
    const tree = await gitTree(cwd);
    res.json(tree);
  });

  router.get("/projects/:id/repo/file", async (req, res) => {
    const project = await getProjectWithCompany(req.params.id as string);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    assertCompanyAccess(req, project.companyId);
    const cwd = await resolveCwd(db, project.id);
    if (!cwd) { res.status(422).json({ error: "No local workspace configured" }); return; }

    const filePath = req.query.path as string;
    if (!filePath) { res.status(400).json({ error: "path query param required" }); return; }

    // Prevent path traversal
    const abs = resolve(join(cwd, filePath));
    if (!abs.startsWith(resolve(cwd) + "/") && abs !== resolve(cwd)) {
      res.status(400).json({ error: "Path outside workspace" });
      return;
    }

    let content: string;
    try {
      content = await readFile(abs, "utf-8");
    } catch {
      res.status(404).json({ error: "File not found" });
      return;
    }

    res.json({ path: filePath, content });
  });

  // Terminal — board only, SSE streaming
  router.get("/projects/:id/repo/terminal", async (req, res) => {
    assertBoard(req);
    const project = await getProjectWithCompany(req.params.id as string);
    if (!project) { res.status(404).json({ error: "Project not found" }); return; }
    const cwd = await resolveCwd(db, project.id);
    if (!cwd) { res.status(422).json({ error: "No local workspace configured" }); return; }

    const cmd = req.query.cmd as string;
    if (!cmd) { res.status(400).json({ error: "cmd query param required" }); return; }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write(":ok\n\n");

    const proc = spawn("sh", ["-c", cmd], { cwd });

    proc.stdout.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        res.write(`event: stdout\ndata: ${JSON.stringify(line)}\n\n`);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        res.write(`event: stderr\ndata: ${JSON.stringify(line)}\n\n`);
      }
    });

    proc.on("close", (code) => {
      res.write(`event: exit\ndata: ${JSON.stringify({ code })}\n\n`);
      res.end();
    });

    req.on("close", () => proc.kill());
  });

  return router;
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run server/src/__tests__/repo.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/repo.ts server/src/__tests__/repo.test.ts
git commit -m "feat: add read-only repo routes (git log, show, tree, file) + terminal SSE"
```

---

### Task 2: Register repo routes in app.ts

**Files:**
- Modify: `server/src/app.ts`

- [ ] **Step 1: Add import**

In `server/src/app.ts`, add to the imports block (near other v3 route imports):

```typescript
import { repoRoutes } from "./routes/repo.js";
```

- [ ] **Step 2: Register route**

After the `operatorMessageRoutes` line (line 183), add:

```typescript
api.use(repoRoutes(db)); // v3: project repo tab
```

- [ ] **Step 3: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/app.ts
git commit -m "feat: register repoRoutes in app"
```

---

### Task 3: Frontend API client

**Files:**
- Create: `ui/src/api/repo.ts`

- [ ] **Step 1: Write the file**

```typescript
import { api } from "./client";

export interface CommitEntry {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  message: string;
}

export interface CommitDiff {
  sha: string;
  diff: string;
}

export type TreeNode =
  | { type: "file"; name: string; path: string }
  | { type: "dir"; name: string; path: string; children: TreeNode[] };

export interface FileContent {
  path: string;
  content: string;
}

export const repoApi = {
  log: (projectId: string) =>
    api.get<CommitEntry[]>(`/projects/${projectId}/repo/log`),

  show: (projectId: string, sha: string) =>
    api.get<CommitDiff>(`/projects/${projectId}/repo/show/${encodeURIComponent(sha)}`),

  tree: (projectId: string) =>
    api.get<TreeNode[]>(`/projects/${projectId}/repo/tree`),

  file: (projectId: string, path: string) =>
    api.get<FileContent>(`/projects/${projectId}/repo/file?path=${encodeURIComponent(path)}`),

  terminalUrl: (projectId: string, cmd: string) =>
    `/api/projects/${projectId}/repo/terminal?cmd=${encodeURIComponent(cmd)}`,
};
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api/repo.ts
git commit -m "feat: add repoApi client"
```

---

### Task 4: Terminal component

**Files:**
- Create: `ui/src/components/Terminal.tsx`

- [ ] **Step 1: Write the component**

```typescript
import { useRef, useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { repoApi } from "@/api/repo";

interface TerminalLine {
  type: "stdout" | "stderr" | "info";
  text: string;
}

interface TerminalProps {
  projectId: string;
  className?: string;
}

export function Terminal({ projectId, className }: TerminalProps) {
  const [cmd, setCmd] = useState("");
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [running, setRunning] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [lines, scrollToBottom]);

  function abort() {
    esRef.current?.close();
    esRef.current = null;
    setRunning(false);
  }

  function run() {
    if (!cmd.trim() || running) return;
    abort();

    setLines((prev) => [
      ...prev,
      { type: "info", text: `$ ${cmd}` },
    ]);
    setRunning(true);

    const url = repoApi.terminalUrl(projectId, cmd);
    const es = new EventSource(url);
    esRef.current = es;

    function handleLine(type: "stdout" | "stderr") {
      return (e: MessageEvent) => {
        const text = JSON.parse(e.data) as string;
        if (text !== "") {
          setLines((prev) => [...prev, { type, text }]);
        }
      };
    }

    es.addEventListener("stdout", handleLine("stdout"));
    es.addEventListener("stderr", handleLine("stderr"));
    es.addEventListener("exit", (e: MessageEvent) => {
      const { code } = JSON.parse(e.data) as { code: number | null };
      setLines((prev) => [
        ...prev,
        { type: "info", text: `[exited with code ${code ?? "?"}]` },
      ]);
      es.close();
      esRef.current = null;
      setRunning(false);
    });

    es.onerror = () => {
      setLines((prev) => [...prev, { type: "stderr", text: "[connection error]" }]);
      es.close();
      esRef.current = null;
      setRunning(false);
    };

    setCmd("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") run();
    if (e.key === "c" && e.ctrlKey) abort();
  }

  return (
    <div className={cn("flex flex-col border border-border rounded-md overflow-hidden bg-black text-sm font-mono", className)}>
      <div className="flex-1 overflow-y-auto p-3 space-y-0.5 min-h-[200px] max-h-[500px]">
        {lines.map((line, i) => (
          <div
            key={i}
            className={cn(
              "whitespace-pre-wrap break-all",
              line.type === "stderr" && "text-red-400",
              line.type === "info" && "text-zinc-400",
              line.type === "stdout" && "text-green-300",
            )}
          >
            {line.text}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="flex items-center border-t border-zinc-700 bg-zinc-900 px-3 py-2 gap-2">
        <span className="text-zinc-400 select-none">$</span>
        <input
          className="flex-1 bg-transparent outline-none text-white placeholder:text-zinc-600"
          placeholder={running ? "running… (Ctrl+C to abort)" : "enter command"}
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={false}
          autoComplete="off"
          spellCheck={false}
        />
        {running ? (
          <button
            onClick={abort}
            className="text-xs text-red-400 hover:text-red-300 shrink-0"
          >
            abort
          </button>
        ) : (
          <button
            onClick={run}
            disabled={!cmd.trim()}
            className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-40 shrink-0"
          >
            run
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/Terminal.tsx
git commit -m "feat: add reusable Terminal component (SSE streaming)"
```

---

### Task 5: RepoTab component

**Files:**
- Create: `ui/src/pages/RepoTab.tsx`

- [ ] **Step 1: Write the component**

```typescript
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { repoApi, type CommitEntry, type TreeNode } from "@/api/repo";
import { Terminal } from "@/components/Terminal";
import { cn } from "@/lib/utils";

interface RepoTabProps {
  projectId: string;
  isBoard: boolean;
}

// ── Commit log ─────────────────────────────────────────────────────────────

function CommitList({
  entries,
  selected,
  onSelect,
}: {
  entries: CommitEntry[];
  selected: string | null;
  onSelect: (sha: string) => void;
}) {
  return (
    <div className="flex flex-col overflow-y-auto divide-y divide-border">
      {entries.map((c) => (
        <button
          key={c.sha}
          onClick={() => onSelect(c.sha)}
          className={cn(
            "text-left px-3 py-2 hover:bg-accent/50 transition-colors",
            selected === c.sha && "bg-accent",
          )}
        >
          <div className="flex items-center gap-2">
            <code className="text-xs text-muted-foreground shrink-0">{c.shortSha}</code>
            <span className="text-sm truncate flex-1">{c.message}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {c.author} · {new Date(c.date).toLocaleString()}
          </div>
        </button>
      ))}
    </div>
  );
}

// ── Diff panel ──────────────────────────────────────────────────────────────

function DiffPanel({ projectId, sha }: { projectId: string; sha: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["repo", projectId, "show", sha],
    queryFn: () => repoApi.show(projectId, sha),
  });

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading diff…</div>;
  if (!data) return null;

  return (
    <pre className="overflow-auto p-4 text-xs font-mono bg-background leading-relaxed whitespace-pre-wrap break-all">
      {data.diff}
    </pre>
  );
}

// ── File tree ───────────────────────────────────────────────────────────────

function FileTreeNode({
  node,
  selectedPath,
  onSelect,
  depth = 0,
}: {
  node: TreeNode;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  depth?: number;
}) {
  const [open, setOpen] = useState(true);

  if (node.type === "file") {
    return (
      <button
        onClick={() => onSelect(node.path)}
        className={cn(
          "w-full text-left text-xs px-2 py-0.5 truncate hover:bg-accent/50 rounded",
          selectedPath === node.path && "bg-accent",
        )}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {node.name}
      </button>
    );
  }

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full text-left text-xs px-2 py-0.5 text-muted-foreground hover:bg-accent/30 rounded font-medium"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {open ? "▾" : "▸"} {node.name}
      </button>
      {open &&
        node.children.map((child) => (
          <FileTreeNode
            key={child.path}
            node={child}
            selectedPath={selectedPath}
            onSelect={onSelect}
            depth={depth + 1}
          />
        ))}
    </div>
  );
}

function FileViewer({ projectId, path }: { projectId: string; path: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["repo", projectId, "file", path],
    queryFn: () => repoApi.file(projectId, path),
  });

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  if (!data) return null;

  return (
    <pre className="overflow-auto p-4 text-xs font-mono leading-relaxed whitespace-pre bg-background h-full">
      {data.content}
    </pre>
  );
}

// ── Main RepoTab ────────────────────────────────────────────────────────────

type SubView = "commits" | "files" | "terminal";

export function RepoTab({ projectId, isBoard }: RepoTabProps) {
  const [subView, setSubView] = useState<SubView>("commits");
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const { data: log, isLoading: logLoading, error: logError } = useQuery({
    queryKey: ["repo", projectId, "log"],
    queryFn: () => repoApi.log(projectId),
    enabled: subView === "commits",
  });

  const { data: tree, isLoading: treeLoading } = useQuery({
    queryKey: ["repo", projectId, "tree"],
    queryFn: () => repoApi.tree(projectId),
    enabled: subView === "files",
  });

  const subViews: { value: SubView; label: string }[] = [
    { value: "commits", label: "Commits" },
    { value: "files", label: "Files" },
    ...(isBoard ? [{ value: "terminal" as SubView, label: "Terminal" }] : []),
  ];

  return (
    <div className="flex flex-col gap-4 mt-4">
      {/* Sub-view switcher */}
      <div className="flex gap-2 border-b border-border pb-2">
        {subViews.map((sv) => (
          <button
            key={sv.value}
            onClick={() => setSubView(sv.value)}
            className={cn(
              "text-sm px-3 py-1 rounded-md transition-colors",
              subView === sv.value
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-accent/50",
            )}
          >
            {sv.label}
          </button>
        ))}
      </div>

      {/* Commits view */}
      {subView === "commits" && (
        <div className="flex gap-4 h-[600px] border border-border rounded-md overflow-hidden">
          <div className="w-80 shrink-0 overflow-y-auto border-r border-border">
            {logLoading && (
              <div className="p-4 text-sm text-muted-foreground">Loading commits…</div>
            )}
            {logError && (
              <div className="p-4 text-sm text-destructive">
                Failed to load git log. Is a local workspace configured?
              </div>
            )}
            {log && (
              <CommitList
                entries={log}
                selected={selectedSha}
                onSelect={setSelectedSha}
              />
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            {selectedSha ? (
              <DiffPanel projectId={projectId} sha={selectedSha} />
            ) : (
              <div className="p-4 text-sm text-muted-foreground">
                Select a commit to view its diff.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Files view */}
      {subView === "files" && (
        <div className="flex gap-4 h-[600px] border border-border rounded-md overflow-hidden">
          <div className="w-56 shrink-0 overflow-y-auto border-r border-border py-2">
            {treeLoading && (
              <div className="p-2 text-xs text-muted-foreground">Loading…</div>
            )}
            {tree?.map((node) => (
              <FileTreeNode
                key={node.path}
                node={node}
                selectedPath={selectedFile}
                onSelect={setSelectedFile}
              />
            ))}
          </div>
          <div className="flex-1 overflow-y-auto">
            {selectedFile ? (
              <FileViewer projectId={projectId} path={selectedFile} />
            ) : (
              <div className="p-4 text-sm text-muted-foreground">
                Select a file to view its contents.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Terminal view — board only */}
      {subView === "terminal" && isBoard && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Commands run in the project workspace directory. Board users only.
          </p>
          <Terminal projectId={projectId} className="h-[500px]" />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/pages/RepoTab.tsx
git commit -m "feat: add RepoTab component (commits, files, terminal sub-views)"
```

---

### Task 6: Wire RepoTab into ProjectDetail

**Files:**
- Modify: `ui/src/pages/ProjectDetail.tsx`

- [ ] **Step 1: Add "repo" to tab types and URL resolver**

Find line 30–48 and extend:

```typescript
// OLD
type ProjectBaseTab = "overview" | "list" | "configuration" | "budget";

// NEW
type ProjectBaseTab = "overview" | "list" | "configuration" | "budget" | "repo";
```

In `resolveProjectTab` function, add after the `"budget"` check:

```typescript
if (tab === "repo") return "repo";
```

- [ ] **Step 2: Add import for RepoTab**

At the top of `ProjectDetail.tsx`, add:

```typescript
import { RepoTab } from "./RepoTab";
```

- [ ] **Step 3: Add "Repo" to PageTabBar items**

Find the `PageTabBar` `items` array (line ~562) and add the "Repo" tab:

```typescript
items={[
  { value: "list", label: "Issues" },
  { value: "overview", label: "Overview" },
  { value: "configuration", label: "Configuration" },
  { value: "budget", label: "Budget" },
  { value: "repo", label: "Repo" },   // ← add this
  ...pluginTabItems.map((item) => ({
    value: item.value,
    label: item.label,
  })),
]}
```

Do the same for the second `PageTabBar` occurrence (the `value` prop mirror — same file, same block).

- [ ] **Step 4: Add RepoTab content block**

After the `budget` content block (around line 614), add:

```typescript
{activeTab === "repo" && project?.id && (
  <RepoTab
    projectId={project.id}
    isBoard={true}
  />
)}
```

> Note: `isBoard` is always `true` in the board UI. The server enforces the actual restriction for the terminal endpoint. The Terminal sub-view button is hidden from agents, but since this UI is board-only by nature, hardcoding `true` is correct.

- [ ] **Step 5: Handle URL routing for "repo" tab**

The tab URL pattern `/projects/:id/repo` conflicts with the route `/projects/:id/repo/log` etc. because React Router renders the UI and Express handles the API — different servers — so there is **no conflict**. The Vite dev server proxies `/api/*` to Express, so `/projects/:id/repo` (no `/api` prefix) goes to React Router, not Express.

Verify by checking `ui/vite.config.ts` proxy config — it should proxy `/api` prefix only.

```bash
grep -r "proxy" /home/jayjay/Work/Develtech/paperclip-v3-phase-2/ui/vite.config.ts
```

Expected: proxy targets `/api` prefix, not `/projects`.

- [ ] **Step 6: Typecheck**

```bash
pnpm -r typecheck
```

Expected: no errors.

- [ ] **Step 7: Run full test suite**

```bash
pnpm test:run
```

Expected: all tests pass (including the new repo tests from Task 1).

- [ ] **Step 8: Commit**

```bash
git add ui/src/pages/ProjectDetail.tsx
git commit -m "feat: add Repo tab to ProjectDetail"
```

---

## Self-Review

**Spec coverage:**
- ✅ git log endpoint — Task 1
- ✅ git show (commit diff) — Task 1
- ✅ file tree — Task 1
- ✅ file read — Task 1
- ✅ terminal SSE streaming — Task 1
- ✅ board-only terminal restriction — Task 1 (`assertBoard`) + Task 5 (UI hides tab)
- ✅ read-only for agents (git/file) — assertCompanyAccess allows agents; terminal assertBoard blocks them
- ✅ reusable Terminal component at `ui/src/components/Terminal.tsx` — Task 4
- ✅ Repo tab on ProjectDetail — Task 6
- ✅ commit log list — Task 5 (CommitList)
- ✅ click-to-view diff panel — Task 5 (DiffPanel)
- ✅ file tree sidebar — Task 5 (FileTreeNode)
- ✅ file content viewer (plain pre/code) — Task 5 (FileViewer)
- ✅ Monaco editor OUT OF SCOPE — confirmed, using `<pre>` blocks throughout
- ✅ uses `project_workspaces.cwd` as base path — resolveCwd() in Task 1
- ✅ path traversal prevention — resolved path check in Task 1

**Placeholder scan:** No TBDs, TODOs, or "similar to Task N" references found.

**Type consistency:**
- `CommitEntry` defined in `repo.ts` (Task 3), used in `RepoTab.tsx` (Task 5) — consistent
- `TreeNode` defined in `repo.ts`, used in `RepoTab.tsx` — consistent
- `Terminal` props `{ projectId, className }` — consistent across Tasks 4 and 5
- `repoApi.terminalUrl()` used in `Terminal.tsx` — defined in Task 3 — consistent
