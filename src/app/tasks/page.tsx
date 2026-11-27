import Link from "next/link";
import { prisma } from "@/lib/db";
import { getProvider } from "@/lib/smart-provider";
import { TasksPageView } from "@/components/TasksPageView";
import { WorkerStatus } from "@/components/WorkerStatus";
import { buttonVariants } from "@/components/ui/button";
import type { Task } from "@/lib/types";

export const dynamic = "force-dynamic";

function thirtyDaysAgo(): Date {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

export default async function TasksPage() {
  const webhookEvents = await prisma.webhookEvent.findMany({
    where: { taskId: { not: null } },
    select: { taskId: true },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webhookTaskIds = webhookEvents.map((e: any) => e.taskId as string);

  const taskInclude = { repos: true, aiProvider: { select: { name: true, type: true, model: true } }, dependsOn: { select: { id: true, title: true, status: true } } };

  const [adHocTasks, scheduledTasks, webhookTasks, recurringTemplates, defaultProvider, recentInstances, smartPickerSetting] = await Promise.all([
    prisma.task.findMany({
      where: {
        isRecurringTemplate: false,
        recurringTemplateId: null,
        ...(webhookTaskIds.length > 0 ? { id: { notIn: webhookTaskIds } } : {}),
      },
      include: taskInclude,
      orderBy: { updatedAt: "desc" },
    }),
    prisma.task.findMany({
      where: { isRecurringTemplate: false, recurringTemplateId: { not: null } },
      include: taskInclude,
      orderBy: { updatedAt: "desc" },
    }),
    webhookTaskIds.length > 0
      ? prisma.task.findMany({
          where: { id: { in: webhookTaskIds } },
          include: taskInclude,
          orderBy: { updatedAt: "desc" },
        })
      : Promise.resolve([]),
    prisma.task.findMany({
      where: { isRecurringTemplate: true },
      include: { repos: true, aiProvider: { select: { name: true, type: true, model: true } } },
      orderBy: [{ isEnabled: "desc" }, { createdAt: "desc" }],
    }),
    getProvider().then((r) => r.provider),
    prisma.task.findMany({
      where: {
        isRecurringTemplate: false,
        recurringTemplateId: { not: null },
        createdAt: { gte: thirtyDaysAgo() },
      },
      select: { recurringTemplateId: true, status: true },
    }),
    prisma.setting.findUnique({ where: { key: "smart_provider_picker" } }),
  ]);

  const globalSmartPickEnabled = smartPickerSetting?.value === "true";

  // A task with no explicit aiProvider will be resolved by the smart picker at run time (either
  // via its own useSmartProvider flag or the global setting) rather than the org's default
  // provider — don't silently present it as if the default provider was chosen for it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const injectProvider = (tasks: any[]) => tasks.map((t) => {
    if (t.aiProvider) return t;
    if (t.useSmartProvider || (!t.aiProviderId && globalSmartPickEnabled)) {
      return { ...t, aiProvider: { name: "Smart pick", type: "smart", model: null } };
    }
    return { ...t, aiProvider: defaultProvider ?? null };
  });

  // Aggregate per-template instance success/failure counts (last 30 days)
  const instanceStats: Record<string, { completed: number; failed: number; total: number }> = {};
  for (const inst of recentInstances as { recurringTemplateId: string | null; status: string }[]) {
    if (!inst.recurringTemplateId) continue;
    const s = instanceStats[inst.recurringTemplateId] ?? { completed: 0, failed: 0, total: 0 };
    s.total += 1;
    if (inst.status === "completed" || inst.status === "no_changes") s.completed += 1;
    else if (inst.status === "failed" || inst.status === "killed" || inst.status === "timedout") s.failed += 1;
    instanceStats[inst.recurringTemplateId] = s;
  }

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Tasks</h1>
        <Link href="/tasks/new" className={buttonVariants()}>+ New Task</Link>
      </div>

      <WorkerStatus />

      <TasksPageView
        tasks={injectProvider(adHocTasks) as unknown as Task[]}
        scheduledTasks={injectProvider(scheduledTasks) as unknown as Task[]}
        webhookTasks={injectProvider(webhookTasks) as unknown as Task[]}
        recurringTemplates={recurringTemplates as unknown as Task[]}
        instanceStats={instanceStats}
      />
    </div>
  );
}
