import { NextRequest, NextResponse } from "next/server";
import { decideTeamApproval, type TeamApprovalDecision } from "@/lib/task-actions";

/**
 * Approve (or ask for a revision of) a team stage that is waiting for manual approval.
 * Body: `{ decision: "approve" | "revise", feedback?: string }` — feedback is optional
 * notes for the next member when approving, and required when asking for a revision.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { decision?: string; feedback?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const result = await decideTeamApproval(id, body.decision as TeamApprovalDecision, body.feedback ?? null);
  if (!result.ok) {
    return NextResponse.json({ error: result.code === "not_found" ? "Not found" : result.message }, { status: result.status });
  }
  return NextResponse.json({ ok: true, ...result.value });
}
