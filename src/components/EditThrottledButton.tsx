"use client";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";

export function EditThrottledButton({ taskId }: { taskId: string }) {
  const router = useRouter();

  async function handleClick() {
    try {
      await fetch(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isEnabled: false }),
      });
    } catch {
      // non-fatal — still navigate to edit
    }
    router.push(`/tasks/${taskId}/edit?reenable=true`);
  }

  return (
    <button
      onClick={() => void handleClick()}
      className={buttonVariants({ variant: "secondary", size: "sm" })}
    >
      <Pencil className="size-4 mr-1.5" />Edit
    </button>
  );
}
