"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pause } from "lucide-react";
import { Button } from "@/components/ui/button";

export function DisableTaskButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleDisable() {
    setLoading(true);
    try {
      await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isEnabled: false }),
      });
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button variant="secondary" size="sm" onClick={handleDisable} disabled={loading}>
      <Pause className="size-4 mr-1.5" />
      {loading ? "Disabling…" : "Move to Backlog"}
    </Button>
  );
}
