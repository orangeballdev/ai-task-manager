"use client";

// Approve / Reopen for a review-only ticket's page. Same PATCH the board uses when
// a card is dragged between In Review and Done (approving records a human_review
// evaluation). There's no "Request changes": a review-only task has no agent run
// to continue — create a normal task on the referenced branch instead.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ReviewDecisionButtons({ taskId, reviewStatus }: { taskId: string; reviewStatus: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const done = reviewStatus === "done";

  async function decide(next: "done" | "in_review") {
    setBusy(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewStatus: next }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({})) as { error?: string }).error || "Failed to update");
      toast.success(next === "done" ? "Approved, moved to Done" : "Moved back to In Review");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setBusy(false);
    }
  }

  return done ? (
    <Button size="sm" variant="outline" disabled={busy} onClick={() => decide("in_review")}>
      <RotateCcw className="size-4 mr-1.5" />Reopen
    </Button>
  ) : (
    <Button size="sm" disabled={busy} onClick={() => decide("done")}>
      <CheckCircle2 className="size-4 mr-1.5" />Approve
    </Button>
  );
}
