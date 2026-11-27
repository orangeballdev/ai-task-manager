import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

// POST /api/files/upload?parentId=<id> — upload one or more files into a folder (root if omitted)
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const parentId = url.searchParams.get("parentId") || null;

  if (parentId) {
    const parent = await prisma.file.findUnique({ where: { id: parentId } });
    if (!parent || !parent.isFolder) {
      return NextResponse.json({ error: "Destination folder not found" }, { status: 404 });
    }
  }

  const formData = await req.formData();
  const files = formData.getAll("file") as File[];
  if (!files.length) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  const created = [];
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File ${file.name} exceeds 50 MB limit` },
        { status: 400 },
      );
    }

    let destName = file.name;
    let counter = 1;
    while (await prisma.file.findFirst({ where: { parentId, name: destName } })) {
      const dot = file.name.lastIndexOf(".");
      destName = dot === -1
        ? `${file.name} (${counter})`
        : `${file.name.slice(0, dot)} (${counter})${file.name.slice(dot)}`;
      counter++;
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const record = await prisma.file.create({
      data: {
        name: destName,
        parentId,
        blob: buffer,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
      },
      select: { id: true, name: true, size: true, mimeType: true },
    });
    created.push(record);
  }

  return NextResponse.json({ files: created });
}
