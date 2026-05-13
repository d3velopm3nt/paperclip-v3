import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderSelector, type FolderSelection } from "./FolderSelector.js";
import { referenceDocumentsApi } from "../api/referenceDocuments.js";

interface StorageSetupBannerProps {
  companyId: string;
}

export function StorageSetupBanner({ companyId }: StorageSetupBannerProps) {
  const qc = useQueryClient();
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);

  const { data: root } = useQuery({
    queryKey: ["company-storage-root", companyId],
    queryFn: () => referenceDocumentsApi.getCompanyStorageRoot(companyId),
  });

  const { mutate, isPending } = useMutation({
    mutationFn: (body: { localPath: string | null; driveFolderId: string | null }) =>
      referenceDocumentsApi.setCompanyStorageRoot(companyId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["company-storage-root", companyId] });
      setOpen(false);
    },
  });

  if (dismissed || root?.localPath || root?.driveFolderId) return null;

  function handleSelect(selection: FolderSelection) {
    if (selection.type === "local") {
      mutate({ localPath: selection.path, driveFolderId: null });
    } else if (selection.type === "drive") {
      mutate({ localPath: null, driveFolderId: selection.folderId });
    }
  }

  return (
    <>
      <div className="rounded-md border border-yellow-300 bg-yellow-50 px-4 py-3 flex items-center gap-3 text-sm">
        <span className="text-yellow-600 font-medium shrink-0">Storage not configured</span>
        <span className="text-yellow-700 flex-1">
          Email attachments won&apos;t be filed until a storage location is set.
        </span>
        <div className="flex gap-3 shrink-0">
          <button
            className="text-yellow-700 underline hover:no-underline text-sm"
            onClick={() => setOpen(true)}
          >
            Configure
          </button>
          <button
            className="text-yellow-400 hover:text-yellow-600 text-sm"
            onClick={() => setDismissed(true)}
          >
            Dismiss
          </button>
        </div>
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30">
          <div className="bg-white rounded-lg shadow-lg p-6 w-96">
            <h2 className="font-semibold mb-3">Set Storage Location</h2>
            <FolderSelector companyId={companyId} onSelect={handleSelect} />
            {isPending && (
              <p className="text-xs text-muted-foreground mt-2">Saving…</p>
            )}
            <button
              className="mt-3 text-sm text-muted-foreground hover:underline"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}
