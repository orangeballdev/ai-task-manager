"use client";
import { useRouter } from "next/navigation";
import { PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ResumeTaskButton({ taskId }: { taskId: string }) {
  const router = useRouter();

  async function handleResume() {
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "pending", nextRetryAt: null }),
    });
    if (res.ok) {
      router.refresh();
    }
  }

  return (
    <Button variant="secondary" size="sm" onClick={handleResume}>
      <PlayCircle />
      Resume now
    </Button>
  );
}
