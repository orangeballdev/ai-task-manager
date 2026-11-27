import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runCleanup } from "@/lib/cleanup";

export async function POST() {
  const result = await runCleanup(prisma);
  return NextResponse.json(result);
}
