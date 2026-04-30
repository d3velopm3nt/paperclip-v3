import { Download, Eye, FolderOpen, ToggleLeft, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Project } from "@paperclipai/shared";

interface FileActionBarProps {
  selectedCount: number;
  projects: Project[];
  onPreview: () => void;
  onToggleContext: () => void;
  onMoveToProject: (projectId: string) => void;
  onDownload: () => void;
  onDelete: () => void;
}

export function FileActionBar({
  selectedCount, projects, onPreview, onToggleContext,
  onMoveToProject, onDownload, onDelete,
}: FileActionBarProps) {
  if (selectedCount === 0) return null;

  return (
    <div className="px-3 py-2 border-t border-border bg-muted/20 flex items-center gap-2 shrink-0 flex-wrap">
      <span className="text-xs text-muted-foreground mr-1">{selectedCount} selected</span>

      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs gap-1.5"
        onClick={onPreview}
        disabled={selectedCount !== 1}
      >
        <Eye className="h-3.5 w-3.5" />Preview
      </Button>

      <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={onToggleContext}>
        <ToggleLeft className="h-3.5 w-3.5" />In context
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5">
            <FolderOpen className="h-3.5 w-3.5" />Move to project
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {projects.length === 0 ? (
            <DropdownMenuItem disabled>No projects</DropdownMenuItem>
          ) : (
            projects.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => onMoveToProject(p.id)}>
                {p.name}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={onDownload}>
        <Download className="h-3.5 w-3.5" />Download
      </Button>

      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs gap-1.5 text-destructive hover:text-destructive ml-auto"
        onClick={onDelete}
      >
        <Trash2 className="h-3.5 w-3.5" />Delete
      </Button>
    </div>
  );
}
