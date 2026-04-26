import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { channelsApi } from "../api/channels";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, AlertCircle, Send, Trash2, Webhook } from "lucide-react";

export function Channels() {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Channels" }]);
  }, [setBreadcrumbs]);

  const queryClient = useQueryClient();
  const { data: status, isLoading } = useQuery({
    queryKey: ["channels-status"],
    queryFn: channelsApi.status,
    refetchInterval: 30_000,
  });

  const testTg = useMutation({
    mutationFn: channelsApi.testTelegram,
  });

  const [webhookUrl, setWebhookUrl] = useState("");

  const registerWebhook = useMutation({
    mutationFn: () => channelsApi.registerTelegramWebhook(webhookUrl),
    onSuccess: () => {
      setWebhookUrl("");
      queryClient.invalidateQueries({ queryKey: ["channels-status"] });
    },
  });

  const deleteWebhook = useMutation({
    mutationFn: channelsApi.deleteTelegramWebhook,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["channels-status"] }),
  });

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const tg = status?.telegram;
  const email = status?.email;
  const tgWebhookActive = !!(tg?.webhook?.url && tg.webhook.url.length > 0);

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold">Channels</h1>
      <p className="text-sm text-muted-foreground -mt-4">
        Configure inbound/outbound messaging channels for operator↔agent communication.
      </p>

      {/* ── Telegram ── */}
      <Card className="p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-base font-medium">Telegram</span>
            {tg?.configured ? (
              tg.error ? (
                <Badge variant="destructive" className="gap-1 text-xs">
                  <AlertCircle className="w-3 h-3" /> Error
                </Badge>
              ) : (
                <Badge variant="default" className="gap-1 text-xs bg-green-600 hover:bg-green-600">
                  <CheckCircle2 className="w-3 h-3" /> Connected
                </Badge>
              )
            ) : (
              <Badge variant="secondary" className="text-xs">Not configured</Badge>
            )}
          </div>
          {tg?.configured && !tg.error && (
            <Button
              size="sm"
              variant="outline"
              disabled={testTg.isPending}
              onClick={() => testTg.mutate()}
            >
              <Send className="w-3 h-3 mr-1" />
              {testTg.isPending ? "Sending…" : "Send test"}
            </Button>
          )}
        </div>

        {tg?.configured && !tg.error && (
          <div className="text-sm space-y-1">
            {tg.bot && (
              <div className="flex gap-2">
                <span className="text-muted-foreground w-32 shrink-0">Bot</span>
                <span>@{tg.bot.username} ({tg.bot.firstName})</span>
              </div>
            )}
            {tg.operatorChatId && (
              <div className="flex gap-2">
                <span className="text-muted-foreground w-32 shrink-0">Operator chat</span>
                <span className="font-mono text-xs">{tg.operatorChatId}</span>
              </div>
            )}
            <div className="flex gap-2">
              <span className="text-muted-foreground w-32 shrink-0">Webhook</span>
              {tgWebhookActive ? (
                <span className="text-xs font-mono truncate max-w-xs text-green-600">{tg.webhook!.url}</span>
              ) : (
                <span className="text-xs text-amber-600">Not registered — inbound messages disabled</span>
              )}
            </div>
          </div>
        )}

        {tg?.error && (
          <p className="text-sm text-destructive">{tg.error}</p>
        )}

        {!tg?.configured && (
          <div className="text-sm text-muted-foreground space-y-1">
            <p>Set <code className="text-xs bg-muted px-1 rounded">TELEGRAM_BOT_TOKEN</code> and <code className="text-xs bg-muted px-1 rounded">TELEGRAM_OPERATOR_CHAT_ID</code> in your Paperclip env file to enable Telegram.</p>
          </div>
        )}

        {/* Webhook setup */}
        {tg?.configured && !tg.error && (
          <div className="border-t border-border pt-3 space-y-2">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
              Webhook (required for inbound messages)
            </p>
            <p className="text-xs text-muted-foreground">
              Run <code className="bg-muted px-1 rounded">cloudflared tunnel --url localhost:3100</code> and paste the HTTPS URL below.
            </p>
            <div className="flex gap-2">
              <Input
                className="text-sm flex-1"
                placeholder="https://xxxx.trycloudflare.com"
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
              />
              <Button
                size="sm"
                disabled={!webhookUrl || registerWebhook.isPending}
                onClick={() => registerWebhook.mutate()}
              >
                <Webhook className="w-3 h-3 mr-1" />
                {registerWebhook.isPending ? "Registering…" : "Register"}
              </Button>
            </div>
            {registerWebhook.isSuccess && (
              <p className="text-xs text-green-600">Webhook registered. Telegram messages will now route to Paperclip.</p>
            )}
            {registerWebhook.isError && (
              <p className="text-xs text-destructive">{String(registerWebhook.error)}</p>
            )}
            {tgWebhookActive && (
              <Button
                size="sm"
                variant="ghost"
                className="text-xs text-muted-foreground"
                disabled={deleteWebhook.isPending}
                onClick={() => deleteWebhook.mutate()}
              >
                <Trash2 className="w-3 h-3 mr-1" />
                Remove webhook
              </Button>
            )}
          </div>
        )}
      </Card>

      {/* ── Email ── */}
      <Card className="p-5 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-base font-medium">Email</span>
          {email?.configured ? (
            <Badge variant="default" className="gap-1 text-xs bg-green-600 hover:bg-green-600">
              <CheckCircle2 className="w-3 h-3" /> {email.accountCount} account{email.accountCount !== 1 ? "s" : ""}
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-xs">
              <XCircle className="w-3 h-3 mr-1" /> No accounts
            </Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Agents receive operator messages via <strong>agent_voice</strong> email. Reply routing is automatic.
        </p>
        <a href="/email/accounts" className="text-sm text-primary hover:underline">
          Manage email accounts →
        </a>
      </Card>
    </div>
  );
}
