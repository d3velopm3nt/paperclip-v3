// v3: score widget — star rating for agent performance after plan execution
import { useState } from "react";
import { Star } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "../context/ToastContext";

interface ScoreWidgetProps {
  agentId: string;
  agentName: string;
  planId?: string;
  issueId?: string;
  onScoreSubmitted?: () => void;
}

export function ScoreWidget({
  agentId,
  agentName,
  planId,
  issueId,
  onScoreSubmitted,
}: ScoreWidgetProps) {
  const [score, setScore] = useState<number>(0);
  const [hoveredScore, setHoveredScore] = useState<number>(0);
  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const submitMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/agents/${agentId}/scores`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ score, planId, issueId, comment: comment || undefined }),
      });
      if (!res.ok) throw new Error("Failed to submit score");
      return res.json();
    },
    onSuccess: () => {
      setSubmitted(true);
      pushToast({ title: "Score submitted" });
      queryClient.invalidateQueries({ queryKey: ["agent-scores", agentId] });
      onScoreSubmitted?.();
    },
  });

  if (submitted) {
    return (
      <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 text-sm text-green-400">
        ✓ Thanks for rating {agentName}!
      </div>
    );
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
      <div className="text-sm font-medium text-white">
        How did {agentName} do? Rate 1-5
      </div>

      <div className="flex gap-1">
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            type="button"
            onMouseEnter={() => setHoveredScore(value)}
            onMouseLeave={() => setHoveredScore(0)}
            onClick={() => setScore(value)}
            className="p-1 hover:scale-110 transition-transform"
          >
            <Star
              className={`w-8 h-8 ${
                value <= (hoveredScore || score)
                  ? "fill-yellow-400 text-yellow-400"
                  : "text-zinc-700"
              }`}
            />
          </button>
        ))}
      </div>

      <Textarea
        placeholder="Optional comment..."
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
        className="text-sm"
      />

      <Button
        onClick={() => submitMutation.mutate()}
        disabled={score === 0 || submitMutation.isPending}
        size="sm"
        className="w-full"
      >
        {submitMutation.isPending ? "Submitting..." : "Submit Rating"}
      </Button>
    </div>
  );
}
