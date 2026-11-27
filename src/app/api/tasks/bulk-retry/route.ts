import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { revalidateThrottledProviders } from "@/lib/provider-throttle";

/**
 * POST /api/tasks/bulk-retry
 * Reset all failed/killed/timed-out tasks back to pending so the worker picks them up again.
 * Accepts an optional `statuses` array to limit which statuses are retried.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const statuses: string[] = Array.isArray(body.statuses)
    ? body.statuses
    : ["failed", "killed", "timedout"];

  const validStatuses = statuses.filter((s) =>
    ["failed", "killed", "timedout", "completed", "no_changes"].includes(s)
  );
  if (validStatuses.length === 0) {
    return NextResponse.json({ error: "No valid statuses provided" }, { status: 400 });
  }

  // Same reasoning as the single-task resume: don't send a batch of tasks at a provider whose
  // throttle nobody has re-checked since it was recorded.
  await revalidateThrottledProviders().catch(() => {});

  const result = await prisma.task.updateMany({
    where: {
      status: { in: validStatuses },
      isRecurringTemplate: false,
      // Review-only tickets never run (src/lib/review-only.ts).
      reviewOnly: false,
    },
    data: {
      status: "pending",
      retryCount: 0,
      nextRetryAt: null,
    },
  });

  return NextResponse.json({ ok: true, count: result.count });
}
