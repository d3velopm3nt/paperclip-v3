import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { referenceDocumentsApi } from "@/api/referenceDocuments";

interface DocumentPreviewDrawerProps {
  companyId: string;
  docId: string | null;
  onClose: () => void;
}

export function DocumentPreviewDrawer({ companyId, docId, onClose }: DocumentPreviewDrawerProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["doc-preview", companyId, docId],
    queryFn: () => referenceDocumentsApi.getContent(companyId, docId!),
    enabled: !!docId && !!companyId,
  });

  return (
    <Sheet open={!!docId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-[520px] max-w-full flex flex-col gap-0">
        <SheetHeader className="shrink-0">
          <SheetTitle className="text-sm truncate">{data?.title ?? "Preview"}</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto mt-4">
          {isLoading ? (
            <p className="text-xs text-muted-foreground">Loading...</p>
          ) : data?.extractedText ? (
            <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed">
              {data.extractedText}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">No extracted text available.</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
