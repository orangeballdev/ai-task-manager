import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// GET /api/files/[id]/download
export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const file = await prisma.file.findUnique({ where: { id } });
  if (!file || file.isFolder) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  const body = file.blob ?? Buffer.from(file.content ?? "", "utf-8");
  const mimeType = file.mimeType ?? "text/markdown";

  return new NextResponse(body, {
    headers: {
      "Content-Type": mimeType,
      "Content-Disposition": `attachment; filename="${encodeURIComponent(file.name)}"`,
      "Content-Length": String(body.length),
    },
  });
}
