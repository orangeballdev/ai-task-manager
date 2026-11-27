import { NextRequest, NextResponse } from "next/server";
import { authenticateApiRequest, apiError } from "@/lib/api-auth";
import { serializeTask } from "@/lib/api-v1";
import { startTask } from "@/lib/task-actions";

// Public API — start a task. Meant for tasks created with `autoStart: false` (which sit
// with isEnabled=false until explicitly started) but works on any non-running task: it
// re-queues it as "pending", enabled, and eligible for pick-up on the worker's next poll
// (every 5s), clearing anything that was holding it back (a schedule, a retry backoff).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiRequest(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const result = await startTask(id);
  if (!result.ok) return apiError(result.status, result.message, result.code);

  return NextResponse.json({ data: serializeTask(result.value) });
}
