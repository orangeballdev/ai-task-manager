import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { FileBrowser } from "@/components/FileBrowser";
import { BackLink } from "@/components/BackLink";

export const dynamic = "force-dynamic";

export default async function TaskFilesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const task = await prisma.task.findUnique({
    where: { id },
    select: { id: true, title: true, isRecurringTemplate: true },
  });

  if (!task || task.isRecurringTemplate) notFound();

  return (
    <div className="max-w-7xl mx-auto">
      <div className="mb-6">
        <BackLink href={`/tasks/${id}`} label={`← ${task.title}`} />
      </div>
      <FileBrowser taskId={id} taskTitle={task.title} />
    </div>
  );
}
