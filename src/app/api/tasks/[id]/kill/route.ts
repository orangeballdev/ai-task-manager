import { NextRequest, NextResponse } from "next/server";
import { killTask } from "@/lib/task-actions";

export async function POST(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await killTask(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.code === "not_found" ? "Not found" : result.message }, { status: result.status });
  }
  return NextResponse.json({ ok: true });
}
