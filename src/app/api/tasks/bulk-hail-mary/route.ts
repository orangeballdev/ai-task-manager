import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// PATCH /api/tasks/bulk-hail-mary — set/unset isHailMary on multiple recurring templates
export async function PATCH(req: NextRequest) {
  const body = await req.json() as { ids: string[]; isHailMary: boolean };
  const { ids, isHailMary } = body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "ids array is required" }, { status: 400 });
  }

  await prisma.task.updateMany({
    where: { id: { in: ids }, isRecurringTemplate: true },
    data: { isHailMary: Boolean(isHailMary) },
  });

  return NextResponse.json({ ok: true, updated: ids.length });
}

// POST /api/tasks/bulk-hail-mary/run — run all Hail Mary templates now
export async function POST() {
  const templates = await prisma.task.findMany({
    where: { isRecurringTemplate: true, isHailMary: true, isEnabled: true },
    include: { repos: true },
  });

  if (templates.length === 0) {
    return NextResponse.json({ ok: true, count: 0, taskIds: [] });
  }

  const maxPos = await prisma.task.aggregate({ _max: { position: true } });
  let pos = (maxPos._max.position ?? -1) + 1;

  const taskIds: string[] = [];
  for (const template of templates) {
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

  return NextResponse.json({ ok: true, count: taskIds.length, taskIds });
}
