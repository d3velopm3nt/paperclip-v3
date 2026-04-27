import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { chatApi } from "../api/chat";
import { queryKeys } from "../lib/queryKeys";
import { ChatSidebar } from "../components/chat/ChatSidebar";
import { ChatThread } from "../components/chat/ChatThread";

export function Chat() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedThreadName, setSelectedThreadName] = useState("Dispatcher");

  useEffect(() => {
    setBreadcrumbs([{ label: "Chat" }]);
  }, [setBreadcrumbs]);

  const ensureThread = useMutation({
    mutationFn: () => chatApi.ensureDispatcherThread(selectedCompanyId!),
    onSuccess: (thread) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.chat.threads(selectedCompanyId!) });
      if (!selectedThreadId) {
        setSelectedThreadId(thread.id);
        setSelectedThreadName("Dispatcher");
      }
    },
  });

  useEffect(() => {
    if (selectedCompanyId) {
      ensureThread.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCompanyId]);

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company first.</div>;
  }

  return (
    <div className="flex h-full min-h-0">
      <ChatSidebar
        companyId={selectedCompanyId}
        companyPrefix={selectedCompany?.issuePrefix ?? null}
        selectedThreadId={selectedThreadId}
        onSelectThread={(id, name) => {
          setSelectedThreadId(id);
          setSelectedThreadName(name);
        }}
      />

      <div className="flex-1 min-w-0">
        {selectedThreadId ? (
          <ChatThread
            companyId={selectedCompanyId}
            companyPrefix={selectedCompany?.issuePrefix ?? null}
            threadId={selectedThreadId}
            threadName={selectedThreadName}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            Loading…
          </div>
        )}
      </div>
    </div>
  );
}
