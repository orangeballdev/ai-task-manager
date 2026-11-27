import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApiRequest, apiError } from "@/lib/api-auth";
import { listWorkspaceFiles } from "@/lib/api-v1-files";

// Public API — list the files a task produced in its workspace.
//
// `?path=` selects a subdirectory (default `output`, where file-output tasks write their
// results); `?recursive=true` walks the tree so a caller looking for one known output file
// does not need a request per directory level. Read a file's contents with
// GET /api/v1/tasks/{id}/files/content?path=...
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiRequest(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const task = await prisma.task.findUnique({ where: { id }, select: { id: true } });
  if (!task) return apiError(404, `No task found with id '${id}'.`, "not_found");

  const { searchParams } = new URL(req.url);
  const relPath = searchParams.get("path") ?? "output";
  const recursive = searchParams.get("recursive") === "true";

  const entries = await listWorkspaceFiles(id, relPath, recursive);
  if (entries === null) {
    return apiError(404, `No directory '${relPath}' in this task's workspace.`, "not_found");
  }

  return NextResponse.json({ data: { path: relPath, entries } });
}
