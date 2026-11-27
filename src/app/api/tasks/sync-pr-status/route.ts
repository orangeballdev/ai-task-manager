import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { syncTaskPRStatuses } from "@/lib/pr-sync";

export async function POST() {
  const result = await syncTaskPRStatuses(prisma);
  return NextResponse.json(result);
}
