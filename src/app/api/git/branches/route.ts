import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { prisma } from "@/lib/db";
import fs from "fs/promises";
import os from "os";
import path from "path";

const execAsync = promisify(exec);

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url is required" }, { status: 400 });

  const settings = await prisma.setting.findMany({
    where: { key: { in: ["git_access_token", "git_ssh_key"] } },
  });
  const map = Object.fromEntries(settings.map((s: { key: string; value: string }) => [s.key, s.value]));

  let fetchUrl = url;
  const env = { ...process.env };
  let keyPath: string | null = null;

  if (url.startsWith("https://") && map.git_access_token) {
    try {
      const u = new URL(url);
      u.username = "oauth2";
      u.password = map.git_access_token;
      fetchUrl = u.toString();
    } catch { /* use original */ }
  }

  if (url.startsWith("git@")) {
    if (map.git_ssh_key) {
      keyPath = path.join(os.tmpdir(), `ctm-branches-ssh-${Date.now()}`);
      const normalized = map.git_ssh_key.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd() + "\n";
      await fs.writeFile(keyPath, normalized, { mode: 0o600 });
      env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o StrictHostKeyChecking=no`;
    } else {
      env.GIT_SSH_COMMAND = `ssh -o StrictHostKeyChecking=no`;
    }
  }

  try {
    const { stdout } = await execAsync(`git ls-remote --heads "${fetchUrl}"`, {
      timeout: 10000,
      env,
    });
    const branches = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\t")[1]?.replace("refs/heads/", ""))
      .filter(Boolean) as string[];
    return NextResponse.json({ branches });
  } catch {
    return NextResponse.json({ branches: [] });
  } finally {
    if (keyPath) await fs.unlink(keyPath).catch(() => {});
  }
}
