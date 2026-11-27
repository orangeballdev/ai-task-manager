"use client";
import { useRouter } from "next/navigation";
import { OctagonX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirm } from "@/components/ui/confirm-dialog";
import { getAnalytics } from "@/components/WebAnalytics";

export function KillTaskButton({ taskId }: { taskId: string }) {
  const router = useRouter();

  async function handleKill() {
    const ok = await confirm({
      title: "Kill task",
      description: "Kill this task and mark it as failed?",
      confirmLabel: "Kill Task",
      variant: "destructive",
    });
    if (!ok) return;
    const res = await fetch(`/api/tasks/${taskId}/kill`, { method: "POST" });
    if (res.ok) {
      getAnalytics()?.capture("task_action", { action: "kill" });
      router.refresh();
    }
  }

  return (
    <Button variant="destructive" size="sm" onClick={handleKill}>
      <OctagonX />
      Kill Task
    </Button>
  );
}
