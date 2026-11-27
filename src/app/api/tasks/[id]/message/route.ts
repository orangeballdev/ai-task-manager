import { NextRequest, NextResponse } from "next/server";
import { sendTaskMessage } from "@/lib/task-actions";

// The task-detail chat box. See sendTaskMessage() in src/lib/task-actions.ts for what
// happens in each task state (shared with the MCP `send_task_message` tool).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { content } = await req.json() as { content: string };

  const result = await sendTaskMessage(id, content);
  if (!result.ok) {
    const error = result.code === "not_found" ? "not found" : result.message;
    return NextResponse.json({ error }, { status: result.status });
  }

  const outcome = result.value;
  if (outcome.mode === "sent") return NextResponse.json({ ok: true, id: outcome.messageId });
  if (outcome.mode === "queued") return NextResponse.json({ ok: true, queued: true });
  return NextResponse.json({ ok: true, requeued: true });
}
