import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { prisma } from "@/lib/db";
import fs from "fs/promises";
import os from "os";
import path from "path";

const execAsync = promisify(exec);

export async function POST(req: NextRequest) {
  const { url } = await req.json() as { url: string };
  if (!url) return NextResponse.json({ ok: false, output: "URL is required" }, { status: 400 });

  // Load git credentials from settings
  const settings = await prisma.setting.findMany({
    where: { key: { in: ["git_access_token", "git_ssh_key"] } },
  });
  const map = Object.fromEntries(settings.map((s: { key: string; value: string }) => [s.key, s.value]));

  let testUrl = url;
  const env = { ...process.env };
  let keyPath: string | null = null;

  // Inject token for HTTPS URLs
  if (url.startsWith("https://") && map.git_access_token) {
    try {
      const u = new URL(url);
      u.username = "oauth2";
      u.password = map.git_access_token;
      testUrl = u.toString();
    } catch { /* use original URL */ }
  }

  // Write SSH key for git@ URLs
  if (url.startsWith("git@")) {
    if (map.git_ssh_key) {
      keyPath = path.join(os.tmpdir(), `ctm-test-ssh-${Date.now()}`);
      const normalized = map.git_ssh_key.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd() + "\n";
      await fs.writeFile(keyPath, normalized, { mode: 0o600 });
      env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o StrictHostKeyChecking=no`;
    } else {
      env.GIT_SSH_COMMAND = `ssh -o StrictHostKeyChecking=no`;
    }
  }

  try {
    const { stdout, stderr } = await execAsync(`git ls-remote --heads "${testUrl}"`, {
      timeout: 10000,
      env,
    });
    return NextResponse.json({ ok: true, output: (stdout + stderr).trim() || "Connection successful" });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, output: msg });
  } finally {
    if (keyPath) await fs.unlink(keyPath).catch(() => {});
  }
}
