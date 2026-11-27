import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

function maskWebhook(webhook: { secretToken: string; [key: string]: unknown }) {
  return { ...webhook, secretToken: "***" };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const webhook = await prisma.webhook.findUnique({ where: { id } });
    if (!webhook) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(maskWebhook(webhook));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { name, slug, secretToken, secretHeader, taskTitle, taskDescription, taskContext, repoUrl, repoAlias, isEnabled } = body;

    const existing = await prisma.webhook.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (slug && slug !== existing.slug) {
      const conflict = await prisma.webhook.findUnique({ where: { slug } });
      if (conflict) return NextResponse.json({ error: "A webhook with that slug already exists" }, { status: 409 });
    }

    const updated = await prisma.webhook.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(slug !== undefined && { slug }),
        ...(secretToken !== undefined && { secretToken }),
        ...(secretHeader !== undefined && { secretHeader }),
        ...(taskTitle !== undefined && { taskTitle }),
        ...(taskDescription !== undefined && { taskDescription }),
        ...(taskContext !== undefined && { taskContext }),
        ...(repoUrl !== undefined && { repoUrl }),
        ...(repoAlias !== undefined && { repoAlias }),
        ...(isEnabled !== undefined && { isEnabled }),
      },
    });

    return NextResponse.json(maskWebhook(updated));
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const existing = await prisma.webhook.findUnique({ where: { id } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await prisma.webhook.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
