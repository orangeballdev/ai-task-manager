"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { confirm } from "@/components/ui/confirm-dialog";

export function DeleteTaskButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);

  const beginDelete = () => setDeleting(true);
  const endDelete = () => setDeleting(false);

  async function handleDelete() {
    const ok = await confirm({
      title: "Delete task",
      description: "Are you sure you want to delete this task? This cannot be undone.",
      confirmLabel: "Delete",
      variant: "destructive",
    });
    if (!ok) {
      return;
    }
    beginDelete();
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
      if (res.ok) {
        router.push("/tasks");
      } else {
        toast.error("Failed to delete task. Please try again.");
      }
    } catch {
      toast.error("Failed to delete task. Please try again.");
    } finally {
      endDelete();
    }
  }

  return (
    <Button variant="destructive" size="sm" onClick={handleDelete} disabled={deleting}>
      <Trash2 />
      {deleting ? "Deleting…" : "Delete"}
    </Button>
  );
}
