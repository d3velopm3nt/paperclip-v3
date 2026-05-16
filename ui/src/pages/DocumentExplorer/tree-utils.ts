import type { ReferenceDocument, DocumentSource } from "@paperclipai/shared";

export interface SourceTreeNode {
  sourceId: string;
  source: DocumentSource;
  docs: ReferenceDocument[];
}

export interface TreeNode {
  local: SourceTreeNode[];
  gdrive: SourceTreeNode[];
  uploads: ReferenceDocument[];
}

/** Strip source localPath prefix from absolute sourcePath to get relative path. */
export function relativePath(sourcePath: string | null, localPath: string | null): string {
  if (!sourcePath) return "";
  if (!localPath) return sourcePath;
  const prefix = localPath.endsWith("/") ? localPath : localPath + "/";
  return sourcePath.startsWith(prefix) ? sourcePath.slice(prefix.length) : sourcePath;
}

export function buildTree(
  sources: DocumentSource[],
  docs: ReferenceDocument[],
): TreeNode {
  const localSources = sources.filter((s) => s.type === "local");
  const gdriveSources = sources.filter((s) => s.type === "gdrive");

  // Assign local docs to sources by localPath prefix match
  const localNodes: SourceTreeNode[] = localSources.map((source) => ({
    sourceId: source.id,
    source,
    docs: docs.filter(
      (d) =>
        d.sourceType === "local" &&
        d.sourcePath != null &&
        (source.localPath
          ? d.sourcePath!.startsWith(source.localPath + "/") || d.sourcePath === source.localPath
          : false),
    ),
  }));

  // Fallback: any local docs not matched by a source (e.g. source deleted)
  const matchedLocalPaths = new Set(localNodes.flatMap((n) => n.docs.map((d) => d.id)));
  const unmatchedLocal = docs.filter((d) => d.sourceType === "local" && !matchedLocalPaths.has(d.id));
  if (unmatchedLocal.length > 0 && localNodes.length > 0) {
    localNodes[0]!.docs = [...localNodes[0]!.docs, ...unmatchedLocal];
  }

  // GDrive docs assigned to sources by type (no path prefix needed)
  const gdriveDocs = docs.filter((d) => d.sourceType === "gdrive");
  const gdriveNodes: SourceTreeNode[] = gdriveSources.length > 0
    ? gdriveSources.map((source, i) => ({
        sourceId: source.id,
        source,
        docs: i === 0 ? gdriveDocs : [],
      }))
    : gdriveDocs.length > 0
      ? [{
          sourceId: "gdrive-unlinked",
          source: {
            id: "gdrive-unlinked",
            companyId: "",
            clientId: null,
            projectId: null,
            type: "gdrive",
            name: "Google Drive",
            localPath: null,
            driveFolderId: null,
            githubRepoUrl: null,
            githubBranch: null,
            lastSyncedAt: null,
            lastSyncError: null,
            createdAt: "",
          },
          docs: gdriveDocs,
        }]
      : [];

  return {
    local: localNodes,
    gdrive: gdriveNodes,
    uploads: docs.filter((d) => d.sourceType === "upload"),
  };
}

/** Get unique immediate subfolder names within pathPrefix, using relative paths. */
export function getFolderNodes(
  docs: ReferenceDocument[],
  pathPrefix: string,
  localPath?: string | null,
): string[] {
  const folders = new Set<string>();
  for (const doc of docs) {
    const rel = relativePath(doc.sourcePath, localPath ?? null);
    if (!rel) continue;
    let segment: string | null;
    if (pathPrefix === "") {
      segment = rel;
    } else {
      segment = rel.startsWith(pathPrefix + "/") ? rel.slice(pathPrefix.length + 1) : null;
    }
    if (!segment) continue;
    const parts = segment.split("/");
    if (parts.length > 1 && parts[0]) {
      folders.add(parts[0]);
    }
  }
  return Array.from(folders).sort();
}

/** Get docs directly inside pathPrefix (not in subfolders), using relative paths. */
export function getDocsForPath(
  docs: ReferenceDocument[],
  pathPrefix: string,
  localPath?: string | null,
): ReferenceDocument[] {
  return docs.filter((doc) => {
    const rel = relativePath(doc.sourcePath, localPath ?? null);
    if (pathPrefix === "") {
      return !rel.includes("/"); // "" (null sourcePath) also shows at root
    }
    const prefix = pathPrefix + "/";
    if (!rel.startsWith(prefix)) return false;
    return !rel.slice(prefix.length).includes("/");
  });
}

export function mimeTypeLabel(mimeType: string | null): string {
  if (!mimeType) return "File";
  if (mimeType.includes("pdf")) return "PDF";
  if (mimeType.includes("markdown") || mimeType === "text/x-markdown") return "Markdown";
  if (mimeType.includes("word") || mimeType.includes("docx")) return "Word";
  if (mimeType === "text/plain") return "Text";
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return "Sheet";
  return "File";
}
