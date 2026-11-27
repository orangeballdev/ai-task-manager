"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RunBacklogTaskButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleRunNow() {
    setLoading(true);
    try {
      await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isEnabled: true, scheduledFor: null }),
      });
      router.refresh();
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
