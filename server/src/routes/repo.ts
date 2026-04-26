import { Router } from "express";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { projects, projectWorkspaces } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolveCwd(db: Db, projectId: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(projectWorkspaces)
    .where(and(eq(projectWorkspaces.projectId, projectId), eq(projectWorkspaces.isPrimary, true)))
    .limit(1);

  const row = rows[0];
  if (!row?.cwd) return null;

  try {
    await fs.promises.access(row.cwd);
    return row.cwd;
  } catch {
    return null;
  }
}

async function gitLog(cwd: string) {
  const { stdout } = await execFileAsync(
    "git",
    ["log", "-100", "--format=%H\x1f%h\x1f%an\x1f%aI\x1f%s\x1e"],
    { cwd },
  );

  return stdout
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, shortSha, author, date, message] = record.split("\x1f");
      return { sha, shortSha, author, date, message };
    });
}

async function gitTree(cwd: string): Promise<TreeNode[]> {
  const { stdout } = await execFileAsync("git", ["ls-files"], { cwd });

  const filePaths = stdout.split("\n").map((p) => p.trim()).filter(Boolean);
  const root: TreeNode[] = [];

  for (const filePath of filePaths) {
    const parts = filePath.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const currentPath = parts.slice(0, i + 1).join("/");
      const isFile = i === parts.length - 1;

      if (isFile) {
        current.push({ type: "file", name: part, path: currentPath });
      } else {
        let dir = current.find((n): n is DirNode => n.type === "dir" && n.name === part);
        if (!dir) {
          dir = { type: "dir", name: part, path: currentPath, children: [] };
          current.push(dir);
        }
        current = dir.children;
      }
    }
  }

  return root;
}

// ─── Router ───────────────────────────────────────────────────────────────────

export function repoRoutes(db: Db) {
  const router = Router();

  // Helper to look up project and resolve cwd, returns {project, cwd} or sends error
  async function getProjectAndCwd(
    projectId: string,
    res: import("express").Response,
  ): Promise<{ project: typeof projects.$inferSelect; cwd: string } | null> {
    const projectRows = await db
      .select()
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    const project = projectRows[0];
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return null;
    }

    const cwd = await resolveCwd(db, projectId);
    if (!cwd) {
      res.status(422).json({ error: "No local workspace configured" });
      return null;
    }

    return { project, cwd };
  }

  // GET /projects/:id/repo/log
  router.get("/projects/:id/repo/log", async (req, res) => {
    const result = await getProjectAndCwd(req.params.id!, res);
    if (!result) return;

    assertCompanyAccess(req, result.project.companyId);

    const log = await gitLog(result.cwd);
    res.json(log);
  });

  // GET /projects/:id/repo/show/:sha
  router.get("/projects/:id/repo/show/:sha", async (req, res) => {
    const result = await getProjectAndCwd(req.params.id!, res);
    if (!result) return;

    assertCompanyAccess(req, result.project.companyId);

    const sha = req.params.sha!;
    if (!/^[0-9a-f]{4,64}$/i.test(sha)) {
      res.status(400).json({ error: "Invalid sha" });
      return;
    }

    const { stdout } = await execFileAsync(
      "git",
      ["show", "--stat", "--patch", sha],
      { cwd: result.cwd },
    );

    res.json({ sha, diff: stdout });
  });

  // GET /projects/:id/repo/tree
  router.get("/projects/:id/repo/tree", async (req, res) => {
    const result = await getProjectAndCwd(req.params.id!, res);
    if (!result) return;

    assertCompanyAccess(req, result.project.companyId);

    const tree = await gitTree(result.cwd);
    res.json(tree);
  });

  // GET /projects/:id/repo/file?path=...
  router.get("/projects/:id/repo/file", async (req, res) => {
    const result = await getProjectAndCwd(req.params.id!, res);
    if (!result) return;

    assertCompanyAccess(req, result.project.companyId);

    const filePath = req.query.path;
    if (typeof filePath !== "string" || filePath.trim() === "") {
      res.status(400).json({ error: "path query param required" });
      return;
    }

    const resolvedCwd = path.resolve(result.cwd);
    const resolvedFile = path.resolve(resolvedCwd, filePath);

    if (!resolvedFile.startsWith(resolvedCwd + path.sep) && resolvedFile !== resolvedCwd) {
      res.status(400).json({ error: "Path outside workspace" });
      return;
    }

    try {
      const content = await fs.promises.readFile(resolvedFile, "utf-8");
      res.json({ path: filePath, content });
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === "ENOENT") {
        res.status(404).json({ error: "File not found" });
        return;
      }
      throw err;
    }
  });

  // GET /projects/:id/repo/terminal?cmd=... — board-only SSE
  router.get("/projects/:id/repo/terminal", async (req, res) => {
    assertBoard(req);

    const result = await getProjectAndCwd(req.params.id!, res);
    if (!result) return;

    const cmd = req.query.cmd;
    if (typeof cmd !== "string" || cmd.trim() === "") {
      res.status(400).json({ error: "cmd query param required" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const child = spawn("sh", ["-c", cmd], {
      cwd: result.cwd,
    });

    const write = (event: string, data: string) => {
      if (!res.writable) return;
      try {
        res.write(`event: ${event}\ndata: ${data}\n\n`);
      } catch {
        // connection closed
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        write("stdout", JSON.stringify(line));
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        write("stderr", JSON.stringify(line));
      }
    });

    child.on("close", (code: number | null) => {
      write("exit", JSON.stringify({ code: code ?? 0 }));
      if (res.writable) res.end();
    });

    req.on("close", () => {
      child.kill();
    });
  });

  return router;
}
