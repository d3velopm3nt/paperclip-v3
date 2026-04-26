import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { repoRoutes } from "../routes/repo.js";
import { errorHandler } from "../middleware/index.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping repo route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("repo routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempDir!: string;
  let projectId!: string;
  let firstSha!: string;

  beforeAll(async () => {
    // Start embedded postgres
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-repo-routes-");
    db = createDb(tempDb.connectionString);

    // Create a real temp git repo
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-repo-test-"));

    execSync("git init", { cwd: tempDir });
    execSync('git config user.email "test@test.com"', { cwd: tempDir });
    execSync('git config user.name "Test User"', { cwd: tempDir });

    // Create a file and commit
    fs.writeFileSync(path.join(tempDir, "hello.txt"), "Hello world\n");
    execSync("git add .", { cwd: tempDir });
    execSync('git commit -m "Initial commit"', { cwd: tempDir });

    // Capture the first commit sha
    firstSha = execSync("git rev-parse HEAD", { cwd: tempDir }).toString().trim();

    // Insert company + project + workspace into DB
    const [company] = await db
      .insert(companies)
      .values({ name: "TestCo", issuePrefix: "TC" })
      .returning();

    const [project] = await db
      .insert(projects)
      .values({ companyId: company!.id, name: "TestProject" })
      .returning();

    projectId = project!.id;

    await db.insert(projectWorkspaces).values({
      companyId: company!.id,
      projectId: project!.id,
      name: "primary",
      isPrimary: true,
      cwd: tempDir,
    });
  }, 30_000);

  afterAll(async () => {
    // Clean up temp git repo
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    await tempDb?.cleanup();
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    // Fake board actor that always passes assertCompanyAccess and assertBoard
    app.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", repoRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it("GET log returns array with sha + message fields", async () => {
    const res = await request(createApp()).get(`/api/projects/${projectId}/repo/log`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    const entry = res.body[0];
    expect(entry).toHaveProperty("sha");
    expect(entry).toHaveProperty("message");
    expect(entry.sha).toBe(firstSha);
    expect(entry.message).toBe("Initial commit");
  });

  it("GET show/:sha returns { sha, diff } where diff is a non-empty string", async () => {
    const res = await request(createApp()).get(
      `/api/projects/${projectId}/repo/show/${firstSha}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("sha", firstSha);
    expect(res.body).toHaveProperty("diff");
    expect(typeof res.body.diff).toBe("string");
    expect(res.body.diff.length).toBeGreaterThan(0);
  });

  it("GET tree returns array containing hello.txt", async () => {
    const res = await request(createApp()).get(`/api/projects/${projectId}/repo/tree`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const fileNode = res.body.find(
      (n: { type: string; name: string }) => n.type === "file" && n.name === "hello.txt",
    );
    expect(fileNode).toBeDefined();
    expect(fileNode.path).toBe("hello.txt");
  });

  it("GET file?path=hello.txt returns { content: 'Hello world\\n' }", async () => {
    const res = await request(createApp()).get(
      `/api/projects/${projectId}/repo/file?path=hello.txt`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ content: "Hello world\n" });
    expect(res.body.path).toBe("hello.txt");
  });

  it("GET file?path=../../etc/passwd returns 400", async () => {
    const res = await request(createApp()).get(
      `/api/projects/${projectId}/repo/file?path=../../etc/passwd`,
    );
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "Path outside workspace" });
  });
});
