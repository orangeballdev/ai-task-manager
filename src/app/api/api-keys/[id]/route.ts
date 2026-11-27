import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { API_KEY_SELECT, readProviderChoice } from "@/lib/api-key-provider-input";

/** Changes which provider the LLM gateway uses for this key (`{ provider: id | "smart" | "" }`). */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (!("provider" in body)) {
    return NextResponse.json({ error: "provider is required" }, { status: 400 });
  }
  const choice = await readProviderChoice(body.provider);
  if (choice instanceof NextResponse) return choice;
  try {
    const record = await prisma.apiKey.update({ where: { id }, data: choice, select: API_KEY_SELECT });
    return NextResponse.json(record);
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await prisma.apiKey.delete({ where: { id } });
    return new NextResponse(null, { status: 204 });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
