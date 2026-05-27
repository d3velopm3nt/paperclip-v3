// v3: telegram bots page — list, create, delete bots
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Bot, Plus, Trash2, Copy, Check, AlertCircle, Clock } from "lucide-react";

interface TelegramBot {
  id: string;
  botUsername: string;
  deliveryMode: "longpoll" | "webhook";
  active: boolean;
  lastPolledAt?: string;
  lastErrorText?: string;
}

export function TelegramBots() {
  const { selectedCompanyId } = useCompany();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [botUsername, setBotUsername] = useState("");
  const [deliveryMode, setDeliveryMode] = useState<"longpoll" | "webhook">("longpoll");
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Telegram Bots" }]);
  }, [setBreadcrumbs]);

  const { data: bots = [], isLoading } = useQuery({
    queryKey: queryKeys.telegramBots(selectedCompanyId!),
    queryFn: async () => {
      const res = await fetch(`/api/companies/${selectedCompanyId}/telegram-bots`);
      if (!res.ok) throw new Error("Failed to load bots");
      return res.json() as Promise<TelegramBot[]>;
    },
    enabled: !!selectedCompanyId,
  });

  const createMutation = useMutation({
    mutationFn: async (data: { botToken: string; botUsername: string; deliveryMode: string }) => {
      const res = await fetch(`/api/companies/${selectedCompanyId}/telegram-bots`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create bot");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.telegramBots(selectedCompanyId!) });
      setShowCreateDialog(false);
      setBotToken("");
      setBotUsername("");
      setDeliveryMode("longpoll");
      pushToast({ title: "Bot created successfully" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (botId: string) => {
      const res = await fetch(`/api/telegram-bots/${botId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete bot");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.telegramBots(selectedCompanyId!) });
      pushToast({ title: "Bot deleted" });
    },
  });

  const copyLink = (username: string) => {
    navigator.clipboard.writeText(`https://t.me/${username}`);
    pushToast({ title: "Link copied" });
  };

  if (isLoading) return <PageSkeleton />;

  return (
    <div className="container mx-auto max-w-6xl py-8 px-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Telegram Bots</h1>
          <p className="text-sm text-zinc-400 mt-1">Manage Telegram bot integrations</p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Add Bot
        </Button>
      </div>

      {bots.length === 0 ? (
        <Card className="p-12 text-center">
          <Bot className="w-12 h-12 text-zinc-600 mx-auto mb-4" />
          <p className="text-zinc-400 mb-4">No Telegram bots configured</p>
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Add Your First Bot
          </Button>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {bots.map((bot) => (
            <Card key={bot.id} className="p-4">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Bot className="w-5 h-5 text-blue-400" />
                  <div>
                    <h3 className="font-medium text-white">@{bot.botUsername}</h3>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-400">
                        {bot.deliveryMode}
                      </span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          bot.active ? "bg-green-500/20 text-green-400" : "bg-zinc-700 text-zinc-400"
                        }`}
                      >
                        {bot.active ? "active" : "inactive"}
                      </span>
                    </div>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => deleteMutation.mutate(bot.id)}
                  className="text-red-400 hover:text-red-300"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>

              {bot.lastErrorText && (
                <div className="flex items-start gap-2 mb-3 p-2 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>{bot.lastErrorText}</span>
                </div>
              )}

              <Button
                variant="secondary"
                size="sm"
                onClick={() => copyLink(bot.botUsername)}
                className="w-full"
              >
                <Copy className="w-4 h-4 mr-1" />
                Copy Link
              </Button>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Telegram Bot</DialogTitle>
            <DialogDescription>
              Connect a Telegram bot to this company
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              createMutation.mutate({ botToken, botUsername, deliveryMode });
            }}
            className="space-y-4"
          >
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">
                Bot Token
              </label>
              <Input
                type="password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
                required
              />
              <p className="text-xs text-zinc-500 mt-1">
                Get from @BotFather on Telegram
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">
                Bot Username
              </label>
              <Input
                value={botUsername}
                onChange={(e) => setBotUsername(e.target.value)}
                placeholder="my_company_bot"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">
                Delivery Mode
              </label>
              <Select value={deliveryMode} onValueChange={(v) => setDeliveryMode(v as "longpoll" | "webhook")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="longpoll">Long Poll</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {createMutation.isError && (
              <div className="text-sm text-red-400">
                Failed to create bot. Please check your token.
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setShowCreateDialog(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Creating..." : "Create Bot"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
