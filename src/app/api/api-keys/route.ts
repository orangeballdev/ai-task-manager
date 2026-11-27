import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateApiKey } from "@/lib/api-keys";
import { API_KEY_SELECT, readProviderChoice } from "@/lib/api-key-provider-input";

// Internal (UI-only, unauthenticated like the rest of src/app/api/*) CRUD for managing
// public API credentials from Settings -> API. The credentials these create are what
// authenticates requests to the actual public API under /api/v1/* — see src/lib/api-auth.ts —
// and to the LLM gateway under /api/llm/v1/*, which runs on the key's chosen provider.
export async function GET() {
  const keys = await prisma.apiKey.findMany({
    orderBy: { createdAt: "desc" },
    select: API_KEY_SELECT,
  });
  return NextResponse.json(keys);
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  const choice = await readProviderChoice(body.provider);
  if (choice instanceof NextResponse) return choice;

  const { key, keyHash, keyPrefix } = generateApiKey();
  const record = await prisma.apiKey.create({
    data: { name, keyHash, keyPrefix, ...choice },
    select: API_KEY_SELECT,
  });

  // The plaintext key is returned exactly once — the caller (Settings -> API) must show
  // it to the user now and never again; only keyHash is stored.
  return NextResponse.json({ ...record, key }, { status: 201 });
}
