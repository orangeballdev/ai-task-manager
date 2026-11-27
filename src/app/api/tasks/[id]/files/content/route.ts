import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getWorkspacePath } from "@/lib/workspace";
import fs from "fs/promises";
import path from "path";

const MAX_FILE_SIZE = 2_000_000; // 2MB

// Extensions that are typically text/renderable
const TEXT_EXTENSIONS = new Set([
  "md", "mdx", "markdown", "slides", "txt", "text", "rst",
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift", "php",
  "c", "cpp", "h", "hpp", "cs", "scala", "clj",
  "html", "htm", "css", "scss", "sass", "less",
  "json", "yaml", "yml", "toml", "xml", "csv",
  "sh", "bash", "zsh", "fish", "ps1",
  "sql", "graphql", "gql", "prisma",
  "gitignore", "gitattributes", "editorconfig", "env",
  "dockerfile", "makefile", "rakefile",
  "lock", "log",
  "vue", "svelte", "astro",
  "ex", "exs", "erl", "hrl",
  "zig", "nim", "lua", "r",
]);

function isLikelyText(buffer: Buffer): boolean {
  // Check for null bytes (binary indicator)
  for (let i = 0; i < Math.min(buffer.length, 8000); i++) {
    if (buffer[i] === 0) return false;
  }
  return true;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const searchParams = req.nextUrl.searchParams;
  const filePath = searchParams.get("path") ?? "";

  if (!filePath) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  const task = await prisma.task.findUnique({ where: { id }, select: { id: true } });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const workspaceRoot = getWorkspacePath(id);
  const targetPath = path.resolve(workspaceRoot, filePath);

  // Security: ensure target is within workspace
  if (!targetPath.startsWith(workspaceRoot)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const stat = await fs.stat(targetPath);
    if (stat.isDirectory()) {
      return NextResponse.json({ error: "Path is a directory" }, { status: 400 });
    }

    if (stat.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "File too large to display", size: stat.size }, { status: 413 });
    }

    const ext = path.extname(targetPath).slice(1).toLowerCase();
    const buffer = await fs.readFile(targetPath);

    if (!isLikelyText(buffer) && !TEXT_EXTENSIONS.has(ext)) {
      return NextResponse.json({ error: "Binary file cannot be displayed", size: stat.size }, { status: 415 });
    }

    const content = buffer.toString("utf-8");
    return NextResponse.json({
      content,
      size: stat.size,
      ext,
      modifiedAt: stat.mtime.toISOString(),
    });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
