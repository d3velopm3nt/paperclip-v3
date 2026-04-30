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

export function buildTree(
  sources: DocumentSource[],
  docs: ReferenceDocument[],
): TreeNode {
  const localSources = sources.filter((s) => s.type === "local");
  const gdriveSources = sources.filter((s) => s.type === "gdrive");

  const localDocs = docs.filter((d) => d.sourceType === "local");
  const gdriveDocs = docs.filter((d) => d.sourceType === "gdrive");

  const assignToSources = (
    sourcesOfType: DocumentSource[],
    docsOfType: ReferenceDocument[],
  ): SourceTreeNode[] => {
    if (sourcesOfType.length === 0) return [];
    if (sourcesOfType.length === 1) {
      return [{ sourceId: sourcesOfType[0]!.id, source: sourcesOfType[0]!, docs: docsOfType }];
    }
    // Multiple sources: assign each doc to first source (future: use sourceId FK)
    return sourcesOfType.map((source, i) => ({
      sourceId: source.id,
      source,
      docs: i === 0 ? docsOfType : [],
    }));
  };

  return {
    local: assignToSources(localSources, localDocs),
    gdrive: assignToSources(gdriveSources, gdriveDocs),
    uploads: docs.filter((d) => d.sourceType === "upload"),
  };
}

export function getFolderNodes(
  docs: ReferenceDocument[],
  pathPrefix: string,
): string[] {
  const folders = new Set<string>();
  for (const doc of docs) {
    const p = doc.sourcePath ?? "";
    let relative: string | null;
    if (pathPrefix === "") {
      relative = p;
    } else {
      relative = p.startsWith(pathPrefix + "/") ? p.slice(pathPrefix.length + 1) : null;
    }
    if (!relative) continue;
    const parts = relative.split("/");
    if (parts.length > 1) {
      folders.add(parts[0]!);
    }
  }
  return Array.from(folders).sort();
}

export function getDocsForPath(
  docs: ReferenceDocument[],
  pathPrefix: string,
): ReferenceDocument[] {
  return docs.filter((doc) => {
    const p = doc.sourcePath ?? "";
    if (pathPrefix === "") {
      return !p.includes("/");
    }
    const prefix = pathPrefix + "/";
    if (!p.startsWith(prefix)) return false;
    const rest = p.slice(prefix.length);
    return !rest.includes("/");
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
