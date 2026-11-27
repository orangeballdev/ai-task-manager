"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { getAnalytics } from "@/components/WebAnalytics";

interface RunNowButtonProps {
  taskId: string;
  mode: "scheduled" | "recurring";
}

export function RunNowButton({ taskId, mode }: RunNowButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleRunNow() {
    setLoading(true);
    try {
      if (mode === "recurring") {
        const res = await fetch(`/api/tasks/${taskId}/run-now`, { method: "POST" });
        if (!res.ok) throw new Error("Failed to start task");
        const data = await res.json() as { taskId?: string };
        getAnalytics()?.capture("task_action", { action: "run_now", mode });
        toast.success("Task instance queued");
        if (data.taskId) router.push(`/tasks/${data.taskId}`);
        else router.refresh();
      } else {
        await fetch(`/api/tasks/${taskId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scheduledFor: null }),
        });
        getAnalytics()?.capture("task_action", { action: "run_now", mode });
        toast.success("Task will run now");
        router.refresh();
      }
    } catch {
      toast.error("Failed to run task");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button variant="secondary" size="sm" onClick={handleRunNow} disabled={loading}>
      <PlayCircle className="size-4 mr-1.5" />
      {loading ? "Starting…" : "Run Now"}
    </Button>
  );
}
