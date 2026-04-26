import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { roomsApi, type Room } from "../api/rooms";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Hash } from "lucide-react";

export function Rooms() {
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Rooms" }]);
  }, [setBreadcrumbs]);

  const { data: roomList = [], isLoading } = useQuery({
    queryKey: ["rooms", selectedCompanyId],
    queryFn: () => roomsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      roomsApi.create(selectedCompanyId!, {
        name,
        slug: slug || name.toLowerCase().replace(/\s+/g, "-"),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rooms", selectedCompanyId] });
      setShowCreate(false);
      setName("");
      setSlug("");
    },
  });

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading rooms…</div>;

  return (
    <div className="p-6 max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Rooms</h1>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          + New
        </Button>
      </div>

      {roomList.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No rooms yet. Create one to broadcast messages to groups of agents.
        </p>
      )}

      <div className="space-y-2">
        {roomList.map((room: Room) => (
          <Card
            key={room.id}
            className="p-4 cursor-pointer hover:bg-accent"
            onClick={() => navigate(`/rooms/${room.id}`)}
          >
            <div className="flex items-center gap-2">
              <Hash className="w-4 h-4 text-muted-foreground" />
              <span className="font-medium">{room.name}</span>
              <span className="text-xs text-muted-foreground ml-auto">{room.slug}</span>
            </div>
            {room.description && (
              <p className="text-xs text-muted-foreground mt-1 ml-6">{room.description}</p>
            )}
          </Card>
        ))}
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Room</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Name (e.g. Dev Team)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              placeholder="Slug (e.g. dev-team)"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
            <Button
              className="w-full"
              disabled={!name || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? "Creating…" : "Create Room"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
