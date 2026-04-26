import { useEffect } from "react";
import { useParams, useNavigate } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { roomsApi, type OperatorMessage, type RoomMember } from "../api/rooms";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Bot, User } from "lucide-react";

export function RoomDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();

  const { data: room, isLoading } = useQuery({
    queryKey: ["room", id],
    queryFn: () => roomsApi.get(id!),
    enabled: !!id,
  });

  const { data: messages = [] } = useQuery({
    queryKey: ["room-messages", id],
    queryFn: () => roomsApi.getMessages(id!),
    enabled: !!id,
    refetchInterval: 10_000,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Rooms", href: "/rooms" },
      { label: room?.name ?? "Room" },
    ]);
  }, [setBreadcrumbs, room?.name]);

  const removeMember = useMutation({
    mutationFn: (memberId: string) => roomsApi.removeMember(id!, memberId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["room", id] }),
  });

  const toggleApproval = useMutation({
    mutationFn: (requireApproval: boolean) => roomsApi.update(id!, { requireApproval }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["room", id] }),
  });

  if (isLoading || !room) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <button
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        onClick={() => navigate("/rooms")}
      >
        <ArrowLeft className="w-4 h-4" /> Rooms
      </button>

      <div>
        <h1 className="text-xl font-semibold">#{room.name}</h1>
        {room.description && (
          <p className="text-sm text-muted-foreground mt-1">{room.description}</p>
        )}
      </div>

      {/* Members */}
      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-medium">Members</h2>
        {room.members.length === 0 && (
          <p className="text-xs text-muted-foreground">No members yet.</p>
        )}
        {room.members.map((m: RoomMember) => (
          <div key={m.id} className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <Bot className="w-4 h-4 text-muted-foreground" />
              <span>{m.isOperator ? "Operator" : (m.agentId ?? "Unknown")}</span>
            </div>
            {!m.isOperator && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => removeMember.mutate(m.id)}
              >
                Remove
              </Button>
            )}
          </div>
        ))}
      </Card>

      {/* Settings */}
      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-medium">Settings</h2>
        <div className="flex items-center gap-3">
          <Checkbox
            id="require-approval"
            checked={room.requireApproval}
            onCheckedChange={(checked) => toggleApproval.mutate(checked === true)}
          />
          <Label htmlFor="require-approval">Require approval before agents act</Label>
        </div>
        <div className="text-xs text-muted-foreground border rounded p-3 bg-muted">
          <strong>Email this room:</strong> Send to agent_voice with{" "}
          <code>@{room.slug}</code> anywhere in the body.
        </div>
      </Card>

      {/* Thread */}
      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-medium">Thread</h2>
        {messages.length === 0 && (
          <p className="text-xs text-muted-foreground">No messages yet.</p>
        )}
        <div className="space-y-3 max-h-96 overflow-y-auto">
          {messages.map((msg: OperatorMessage) => (
            <div key={msg.id} className="flex gap-2 text-sm">
              {msg.direction === "inbound" ? (
                <User className="w-4 h-4 mt-0.5 text-blue-500 shrink-0" />
              ) : (
                <Bot className="w-4 h-4 mt-0.5 text-green-500 shrink-0" />
              )}
              <div>
                <div className="text-xs text-muted-foreground mb-0.5">
                  {msg.direction === "inbound" ? "Operator" : "Agent"} ·{" "}
                  {new Date(msg.createdAt).toLocaleString()} ·{" "}
                  <span className="capitalize">{msg.platform}</span>
                </div>
                <div className="whitespace-pre-wrap">{msg.body}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
