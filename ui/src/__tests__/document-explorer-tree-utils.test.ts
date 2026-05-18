import { describe, it, expect } from "vitest";
import {
  buildTree,
  getDocsForPath,
  getFolderNodes,
} from "../pages/DocumentExplorer/tree-utils";
import type { ReferenceDocument, DocumentSource } from "@paperclipai/shared";

const makeDoc = (overrides: Partial<ReferenceDocument>): ReferenceDocument => ({
  id: "d1",
  companyId: "c1",
  title: "Test Doc",
  description: null,
  mimeType: "text/plain",
  sourceType: "local",
  sourcePath: "file.md",
  driveFileId: null,
  driveWebUrl: null,
  scope: "company",
  projectId: null,
  includeInContext: false,
  syncedAt: null,
  createdAt: "2024-01-01",
  updatedAt: "2024-01-01",
  ...overrides,
});

const makeSource = (overrides: Partial<DocumentSource>): DocumentSource => ({
  id: "s1",
  companyId: "c1",
  clientId: null,
  projectId: null,
  type: "local",
  name: "My Docs",
  localPath: "/home/docs",
  driveFolderId: null,
  githubRepoUrl: null,
  githubBranch: null,
  lastSyncedAt: null,
  lastSyncError: null,
  createdAt: "2024-01-01",
  ...overrides,
});

describe("buildTree", () => {
  it("groups local docs under their source", () => {
    const sources = [makeSource({ id: "s1" })];
    const docs = [makeDoc({ id: "d1", sourcePath: "file.md", sourceType: "local" })];
    const tree = buildTree(sources, docs);
    expect(tree.local).toHaveLength(1);
    expect(tree.local[0].sourceId).toBe("s1");
    expect(tree.local[0].docs).toHaveLength(1);
  });

  it("puts upload docs in uploads bucket", () => {
    const tree = buildTree(
      [],
      [makeDoc({ id: "d2", sourceType: "upload", sourcePath: null })],
    );
    expect(tree.uploads).toHaveLength(1);
  });

  it("groups gdrive docs under gdrive sources", () => {
    const sources = [makeSource({ id: "s2", type: "gdrive", localPath: null, driveFolderId: "folder1" })];
    const docs = [makeDoc({ id: "d3", sourceType: "gdrive", sourcePath: "doc.pdf" })];
    const tree = buildTree(sources, docs);
    expect(tree.gdrive).toHaveLength(1);
    expect(tree.gdrive[0].docs).toHaveLength(1);
  });
});

describe("getFolderNodes", () => {
  it("extracts unique top-level folders from docs", () => {
    const docs = [
      makeDoc({ sourcePath: "guides/a.md" }),
      makeDoc({ sourcePath: "guides/b.md" }),
      makeDoc({ sourcePath: "specs/c.md" }),
      makeDoc({ sourcePath: "root.md" }),
    ];
    const folders = getFolderNodes(docs, "");
    expect(folders).toContain("guides");
    expect(folders).toContain("specs");
    expect(folders).not.toContain("root.md");
  });

  it("extracts nested folders relative to a path prefix", () => {
    const docs = [
      makeDoc({ sourcePath: "guides/advanced/deep.md" }),
      makeDoc({ sourcePath: "guides/basic.md" }),
    ];
    const folders = getFolderNodes(docs, "guides");
    expect(folders).toContain("advanced");
    expect(folders).not.toContain("guides");
  });

  it("returns empty when no subfolders exist", () => {
    const docs = [makeDoc({ sourcePath: "file.md" })];
    expect(getFolderNodes(docs, "")).toEqual([]);
  });
});

describe("getDocsForPath", () => {
  it("returns docs directly at root (no subfolder)", () => {
    const docs = [
      makeDoc({ id: "d1", sourcePath: "file.md" }),
      makeDoc({ id: "d2", sourcePath: "guides/file.md" }),
      makeDoc({ id: "d3", sourcePath: "guides/sub/deep.md" }),
    ];
    expect(getDocsForPath(docs, "").map((d) => d.id)).toEqual(["d1"]);
  });

  it("returns docs directly in a folder (not nested)", () => {
    const docs = [
      makeDoc({ id: "d1", sourcePath: "file.md" }),
      makeDoc({ id: "d2", sourcePath: "guides/file.md" }),
      makeDoc({ id: "d3", sourcePath: "guides/sub/deep.md" }),
    ];
    expect(getDocsForPath(docs, "guides").map((d) => d.id)).toEqual(["d2"]);
  });

  it("handles null sourcePath", () => {
    const docs = [makeDoc({ id: "d1", sourcePath: null })];
    expect(getDocsForPath(docs, "")).toHaveLength(1);
  });
});
