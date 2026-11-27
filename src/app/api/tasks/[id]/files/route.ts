import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getWorkspacePath } from "@/lib/workspace";
import fs from "fs/promises";
import path from "path";

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  ext?: string;
  modifiedAt?: string;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const searchParams = req.nextUrl.searchParams;
  const reqPath = searchParams.get("path") ?? "";

  const task = await prisma.task.findUnique({ where: { id }, select: { id: true } });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const workspaceRoot = getWorkspacePath(id);
  const targetPath = reqPath
    ? path.resolve(workspaceRoot, reqPath)
    : workspaceRoot;

  // Security: ensure target is within workspace
  if (!targetPath.startsWith(workspaceRoot)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const stat = await fs.stat(targetPath);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }

    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    const result = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(targetPath, entry.name);
        const relPath = path.relative(workspaceRoot, fullPath);
        try {
          const entryStat = await fs.stat(fullPath);
          return {
            name: entry.name,
            path: relPath,
            type: (entry.isDirectory() ? "directory" : "file") as "file" | "directory",
            size: entry.isFile() ? entryStat.size : undefined,
            ext: entry.isFile() ? path.extname(entry.name).slice(1).toLowerCase() : undefined,
            modifiedAt: entryStat.mtime.toISOString(),
          } satisfies FileEntry;
        } catch {
          return null;
        }
      })
    );

    const filtered = (result.filter(Boolean) as FileEntry[]).sort((a, b) => {
      // Directories first, then files
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      // Hidden files last within each group
      const aHidden = a.name.startsWith(".");
      const bHidden = b.name.startsWith(".");
      if (aHidden !== bHidden) return aHidden ? 1 : -1;
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({ entries: filtered, path: reqPath });
  } catch {
    return NextResponse.json({ error: "Path not found or workspace does not exist" }, { status: 404 });
  }
}
