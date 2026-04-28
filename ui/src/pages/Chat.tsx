import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { chatApi } from "../api/chat";
import { channelsApi } from "../api/channels";
import { queryKeys } from "../lib/queryKeys";
import { ChatSidebar } from "../components/chat/ChatSidebar";
import { ChatThread } from "../components/chat/ChatThread";
import { Send } from "lucide-react";

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

  const { data: channelsStatus } = useQuery({
    queryKey: ["channels-status"],
    queryFn: () => channelsApi.status(),
    staleTime: 30_000,
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company first.</div>;
  }

  const isTelegramInfo = selectedThreadId === "__telegram_info__";
  const tg = channelsStatus?.telegram;
  const isActiveCompany = tg?.activeCompanyId === selectedCompanyId;
  const botUsername = tg?.bot?.username ?? null;

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
        {isTelegramInfo ? (
          <div className="flex flex-col items-center justify-center h-full gap-6 px-8 text-center">
            <span className="w-14 h-14 rounded-full bg-blue-500/15 flex items-center justify-center">
              <Send className="h-6 w-6 text-blue-400" />
            </span>
            <div className="flex flex-col gap-2 max-w-sm">
              <span className="text-base font-semibold text-foreground">Telegram</span>
              {tg?.configured ? (
                isActiveCompany ? (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Send a message to your bot from Telegram to start a conversation here.
                    </p>
                    {botUsername && (
                      <a
                        href={`https://t.me/${botUsername}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors"
                      >
                        Open @{botUsername}
                      </a>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      Each Telegram chat becomes a separate thread in this sidebar.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground">
                      Telegram is configured but routes messages to a different company.
                    </p>
                    <a
                      href="/channels"
                      className="mt-2 inline-flex items-center gap-1.5 px-4 py-2 rounded-md border border-border hover:bg-accent text-sm font-medium transition-colors"
                    >
                      Go to Channels settings to change routing →
                    </a>
                  </>
                )
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Telegram is not configured. Add your bot token to get started.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Set <code className="font-mono bg-muted px-1 py-0.5 rounded">TELEGRAM_BOT_TOKEN</code> in your{" "}
                    <code className="font-mono bg-muted px-1 py-0.5 rounded">.env</code> and restart the server.
                  </p>
                </>
              )}
            </div>
          </div>
        ) : selectedThreadId ? (
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
