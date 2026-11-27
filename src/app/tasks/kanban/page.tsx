import { KanbanBoard } from "@/components/KanbanBoard";
import { prisma } from "@/lib/db";
import type { Task } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function KanbanPage() {
  const tasks: Task[] = await prisma.task.findMany({
    where: {
      isRecurringTemplate: false,
    },
    include: {
      repos: true,
      aiProvider: { select: { name: true, type: true, model: true } },
      // Top-level file entries only (a task's output files live inside a single
      // wrapper folder, so this is normally just that one folder).
      files: { where: { parentId: null }, select: { id: true, isFolder: true }, orderBy: { createdAt: "asc" } },
    },
    orderBy: { updatedAt: "desc" },
  });

  return (
    <div className="max-w-7xl mx-auto">
      <KanbanBoard tasks={tasks} />
    </div>
  );
}
