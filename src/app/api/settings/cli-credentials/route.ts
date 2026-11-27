import { NextRequest } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export async function POST(req: NextRequest) {
  const body = await req.json() as { credentials: string };
  const raw = body.credentials?.trim();

  if (!raw) {
    return Response.json({ ok: false, error: "No credentials provided" }, { status: 400 });
  }

  // Validate it's parseable JSON before writing
  try {
    JSON.parse(raw);
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const dir = join(homedir(), ".claude");
  const file = join(dir, ".credentials.json");

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, raw, { encoding: "utf8", mode: 0o600 });
    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

export async function GET() {
  const { readFile } = await import("fs/promises");
  const file = join(homedir(), ".claude", ".credentials.json");
  try {
    await readFile(file, "utf8");
    return Response.json({ exists: true });
  } catch {
    return Response.json({ exists: false });
  }
}
