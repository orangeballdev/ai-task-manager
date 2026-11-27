import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function maskWebhook(webhook: { secretToken: string; [key: string]: unknown }) {
  return { ...webhook, secretToken: "***" };
}

export async function GET() {
  try {
    const webhooks = await prisma.webhook.findMany({ orderBy: { createdAt: "asc" } });
    return NextResponse.json(webhooks.map(maskWebhook));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, slug: rawSlug, secretToken, secretHeader, taskTitle, taskDescription, taskContext, repoUrl, repoAlias, isEnabled = true } = body;

    if (!name || !secretToken || !taskTitle || !taskDescription) {
      return NextResponse.json(
        { error: "name, secretToken, taskTitle, and taskDescription are required" },
        { status: 400 }
      );
    }

    const slug = rawSlug ? String(rawSlug).trim() : slugify(name);

    const existing = await prisma.webhook.findUnique({ where: { slug } });
    if (existing) {
      return NextResponse.json({ error: "A webhook with that slug already exists" }, { status: 409 });
    }

    const webhook = await prisma.webhook.create({
      data: {
        name,
        slug,
        secretToken,
        secretHeader: secretHeader ?? "X-Webhook-Secret",
        taskTitle,
        taskDescription,
        taskContext: taskContext ?? null,
        repoUrl: repoUrl ?? null,
        repoAlias: repoAlias ?? null,
        isEnabled,
      },
    });

    return NextResponse.json(maskWebhook(webhook), { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
