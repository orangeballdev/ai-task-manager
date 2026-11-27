import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { resolveTemplate } from "@/lib/webhook-template";
import { gitFieldsForMode, resolveRepoBranch, resolveRepoDefaults } from "@/lib/repos";
import { existingTeamId } from "@/lib/teams";
import { normalizePriority } from "@/lib/priority";

async function logEvent(webhookId: string, status: string, taskId?: string, errorMessage?: string) {
  try {
    await prisma.webhookEvent.create({
      data: { webhookId, status, taskId: taskId ?? null, errorMessage: errorMessage ?? null },
    });
  } catch {
    // event logging must never prevent a response
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const webhook = await prisma.webhook.findUnique({ where: { slug } });
  if (!webhook || !webhook.isEnabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const secret = req.headers.get(webhook.secretHeader.toLowerCase());
  if (!secret || secret !== webhook.secretToken) {
    await logEvent(webhook.id, "unauthorized");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // non-JSON body allowed
  }

  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => { headers[key] = value; });
  const ctx = { body, headers };

  let task;
  try {
    const title = resolveTemplate(webhook.taskTitle, ctx);
    const description = resolveTemplate(webhook.taskDescription, ctx);
    const context = webhook.taskContext ? resolveTemplate(webhook.taskContext, ctx) : null;
    const repoUrl = webhook.repoUrl ? resolveTemplate(webhook.repoUrl, ctx) : null;
    const resolvedAlias = webhook.repoAlias ? resolveTemplate(webhook.repoAlias, ctx) : null;
    const repoAlias = resolvedAlias || (repoUrl ? (repoUrl.split("/").pop()?.replace(/\.git$/, "") || "repo") : "repo");

    const [providerSetting, modelSetting] = await Promise.all([
      prisma.setting.findUnique({ where: { key: "provider_mode" } }),
      prisma.setting.findUnique({ where: { key: "anthropic_model" } }),
    ]);
    const provider = providerSetting?.value ?? "cli";
    const model = modelSetting?.value || null;

    const maxPos = await prisma.task.aggregate({ _max: { position: true } });
    const position = (maxPos._max.position ?? -1) + 1;
    // Webhook-triggered tasks have no priority field to set on the webhook
    // config itself, so pick up the target repo's default priority (set on
    // the Repositories page) if one is configured.
    // Same for the repo's default branch and "after task completes" mode.
    const repoDefaults = await resolveRepoDefaults([repoUrl]);
    const priority = normalizePriority(repoDefaults.defaultPriority);
    const gitFields = repoDefaults.defaultGitMode
      ? gitFieldsForMode(repoDefaults.defaultGitMode, repoDefaults.defaultTargetBranch)
      : {};

    task = await prisma.task.create({
      data: {
        title,
        description,
        context,
        provider,
        model,
        position,
        priority,
        ...gitFields,
        teamId: await existingTeamId(repoDefaults.defaultTeamId),
        repos: repoUrl
          ? { create: [{ alias: repoAlias, url: repoUrl, branch: resolveRepoBranch(null, repoDefaults.defaultBranch) }] }
          : undefined,
      },
      include: { repos: true },
    });
  } catch (e) {
    await logEvent(webhook.id, "error", undefined, String(e));
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }

  await logEvent(webhook.id, "success", task.id);
  return NextResponse.json({ taskId: task.id }, { status: 201 });
}
