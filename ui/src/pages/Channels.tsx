import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { channelsApi, type TelegramChannelStatus, type WhatsAppChannelStatus } from "../api/channels";
import { useCompany } from "../context/CompanyContext";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  CheckCircle2,
  XCircle,
  AlertCircle,
  Send,
  Trash2,
  Webhook,
  Mail,
  MessageSquareMore,
  Plus,
  Settings2,
  ChevronRight,
  Phone,
} from "lucide-react";

// ─── Telegram Sheet ────────────────────────────────────────────────────────

function TelegramSheet({
  open,
  onClose,
  tg,
  selectedCompanyId,
  selectedCompanyName,
}: {
  open: boolean;
  onClose: () => void;
  tg: TelegramChannelStatus;
  selectedCompanyId: string | null;
  selectedCompanyName: string | undefined;
}) {
  const queryClient = useQueryClient();
  const [webhookUrl, setWebhookUrl] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [chatIdInput, setChatIdInput] = useState("");

  const tgWebhookActive = !!(tg.webhook?.url && tg.webhook.url.length > 0);
  const tgActiveHere = !!tg.configured && tg.activeCompanyId === selectedCompanyId;

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

  const saveToken = useMutation({
    mutationFn: () => channelsApi.setTelegramToken(tokenInput.trim()),
    onSuccess: () => {
      setTokenInput("");
      queryClient.invalidateQueries({ queryKey: ["channels-status"] });
    },
  });

  const removeToken = useMutation({
    mutationFn: channelsApi.deleteTelegramToken,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["channels-status"] }),
  });

  const saveOperatorChatId = useMutation({
    mutationFn: () => channelsApi.setTelegramOperatorChatId(chatIdInput.trim()),
    onSuccess: () => {
      setChatIdInput("");
      queryClient.invalidateQueries({ queryKey: ["channels-status"] });
    },
  });

  const detectOperatorChatId = useMutation({
    mutationFn: channelsApi.detectTelegramOperatorChatId,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["channels-status"] }),
  });

  const testTg = useMutation({ mutationFn: channelsApi.testTelegram });

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="pb-2">
          <SheetTitle className="flex items-center gap-2">
            <Send className="w-4 h-4 text-blue-400" />
            Telegram
          </SheetTitle>
          <SheetDescription>
            Configure your Telegram bot for inbound messages.
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-6 space-y-6">
          {/* Status */}
          {tg.configured && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
              {tg.error ? (
                <>
                  <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
                  <span className="text-sm text-destructive">{tg.error}</span>
                </>
              ) : tgActiveHere ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                  <div className="text-sm">
                    <p className="font-medium">Active</p>
                    {tg.bot && (
                      <p className="text-muted-foreground">@{tg.bot.username} ({tg.bot.firstName})</p>
                    )}
                  </div>
                  <Button
                    size="sm" variant="outline" className="ml-auto"
                    disabled={testTg.isPending}
                    onClick={() => testTg.mutate()}
                  >
                    <Send className="w-3 h-3 mr-1" />
                    {testTg.isPending ? "Sending…" : "Test"}
                  </Button>
                </>
              ) : (
                <>
                  <AlertCircle className="w-4 h-4 text-yellow-500 shrink-0" />
                  <span className="text-sm text-muted-foreground">Bot connected — routes to another company</span>
                </>
              )}
            </div>
          )}

          {/* Bot token */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Bot token</p>
            {tg.tokenSource === "env" && (
              <p className="text-xs text-muted-foreground">
                Loaded from <code className="bg-muted px-1 rounded">TELEGRAM_BOT_TOKEN</code> env var.
                Enter below to override with encrypted DB value.
              </p>
            )}
            {tg.tokenSource === "db" ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-green-600">✓ Stored encrypted in database</span>
                <Button
                  size="sm" variant="ghost" className="text-xs text-destructive h-6 px-2 ml-auto"
                  disabled={removeToken.isPending}
                  onClick={() => removeToken.mutate()}
                >
                  <Trash2 className="w-3 h-3 mr-1" /> Remove
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Get your token from{" "}
                <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="underline">
                  @BotFather
                </a>.
              </p>
            )}
            <div className="flex gap-2">
              <Input
                type="password"
                className="text-sm flex-1 font-mono"
                placeholder="1234567890:AAHxxxx…"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
              />
              <Button
                size="sm"
                disabled={!tokenInput.trim() || saveToken.isPending}
                onClick={() => saveToken.mutate()}
              >
                {saveToken.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
            {saveToken.isSuccess && <p className="text-xs text-green-600">✓ Saved. Active within 25 seconds.</p>}
            {saveToken.isError && <p className="text-xs text-destructive">{String(saveToken.error)}</p>}
          </div>

          {/* Operator Chat ID */}
          <Separator />
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Operator chat ID</p>
            {tg.operatorChatId ? (
              <p className="text-xs text-green-600">✓ Set: <code className="bg-muted px-1 rounded">{tg.operatorChatId}</code></p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Needed so Paperclip can notify you via Telegram. Send any message to your bot, then click Detect.
              </p>
            )}
            <Button
              size="sm" variant="outline" className="w-full"
              disabled={detectOperatorChatId.isPending}
              onClick={() => detectOperatorChatId.mutate()}
            >
              {detectOperatorChatId.isPending ? "Detecting…" : tg.operatorChatId ? "Re-detect from recent messages" : "Detect from recent messages"}
            </Button>
            {detectOperatorChatId.isSuccess && (
              <p className="text-xs text-green-600">✓ Detected and saved: <code className="bg-muted px-1 rounded">{detectOperatorChatId.data?.chatId}</code></p>
            )}
            {detectOperatorChatId.isError && (
              <p className="text-xs text-destructive">{String(detectOperatorChatId.error)}</p>
            )}
            <p className="text-xs text-muted-foreground">Or enter manually:</p>
            <div className="flex gap-2">
              <Input
                className="text-sm flex-1"
                placeholder="123456789"
                value={chatIdInput}
                onChange={(e) => setChatIdInput(e.target.value)}
              />
              <Button
                size="sm"
                disabled={!chatIdInput.trim() || saveOperatorChatId.isPending}
                onClick={() => saveOperatorChatId.mutate()}
              >
                {saveOperatorChatId.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
            {saveOperatorChatId.isSuccess && <p className="text-xs text-green-600">✓ Saved</p>}
            {saveOperatorChatId.isError && <p className="text-xs text-destructive">{String(saveOperatorChatId.error)}</p>}
          </div>

          {/* Routing */}
          {tg.configured && !tg.error && (
            <>
              <Separator />
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Message routing</p>
                {tg.routingSource === "env" ? (
                  <p className="text-xs text-muted-foreground">
                    Controlled by <code className="bg-muted px-1 rounded">TELEGRAM_COMPANY_ID</code> env var.
                    Remove it to enable UI routing.
                  </p>
                ) : (
                  <div className="space-y-2">
                    <div className="flex gap-2 text-sm">
                      <span className="text-muted-foreground w-24 shrink-0">Routes to</span>
                      <span className={tg.activeCompanyId ? "font-medium" : "text-muted-foreground italic"}>
                        {tg.activeCompanyId === selectedCompanyId
                          ? `${selectedCompanyName ?? "this company"} (current)`
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
                        {setRouting.isPending ? "Saving…" : `Route to ${selectedCompanyName ?? "this company"}`}
                      </Button>
                    )}
                    {setRouting.isSuccess && <span className="text-xs text-green-600">✓ Saved</span>}
                    {setRouting.isError && <span className="text-xs text-destructive">Failed</span>}
                  </div>
                )}
              </div>
            </>
          )}

          {/* Webhook */}
          {tg.configured && !tg.error && (
            <>
              <Separator />
              <div className="space-y-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Webhook
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
                  <p className="text-xs text-green-600">Webhook registered. Messages now route to Paperclip.</p>
                )}
                {registerWebhook.isError && (
                  <p className="text-xs text-destructive">{String(registerWebhook.error)}</p>
                )}
                {tgWebhookActive && (
                  <div className="flex items-center gap-2">
                    <p className="text-xs text-muted-foreground truncate flex-1">
                      Active: {tg.webhook?.url}
                    </p>
                    <Button
                      size="sm" variant="ghost" className="text-xs text-muted-foreground shrink-0"
                      disabled={deleteWebhook.isPending}
                      onClick={() => deleteWebhook.mutate()}
                    >
                      <Trash2 className="w-3 h-3 mr-1" />
                      Remove
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── WhatsApp Sheet ────────────────────────────────────────────────────────

function WhatsAppSheet({
  open,
  onClose,
  wa,
  selectedCompanyId,
  selectedCompanyName,
}: {
  open: boolean;
  onClose: () => void;
  wa: WhatsAppChannelStatus;
  selectedCompanyId: string | null;
  selectedCompanyName: string | undefined;
}) {
  const queryClient = useQueryClient();
  const [tokenInput, setTokenInput] = useState("");
  const [phoneIdInput, setPhoneIdInput] = useState("");
  const [wabaIdInput, setWabaIdInput] = useState("");
  const [verifyTokenInput, setVerifyTokenInput] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [contactInput, setContactInput] = useState("");
  const [contacts, setContacts] = useState<string[]>(wa.allowedContacts ?? []);

  // Sync contacts when status updates
  const allowedContacts = wa.allowedContacts ?? [];

  const saveToken = useMutation({
    mutationFn: () => channelsApi.setWhatsAppToken(tokenInput.trim()),
    onSuccess: () => {
      setTokenInput("");
      queryClient.invalidateQueries({ queryKey: ["channels-status"] });
    },
  });

  const deleteToken = useMutation({
    mutationFn: channelsApi.deleteWhatsAppToken,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["channels-status"] }),
  });

  const savePhone = useMutation({
    mutationFn: () => channelsApi.setWhatsAppPhone(phoneIdInput.trim(), wabaIdInput.trim()),
    onSuccess: () => {
      setPhoneIdInput("");
      setWabaIdInput("");
      queryClient.invalidateQueries({ queryKey: ["channels-status"] });
    },
  });

  const saveVerifyToken = useMutation({
    mutationFn: () => channelsApi.setWhatsAppVerifyToken(verifyTokenInput.trim()),
    onSuccess: () => {
      setVerifyTokenInput("");
      queryClient.invalidateQueries({ queryKey: ["channels-status"] });
    },
  });

  const registerWebhook = useMutation({
    mutationFn: () => channelsApi.registerWhatsAppWebhook(webhookUrl),
    onSuccess: () => {
      setWebhookUrl("");
      queryClient.invalidateQueries({ queryKey: ["channels-status"] });
    },
  });

  const setRouting = useMutation({
    mutationFn: (companyId: string | null) => channelsApi.setWhatsAppRouting(companyId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["channels-status"] }),
  });

  const saveContacts = useMutation({
    mutationFn: (list: string[]) => channelsApi.setWhatsAppContacts(list),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["channels-status"] }),
  });

  function addContact() {
    const normalized = contactInput.trim().replace(/\s/g, "");
    if (!normalized || allowedContacts.includes(normalized)) return;
    const updated = [...allowedContacts, normalized];
    saveContacts.mutate(updated);
    setContactInput("");
  }

  function removeContact(phone: string) {
    saveContacts.mutate(allowedContacts.filter((c) => c !== phone));
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="pb-2">
          <SheetTitle className="flex items-center gap-2">
            <MessageSquareMore className="w-4 h-4 text-green-500" />
            WhatsApp
          </SheetTitle>
          <SheetDescription>
            Connect via Meta Cloud API. Inbound only — selected contacts route through your pipeline.
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 pb-6 space-y-6">
          {/* Status */}
          {wa.configured && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
              {wa.error ? (
                <>
                  <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
                  <span className="text-sm text-destructive">{wa.error}</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0" />
                  <div className="text-sm">
                    <p className="font-medium">Active</p>
                    {wa.phoneNumberId && (
                      <p className="text-muted-foreground font-mono text-xs">{wa.phoneNumberId}</p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Step 1: Access token */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              1. Access token
            </p>
            <p className="text-xs text-muted-foreground">
              Create a system user token in your{" "}
              <span className="text-foreground">Meta Business Manager</span> with
              {" "}<code className="bg-muted px-1 rounded">whatsapp_business_messaging</code> permission.
            </p>
            {wa.tokenSource === "db" ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-green-600">✓ Token stored encrypted</span>
                <Button
                  size="sm" variant="ghost" className="text-xs text-destructive h-6 px-2 ml-auto"
                  disabled={deleteToken.isPending}
                  onClick={() => deleteToken.mutate()}
                >
                  <Trash2 className="w-3 h-3 mr-1" /> Remove
                </Button>
              </div>
            ) : null}
            <div className="flex gap-2">
              <Input
                type="password"
                className="text-sm flex-1 font-mono"
                placeholder="EAAxxxxxxxxx…"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
              />
              <Button
                size="sm"
                disabled={!tokenInput.trim() || saveToken.isPending}
                onClick={() => saveToken.mutate()}
              >
                {saveToken.isPending ? "Saving…" : "Save"}
              </Button>
            </div>
            {saveToken.isSuccess && <p className="text-xs text-green-600">✓ Saved encrypted.</p>}
            {saveToken.isError && <p className="text-xs text-destructive">{String(saveToken.error)}</p>}
          </div>

          <Separator />

          {/* Step 2: Phone Number ID + WABA ID */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              2. Phone number
            </p>
            <p className="text-xs text-muted-foreground">
              Found in Meta dashboard → WhatsApp → Getting Started.
            </p>
            {wa.phoneNumberId && (
              <p className="text-xs text-green-600">✓ Phone Number ID: <span className="font-mono">{wa.phoneNumberId}</span></p>
            )}
            <Input
              className="text-sm font-mono"
              placeholder="Phone Number ID (e.g. 123456789012345)"
              value={phoneIdInput}
              onChange={(e) => setPhoneIdInput(e.target.value)}
            />
            <Input
              className="text-sm font-mono"
              placeholder="WhatsApp Business Account ID"
              value={wabaIdInput}
              onChange={(e) => setWabaIdInput(e.target.value)}
            />
            <Button
              size="sm"
              disabled={!phoneIdInput.trim() || !wabaIdInput.trim() || savePhone.isPending}
              onClick={() => savePhone.mutate()}
            >
              {savePhone.isPending ? "Saving…" : "Save phone details"}
            </Button>
            {savePhone.isSuccess && <p className="text-xs text-green-600">✓ Saved.</p>}
            {savePhone.isError && <p className="text-xs text-destructive">{String(savePhone.error)}</p>}
          </div>

          <Separator />

          {/* Step 3: Verify token + Webhook */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              3. Webhook
            </p>
            <p className="text-xs text-muted-foreground">
              Set a verify token (any string — you'll enter the same in Meta dashboard), then register
              your tunnel URL.
            </p>
            <div className="flex gap-2">
              <Input
                className="text-sm flex-1"
                placeholder="Verify token (e.g. paperclip-wa)"
                value={verifyTokenInput}
                onChange={(e) => setVerifyTokenInput(e.target.value)}
              />
              <Button
                size="sm" variant="outline"
                disabled={!verifyTokenInput.trim() || saveVerifyToken.isPending}
                onClick={() => saveVerifyToken.mutate()}
              >
                {saveVerifyToken.isPending ? "Saving…" : "Set"}
              </Button>
            </div>
            {saveVerifyToken.isSuccess && <p className="text-xs text-green-600">✓ Verify token set.</p>}

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
              <p className="text-xs text-green-600">✓ Webhook URL registered. Set this URL in Meta dashboard.</p>
            )}
            {registerWebhook.isError && (
              <p className="text-xs text-destructive">{String(registerWebhook.error)}</p>
            )}
            {wa.webhookVerified && (
              <div className="flex items-center gap-1.5 text-xs text-green-600">
                <CheckCircle2 className="w-3 h-3" /> Webhook verified by Meta
              </div>
            )}
          </div>

          <Separator />

          {/* Step 4: Allowed contacts */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              4. Allowed contacts
            </p>
            <p className="text-xs text-muted-foreground">
              Only messages from these numbers enter the pipeline. Use international format (e.g. <code className="bg-muted px-1 rounded">+447911123456</code>).
            </p>
            <div className="flex gap-2">
              <Input
                className="text-sm flex-1"
                placeholder="+447911123456"
                value={contactInput}
                onChange={(e) => setContactInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addContact()}
              />
              <Button
                size="sm" variant="outline"
                disabled={!contactInput.trim() || saveContacts.isPending}
                onClick={addContact}
              >
                <Plus className="w-3 h-3" />
              </Button>
            </div>
            {allowedContacts.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No contacts added — all inbound messages will be ignored.</p>
            ) : (
              <div className="space-y-1">
                {allowedContacts.map((phone) => (
                  <div key={phone} className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-muted/50">
                    <Phone className="w-3 h-3 text-muted-foreground shrink-0" />
                    <span className="text-sm font-mono flex-1">{phone}</span>
                    <Button
                      size="sm" variant="ghost" className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => removeContact(phone)}
                    >
                      <XCircle className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {saveContacts.isError && (
              <p className="text-xs text-destructive">{String(saveContacts.error)}</p>
            )}
          </div>

          <Separator />

          {/* Step 5: Routing */}
          <div className="space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              5. Company routing
            </p>
            <div className="flex gap-2 text-sm">
              <span className="text-muted-foreground w-24 shrink-0">Routes to</span>
              <span className={wa.activeCompanyId ? "font-medium" : "text-muted-foreground italic"}>
                {wa.activeCompanyId === selectedCompanyId
                  ? `${selectedCompanyName ?? "this company"} (current)`
                  : wa.activeCompanyId
                    ? "Another company"
                    : "Not set"}
              </span>
            </div>
            {selectedCompanyId && wa.activeCompanyId !== selectedCompanyId && (
              <Button
                size="sm" variant="outline"
                disabled={setRouting.isPending}
                onClick={() => setRouting.mutate(selectedCompanyId)}
              >
                {setRouting.isPending ? "Saving…" : `Route to ${selectedCompanyName ?? "this company"}`}
              </Button>
            )}
            {setRouting.isSuccess && <span className="text-xs text-green-600">✓ Saved</span>}
            {setRouting.isError && <span className="text-xs text-destructive">Failed</span>}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Channel type picker sheet ─────────────────────────────────────────────

type ChannelType = "telegram" | "whatsapp";

function ChannelPickerSheet({
  open,
  onClose,
  onPick,
  configured,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (type: ChannelType) => void;
  configured: Set<string>;
}) {
  const channels: { type: ChannelType; icon: React.ReactNode; label: string; description: string }[] = [
    {
      type: "telegram",
      icon: <Send className="w-5 h-5 text-blue-400" />,
      label: "Telegram",
      description: "Receive and reply to messages via a Telegram bot.",
    },
    {
      type: "whatsapp",
      icon: <MessageSquareMore className="w-5 h-5 text-green-500" />,
      label: "WhatsApp",
      description: "Inbound messages from selected contacts via Meta Cloud API.",
    },
  ];

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full sm:max-w-sm">
        <SheetHeader className="pb-4">
          <SheetTitle>Add channel</SheetTitle>
          <SheetDescription>Choose a channel type to configure.</SheetDescription>
        </SheetHeader>
        <div className="px-4 space-y-2">
          {channels.map(({ type, icon, label, description }) => (
            <button
              key={type}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-accent/50 transition-colors text-left"
              onClick={() => onPick(type)}
            >
              <div className="w-9 h-9 rounded-md bg-muted flex items-center justify-center shrink-0">
                {icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{label}</span>
                  {configured.has(type) && (
                    <Badge variant="secondary" className="text-xs">Configured</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{description}</p>
              </div>
              <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
            </button>
          ))}

          {/* Email — redirects */}
          <a
            href="/email/accounts"
            className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-accent/50 transition-colors text-left"
          >
            <div className="w-9 h-9 rounded-md bg-muted flex items-center justify-center shrink-0">
              <Mail className="w-5 h-5 text-orange-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Email</span>
              </div>
              <p className="text-xs text-muted-foreground">Manage email accounts for agent_voice routing.</p>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
          </a>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────

type OpenSheet = "picker" | "telegram" | "whatsapp" | null;

export function Channels() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const [activeTab, setActiveTab] = useState("channels");
  const [openSheet, setOpenSheet] = useState<OpenSheet>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Channels" }]);
  }, [setBreadcrumbs]);

  const { data: status, isLoading } = useQuery({
    queryKey: ["channels-status"],
    queryFn: channelsApi.status,
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  const tg = status?.telegram ?? { configured: false };
  const wa = status?.whatsapp ?? { configured: false };
  const email = status?.email ?? { configured: false, accountCount: 0 };

  const tgActiveHere = tg.configured && tg.activeCompanyId === selectedCompanyId;
  const waActiveHere = wa.configured && wa.activeCompanyId === selectedCompanyId;

  // Channels shown in the Channels tab
  type ChannelSummary = {
    key: string;
    icon: React.ReactNode;
    label: string;
    configured: boolean;
    statusNode: React.ReactNode;
    detail: string;
    onManage: () => void;
  };

  const channelSummaries: ChannelSummary[] = [
    {
      key: "telegram",
      icon: <Send className="w-5 h-5 text-blue-400" />,
      label: "Telegram",
      configured: tg.configured,
      statusNode: tg.configured
        ? tg.error
          ? <Badge variant="destructive" className="gap-1 text-xs"><AlertCircle className="w-3 h-3" /> Error</Badge>
          : tgActiveHere
            ? <Badge className="gap-1 text-xs bg-green-600 hover:bg-green-600"><CheckCircle2 className="w-3 h-3" /> Active</Badge>
            : <Badge variant="secondary" className="text-xs">Other company</Badge>
        : <Badge variant="secondary" className="text-xs">Not configured</Badge>,
      detail: tg.configured && tg.bot
        ? `@${tg.bot.username}`
        : "Connect via @BotFather",
      onManage: () => setOpenSheet("telegram"),
    },
    {
      key: "whatsapp",
      icon: <MessageSquareMore className="w-5 h-5 text-green-500" />,
      label: "WhatsApp",
      configured: wa.configured,
      statusNode: wa.configured
        ? wa.error
          ? <Badge variant="destructive" className="gap-1 text-xs"><AlertCircle className="w-3 h-3" /> Error</Badge>
          : waActiveHere
            ? <Badge className="gap-1 text-xs bg-green-600 hover:bg-green-600"><CheckCircle2 className="w-3 h-3" /> Active</Badge>
            : <Badge variant="secondary" className="text-xs">Other company</Badge>
        : <Badge variant="secondary" className="text-xs">Not configured</Badge>,
      detail: wa.configured && wa.phoneNumberId
        ? `${wa.allowedContacts?.length ?? 0} contact${(wa.allowedContacts?.length ?? 0) !== 1 ? "s" : ""} monitored`
        : "Meta Cloud API",
      onManage: () => setOpenSheet("whatsapp"),
    },
    {
      key: "email",
      icon: <Mail className="w-5 h-5 text-orange-400" />,
      label: "Email",
      configured: email.configured,
      statusNode: email.configured
        ? <Badge className="gap-1 text-xs bg-green-600 hover:bg-green-600"><CheckCircle2 className="w-3 h-3" /> {email.accountCount} account{email.accountCount !== 1 ? "s" : ""}</Badge>
        : <Badge variant="secondary" className="text-xs">No accounts</Badge>,
      detail: "agent_voice email routing",
      onManage: () => { window.location.href = "/email/accounts"; },
    },
  ];

  const configured = new Set(
    channelSummaries.filter((c) => c.configured).map((c) => c.key)
  );

  return (
    <div className="p-6 max-w-2xl space-y-4">
      <div>
        <h1 className="text-xl font-bold">Channels</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Inbound and outbound messaging for your agent pipeline.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="channels">Channels</TabsTrigger>
          <TabsTrigger value="setup">Setup</TabsTrigger>
        </TabsList>

        {/* ── Channels tab ── */}
        <TabsContent value="channels" className="mt-4">
          {configured.size === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
                <Settings2 className="w-5 h-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">No channels configured</p>
              <p className="text-xs text-muted-foreground mt-1 mb-4">
                Connect a messaging channel to start receiving messages.
              </p>
              <Button size="sm" onClick={() => setActiveTab("setup")}>
                Go to Setup
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {channelSummaries.filter((c) => c.configured).map((ch) => (
                <Card key={ch.key} className="p-4">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-md bg-muted flex items-center justify-center shrink-0">
                      {ch.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{ch.label}</span>
                        {ch.statusNode}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{ch.detail}</p>
                    </div>
                    <Button
                      size="sm" variant="outline" className="shrink-0"
                      onClick={ch.onManage}
                    >
                      Manage
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── Setup tab ── */}
        <TabsContent value="setup" className="mt-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Available channels
            </p>
            <Button size="sm" onClick={() => setOpenSheet("picker")}>
              <Plus className="w-3 h-3 mr-1.5" />
              Add channel
            </Button>
          </div>

          <div className="space-y-2">
            {channelSummaries.map((ch) => (
              <Card key={ch.key} className="p-4">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-md bg-muted flex items-center justify-center shrink-0">
                    {ch.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{ch.label}</span>
                      {ch.statusNode}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={ch.configured ? "outline" : "default"}
                    className="shrink-0"
                    onClick={ch.onManage}
                  >
                    {ch.configured ? "Edit" : "Configure"}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>

      {/* Sheets */}
      <ChannelPickerSheet
        open={openSheet === "picker"}
        onClose={() => setOpenSheet(null)}
        onPick={(type) => setOpenSheet(type)}
        configured={configured}
      />

      <TelegramSheet
        open={openSheet === "telegram"}
        onClose={() => setOpenSheet(null)}
        tg={tg}
        selectedCompanyId={selectedCompanyId}
        selectedCompanyName={selectedCompany?.name}
      />

      <WhatsAppSheet
        open={openSheet === "whatsapp"}
        onClose={() => setOpenSheet(null)}
        wa={wa}
        selectedCompanyId={selectedCompanyId}
        selectedCompanyName={selectedCompany?.name}
      />
    </div>
  );
}
