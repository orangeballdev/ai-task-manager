import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// PATCH /api/tasks/bulk-edit — update cron, provider, and/or model for multiple recurring templates
export async function PATCH(req: NextRequest) {
  const body = await req.json() as {
    ids: string[];
    cronExpression?: string | null;
    aiProviderId?: string | null;
    model?: string | null;
    isEnabled?: boolean;
  };

  const { ids, cronExpression, aiProviderId, model, isEnabled } = body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "ids array is required" }, { status: 400 });
  }

  // Build only the fields that were explicitly provided
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: Record<string, any> = {};
  if (cronExpression !== undefined) {
    data.cronExpression = cronExpression?.trim() || null;
  }
  if (aiProviderId !== undefined) {
    data.aiProviderId = aiProviderId || null;
  }
  if (model !== undefined) {
    data.model = model?.trim() || null;
  }
  if (isEnabled !== undefined) {
    data.isEnabled = Boolean(isEnabled);
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const result = await prisma.task.updateMany({
    where: { id: { in: ids }, isRecurringTemplate: true },
    data,
  });

  return NextResponse.json({ ok: true, updated: result.count });
}
