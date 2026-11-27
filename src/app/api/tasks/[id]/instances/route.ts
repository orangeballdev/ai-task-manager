import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const instances = await prisma.task.findMany({
    where: { recurringTemplateId: id },
    include: { repos: true },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json(instances);
}
