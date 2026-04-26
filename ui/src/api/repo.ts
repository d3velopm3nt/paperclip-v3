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
