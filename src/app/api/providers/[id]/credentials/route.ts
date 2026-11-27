import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { readFile } from "fs/promises";
import { join } from "path";
import { cliCredentialsFileName, resolveCliConfigDir, saveProviderCredentials } from "@/lib/providers/save-credentials";

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const provider = await prisma.aIProvider.findUnique({ where: { id } });
  if (!provider || (provider.type !== "cli" && provider.type !== "codex-cli")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const dir = resolveCliConfigDir(provider.configDir, provider.type);

  // Prefer DB-stored credentials, fall back to reading from disk
  if (provider.credentialsJson) {
    return NextResponse.json({ exists: true, configDir: dir, content: provider.credentialsJson });
  }

  const file = join(dir, cliCredentialsFileName(provider.type));
  try {
    const content = await readFile(file, "utf8");
    return NextResponse.json({ exists: true, configDir: dir, content });
  } catch {
    return NextResponse.json({ exists: false, configDir: dir, content: null });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const provider = await prisma.aIProvider.findUnique({ where: { id } });
  if (!provider || (provider.type !== "cli" && provider.type !== "codex-cli")) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json() as { credentials: string };
  const raw = body.credentials?.trim();
  if (!raw) return NextResponse.json({ ok: false, error: "No credentials provided" }, { status: 400 });

  try {
    JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { warning } = await saveProviderCredentials(provider, raw);
  return NextResponse.json(warning ? { ok: true, warning } : { ok: true });
}
