import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { getAttachmentsDir } from "@/lib/attachments";

// Only inline this many characters of any single text file so a folder full of
// large documents can't blow past the model's context window.
const MAX_TEXT_CHARS_PER_FILE = 20_000;

interface SeedAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
}

// Turn a folder name into a workspace-safe sub-directory name so the attached
// images land grouped together (e.g. "Design Mockups" -> "design-mockups").
function slugifyFolder(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "folder-files";
}

// GET /api/files/[id]/task-seed
// Builds everything needed to seed a new task from a Files folder: a context
// string listing (and inlining, for text files) the folder's contents, plus a
// set of task attachments materialized from any image files so the agent can
// actually see the mockups once they're copied into its workspace.
export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ATTACHMENTS_DIR = getAttachmentsDir();
  const { id } = await params;

  const folder = await prisma.file.findUnique({
    where: { id },
    select: { id: true, name: true, isFolder: true },
  });
  if (!folder) {
    return NextResponse.json({ error: "Folder not found" }, { status: 404 });
  }
  if (!folder.isFolder) {
    return NextResponse.json({ error: "Not a folder" }, { status: 400 });
  }

  // Direct file children only — a flat folder of mockups is the target use case.
  const children = await prisma.file.findMany({
    where: { parentId: id, isFolder: false },
    orderBy: { name: "asc" },
    select: { id: true, name: true, content: true, blob: true, mimeType: true, size: true },
  });

  if (children.length === 0) {
    return NextResponse.json({ error: "Folder has no files" }, { status: 400 });
  }

  const attachmentsFolder = slugifyFolder(folder.name);
  const attachments: SeedAttachment[] = [];
  const imageNames: string[] = [];
  const otherNames: string[] = [];
  const textSections: string[] = [];

  if (!fs.existsSync(ATTACHMENTS_DIR)) {
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  }

  for (const file of children) {
    const mimeType = file.mimeType ?? "";
    const isImage = mimeType.startsWith("image/") && file.blob != null;

    if (isImage && file.blob) {
      // Materialize the image into the shared attachments directory so the
      // existing attachment-copy logic (see providers/cli.ts) can drop it into
      // the task workspace at run time.
      const ext = file.name.includes(".") ? file.name.split(".").pop() ?? "bin" : "bin";
      const attId = randomUUID();
      const diskPath = path.join(ATTACHMENTS_DIR, `${attId}.${ext}`);
      try {
        fs.writeFileSync(diskPath, Buffer.from(file.blob));
        attachments.push({
          id: attId,
          name: file.name,
          path: diskPath,
          mimeType: mimeType || "application/octet-stream",
          size: file.size ?? Buffer.from(file.blob).length,
        });
        imageNames.push(file.name);
      } catch {
        // If we can't write it, fall back to just listing it by name.
        otherNames.push(file.name);
      }
    } else if (file.content != null) {
      // Text file — inline its contents (truncated) as context.
      const raw = file.content;
      const truncated = raw.length > MAX_TEXT_CHARS_PER_FILE
        ? `${raw.slice(0, MAX_TEXT_CHARS_PER_FILE)}\n\n… (truncated)`
        : raw;
      textSections.push(`#### ${file.name}\n\`\`\`\n${truncated}\n\`\`\``);
    } else {
      otherNames.push(file.name);
    }
  }

  // Assemble a human-readable context block describing the folder.
  const lines: string[] = [];
  lines.push(`This task was created from the "${folder.name}" folder in Files.`);
  lines.push("");
  lines.push("### Folder contents");
  for (const name of imageNames) lines.push(`- ${name} (image — attached below)`);
  for (const s of textSections) {
    const name = s.split("\n")[0]?.replace(/^#### /, "") ?? "";
    lines.push(`- ${name} (text — contents included below)`);
  }
  for (const name of otherNames) lines.push(`- ${name}`);

  if (textSections.length > 0) {
    lines.push("");
    lines.push("### File contents");
    lines.push(textSections.join("\n\n"));
  }

  return NextResponse.json({
    folderId: folder.id,
    folderName: folder.name,
    context: lines.join("\n"),
    attachments,
    attachmentsFolder,
    fileCount: children.length,
  });
}
