import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const template = await prisma.task.findUnique({
    where: { id, isRecurringTemplate: true },
    include: { repos: true },
  });

  if (!template) {
    return NextResponse.json({ error: "Recurring template not found" }, { status: 404 });
  }

  // Support running multiple instances: ?count=N or body { count: N }
  let count = 1;
  try {
    const body = await req.json().catch(() => ({})) as { count?: number };
    if (body.count && typeof body.count === "number" && body.count > 0) {
      count = Math.min(Math.floor(body.count), 50); // cap at 50
    }
  } catch { /* no body is fine */ }

  const maxPos = await prisma.task.aggregate({ _max: { position: true } });
  let pos = (maxPos._max.position ?? -1) + 1;

  const instances: { id: string }[] = [];
  for (let i = 0; i < count; i++) {
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
        toolAccess: template.toolAccess ?? null,
        allowSubtasks: Boolean(template.allowSubtasks),
        recurringTemplateId: template.id,
        aiProviderId: template.aiProviderId,
        repos: { create: template.repos.map((r: { alias: string; url: string; branch?: string | null }) => ({ alias: r.alias, url: r.url, branch: r.branch || null })) },
      },
    });
    instances.push({ id: instance.id });
  }

  return NextResponse.json({ ok: true, count: instances.length, taskIds: instances.map((i) => i.id) });
}
