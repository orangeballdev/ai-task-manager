import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

const fileSelect = {
  id: true,
  name: true,
  isFolder: true,
  mimeType: true,
  size: true,
  content: true,
  taskId: true,
  task: { select: { id: true, title: true } },
  parentId: true,
  protected: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const file = await prisma.file.findUnique({ where: { id }, select: fileSelect });
  if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(file);
}

// Walk up from `parentId` to ensure `id` is not among its ancestors (prevents moving a folder into itself).
async function isDescendant(id: string, parentId: string): Promise<boolean> {
  let current: string | null = parentId;
  while (current) {
    if (current === id) return true;
    const folder: { parentId: string | null } | null = await prisma.file.findUnique({
      where: { id: current },
      select: { parentId: true },
    });
    current = folder?.parentId ?? null;
  }
  return false;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json() as { name?: string; content?: string; parentId?: string | null; protected?: boolean };
  const { name, content, parentId } = body;
  const isProtected = body.protected;

  if (parentId !== undefined && parentId !== null) {
    if (parentId === id || await isDescendant(id, parentId)) {
      return NextResponse.json({ error: "Cannot move a folder into itself" }, { status: 400 });
    }
    const parent = await prisma.file.findUnique({ where: { id: parentId } });
    if (!parent || !parent.isFolder) {
      return NextResponse.json({ error: "Destination folder not found" }, { status: 404 });
    }
  }

  const current = await prisma.file.findUnique({ where: { id }, select: { name: true, parentId: true } });
  if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (name !== undefined || parentId !== undefined) {
    const finalName = name !== undefined ? name.trim() : current.name;
    const finalParentId = parentId !== undefined ? parentId : current.parentId;
    const clash = await prisma.file.findFirst({
      where: { id: { not: id }, parentId: finalParentId, name: finalName },
    });
    if (clash) {
      return NextResponse.json({ error: "An item with that name already exists here" }, { status: 409 });
    }
  }

  try {
    const file = await prisma.file.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(content !== undefined && { content }),
        ...(parentId !== undefined && { parentId }),
        ...(isProtected !== undefined && { protected: isProtected }),
      },
      select: fileSelect,
    });
    return NextResponse.json(file);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await prisma.file.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Failed to delete file" }, { status: 500 });
  }
}
