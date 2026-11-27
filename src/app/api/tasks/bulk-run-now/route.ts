import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// POST /api/tasks/bulk-run-now — trigger N instances of each selected recurring template
export async function POST(req: NextRequest) {
  const body = await req.json() as { ids: string[]; count?: number };
  const { ids, count = 1 } = body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "ids array is required" }, { status: 400 });
  }

  const runCount = Math.max(1, Math.min(Math.floor(count), 50)); // clamp 1–50

  const templates = await prisma.task.findMany({
    where: { id: { in: ids }, isRecurringTemplate: true },
    include: { repos: true },
  });

  const maxPos = await prisma.task.aggregate({ _max: { position: true } });
  let pos = (maxPos._max.position ?? -1) + 1;

  const taskIds: string[] = [];
  for (const template of templates) {
    for (let i = 0; i < runCount; i++) {
      const instance = await prisma.task.create({
        data: {
          title: template.title,
          description: template.description,
          context: template.context,
          provider: template.provider,
          model: template.model,
          pushToMain: template.pushToMain,
          targetBranch: template.targetBranch,
          createPR: template.createPR,
          position: pos++,
          priority: template.priority,
          effort: template.effort,
          toolAccess: template.toolAccess ?? null,
          allowSubtasks: Boolean(template.allowSubtasks),
          recurringTemplateId: template.id,
          aiProviderId: template.aiProviderId,
          repos: {
            create: template.repos.map((r: { alias: string; url: string; branch?: string | null }) => ({
              alias: r.alias,
              url: r.url,
              branch: r.branch || null,
            })),
          },
        },
      });
      taskIds.push(instance.id);
    }
  }

  return NextResponse.json({ ok: true, count: taskIds.length, taskIds });
}
