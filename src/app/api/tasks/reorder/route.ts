import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest) {
  const { ids }: { ids: string[] } = await req.json();

  await Promise.all(
    ids.map((id, index) =>
      prisma.task.update({ where: { id }, data: { position: index } })
    )
  );

  return NextResponse.json({ ok: true });
}
