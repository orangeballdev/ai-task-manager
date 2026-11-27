import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { authenticateApiRequest, apiError } from "@/lib/api-auth";
import { readWorkspaceFile, MAX_API_FILE_SIZE } from "@/lib/api-v1-files";

// Public API — read one text file out of a task's workspace, e.g.
// GET /api/v1/tasks/{id}/files/content?path=output/findings.json
//
// This is how a caller that created a file-output task collects the result: poll
// GET /api/v1/tasks/{id} until status is terminal, then read the file it was asked to write.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateApiRequest(req);
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const task = await prisma.task.findUnique({ where: { id }, select: { id: true } });
  if (!task) return apiError(404, `No task found with id '${id}'.`, "not_found");

  const { searchParams } = new URL(req.url);
  const relPath = searchParams.get("path");
  if (!relPath) return apiError(400, "'path' query parameter is required.", "invalid_request");

  const result = await readWorkspaceFile(id, relPath);
  if (!result.ok) {
    switch (result.reason) {
      case "is_directory":
        return apiError(400, `'${relPath}' is a directory. Use GET /api/v1/tasks/{id}/files to list it.`, "invalid_request");
      case "too_large":
        return apiError(413, `File is ${result.size} bytes; the API returns at most ${MAX_API_FILE_SIZE}.`, "file_too_large");
      case "binary":
        return apiError(415, "File is not text and cannot be returned as JSON.", "unsupported_file");
      default:
        return apiError(404, `No file '${relPath}' in this task's workspace.`, "not_found");
    }
  }

  return NextResponse.json({
    data: {
      path: relPath,
      content: result.content,
      size: result.size,
      modifiedAt: result.modifiedAt,
    },
  });
}
