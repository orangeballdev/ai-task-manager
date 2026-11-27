import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { getAttachmentsDir } from "@/lib/attachments";

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export async function POST(req: NextRequest) {
  const ATTACHMENTS_DIR = getAttachmentsDir();
  try {
    const formData = await req.formData();
    const files = formData.getAll("file") as File[];

    if (!files.length) {
      return NextResponse.json({ error: "No files provided" }, { status: 400 });
    }

    if (!fs.existsSync(ATTACHMENTS_DIR)) {
      fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    }

    const results: { id: string; name: string; path: string; mimeType: string; size: number }[] = [];

    for (const file of files) {
      if (!ALLOWED_MIME_TYPES.has(file.type)) {
        return NextResponse.json(
          { error: `File type ${file.type} is not allowed. Only images are supported.` },
          { status: 400 },
        );
      }

      if (file.size > MAX_FILE_SIZE) {
        return NextResponse.json(
          { error: `File ${file.name} exceeds 10 MB limit` },
          { status: 400 },
        );
      }

      const ext = file.name.split(".").pop() ?? "bin";
      const id = randomUUID();
      const filename = `${id}.${ext}`;
      const filePath = path.join(ATTACHMENTS_DIR, filename);

      const buffer = Buffer.from(await file.arrayBuffer());
      fs.writeFileSync(filePath, buffer);

      results.push({
        id,
        name: file.name,
        path: filePath,
        mimeType: file.type,
        size: file.size,
      });
    }

    return NextResponse.json({ attachments: results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const ATTACHMENTS_DIR = getAttachmentsDir();
  try {
    const { filePath } = await req.json() as { filePath: string };
    // Security: only allow deleting from the attachments directory
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(ATTACHMENTS_DIR + path.sep)) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }
    if (fs.existsSync(resolved)) {
      fs.unlinkSync(resolved);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
