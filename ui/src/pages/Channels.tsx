import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { channelsApi } from "../api/channels";
import { useCompany } from "../context/CompanyContext";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, AlertCircle, Send, Trash2, Webhook } from "lucide-react";

export function Channels() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId, selectedCompany } = useCompany();

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

  const setRouting = useMutation({
    mutationFn: (companyId: string | null) => channelsApi.setTelegramRouting(companyId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["channels-status"] }),
  });

  const [tokenInput, setTokenInput] = useState("");
  const saveToken = useMutation({
    mutationFn: () => channelsApi.setTelegramToken(tokenInput.trim()),
    onSuccess: () => {
      setTokenInput("");
      queryClient.invalidateQueries({ queryKey: ["channels-status"] });
    },
  });
  const removeToken = useMutation({
    mutationFn: () => channelsApi.deleteTelegramToken(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["channels-status"] }),
  });

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const tg = status?.telegram;
  const email = status?.email;
  const tgWebhookActive = !!(tg?.webhook?.url && tg.webhook.url.length > 0);
  const tgActiveHere = !!tg?.configured && tg.activeCompanyId === selectedCompanyId;

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
              ) : tgActiveHere ? (
                <Badge variant="default" className="gap-1 text-xs bg-green-600 hover:bg-green-600">
                  <CheckCircle2 className="w-3 h-3" /> Active
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-xs">
                  Bot connected — routes to another company
                </Badge>
              )
            ) : (
              <Badge variant="secondary" className="text-xs">Not configured</Badge>
            )}
          </div>
          {tgActiveHere && !tg?.error && (
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

        {tgActiveHere && !tg?.error && (
          <div className="text-sm space-y-1">
            {tg?.bot && (
              <div className="flex gap-2">
                <span className="text-muted-foreground w-32 shrink-0">Bot</span>
                <span>@{tg.bot.username} ({tg.bot.firstName})</span>
              </div>
            )}
            {tg?.operatorChatId && (
              <div className="flex gap-2">
                <span className="text-muted-foreground w-32 shrink-0">Operator chat</span>
                <span className="font-mono text-xs">{tg.operatorChatId}</span>
              </div>
            )}
          </div>
        )}

        {tg?.configured && !tgActiveHere && !tg.error && (
          <p className="text-sm text-muted-foreground">
            This bot is shared across the instance but delivers messages to one company only.
            Use the routing section below to claim it for this company.
          </p>
        )}

        {tg?.configured && !tg.error && (
          <div className="border-t border-border pt-3 space-y-2">
            <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Message routing</p>
            {tg.routingSource === "env" ? (
              <p className="text-xs text-muted-foreground">
                Routing controlled by <code className="bg-muted px-1 rounded">TELEGRAM_COMPANY_ID</code> env var.
                Remove it to enable UI routing.
              </p>
            ) : (
              <div className="space-y-2">
                <div className="flex gap-2 text-sm">
                  <span className="text-muted-foreground w-32 shrink-0">Routes to</span>
                  <span className={tg.activeCompanyId ? "font-medium" : "text-muted-foreground italic"}>
                    {tg.activeCompanyId === selectedCompanyId
                      ? `${selectedCompany?.name ?? "this company"} (current)`
                      : tg.activeCompanyId
                        ? "Another company"
                        : "Not set"}
                  </span>
                </div>
                {selectedCompanyId && tg.activeCompanyId !== selectedCompanyId && (
                  <Button
                    size="sm" variant="outline"
                    disabled={setRouting.isPending}
                    onClick={() => setRouting.mutate(selectedCompanyId)}
                  >
                    {setRouting.isPending ? "Saving…" : `Route to ${selectedCompany?.name ?? "this company"}`}
                  </Button>
                )}
                {setRouting.isSuccess && <span className="text-xs text-green-600">✓ Saved</span>}
                {setRouting.isError && <span className="text-xs text-destructive">Failed</span>}
              </div>
            )}
          </div>
        )}

        {tg?.error && (
          <p className="text-sm text-destructive">{tg.error}</p>
        )}

        {/* Bot token management */}
        <div className="border-t border-border pt-3 space-y-2">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">Bot token</p>
          {tg?.tokenSource === "env" && (
            <p className="text-xs text-muted-foreground">
              Token loaded from <code className="bg-muted px-1 rounded">TELEGRAM_BOT_TOKEN</code> env var.
              Enter a token below to override with an encrypted DB value.
            </p>
          )}
          {tg?.tokenSource === "db" ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-green-600">✓ Token stored encrypted in database</span>
              <Button
                size="sm" variant="ghost"
                className="text-xs text-destructive h-6 px-2"
                disabled={removeToken.isPending}
                onClick={() => removeToken.mutate()}
              >
                <Trash2 className="w-3 h-3 mr-1" /> Remove
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No token configured. Enter your Telegram bot token from{" "}
              <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="underline">@BotFather</a>.
            </p>
          )}
          <div className="flex gap-2">
            <Input
              type="password"
              className="text-sm flex-1 font-mono"
              placeholder="1234567890:AAHxxxx..."
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
            />
            <Button
              size="sm"
              disabled={!tokenInput.trim() || saveToken.isPending}
              onClick={() => saveToken.mutate()}
            >
              {saveToken.isPending ? "Saving…" : "Save encrypted"}
            </Button>
          </div>
          {saveToken.isSuccess && <p className="text-xs text-green-600">✓ Token saved and encrypted. Active within 25 seconds.</p>}
          {saveToken.isError && <p className="text-xs text-destructive">{String(saveToken.error)}</p>}
        </div>

        {!tg?.configured && !tokenInput && (
          <div className="text-sm text-muted-foreground space-y-1">
            <p>Enter your bot token above, or set <code className="text-xs bg-muted px-1 rounded">TELEGRAM_BOT_TOKEN</code> in your env file.</p>
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
