import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { getAttachmentsDir } from "@/lib/attachments";

export async function GET(_: NextRequest, { params }: { params: Promise<{ filename: string }> }) {
  const ATTACHMENTS_DIR = getAttachmentsDir();
  const { filename } = await params;

  // Security: prevent path traversal
  const filePath = path.join(ATTACHMENTS_DIR, path.basename(filename));
  if (!filePath.startsWith(ATTACHMENTS_DIR)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ext = path.extname(filename).toLowerCase().slice(1);
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
  };
  const contentType = mimeMap[ext] ?? "application/octet-stream";

  const buffer = fs.readFileSync(filePath);
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
