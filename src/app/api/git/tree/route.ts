import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { prisma } from "@/lib/db";
import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";

const execAsync = promisify(exec);

interface TreeEntry {
  name: string;
  type: "tree" | "blob";
}

/**
 * Returns the direct children (files + folders) of a given path in a remote git repo.
 * Used by the folder selector on the new-task form to let the user browse
 * the target repo without having to clone it locally.
 *
 * Query params:
 *   - url    (required) — git URL of the repo
 *   - branch (optional) — branch name; defaults to the remote HEAD
 *   - path   (optional) — folder path inside the repo; defaults to root
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  const requestedPath = (req.nextUrl.searchParams.get("path") ?? "").replace(/^\/+|\/+$/g, "");
  const branch = req.nextUrl.searchParams.get("branch") ?? undefined;

  if (!url) return NextResponse.json({ error: "url is required" }, { status: 400 });

  // Load git credentials so private repos work the same way as the branches route.
  const settings = await prisma.setting.findMany({
    where: { key: { in: ["git_access_token", "git_ssh_key"] } },
  });
  const map = Object.fromEntries(settings.map((s: { key: string; value: string }) => [s.key, s.value]));

  let fetchUrl = url;
  const env = { ...process.env };
  let keyPath: string | null = null;
  let tmpDir: string | null = null;

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
      keyPath = path.join(os.tmpdir(), `ctm-tree-ssh-${Date.now()}`);
      const normalized = map.git_ssh_key.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd() + "\n";
      await fs.writeFile(keyPath, normalized, { mode: 0o600 });
      env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o StrictHostKeyChecking=no`;
    } else {
      env.GIT_SSH_COMMAND = `ssh -o StrictHostKeyChecking=no`;
    }
  }

  try {
    // Shallow clone (treeless) into a temp dir so we can run ls-tree against the
    // requested path. We use `--filter=tree:0` so only the tree we walk is
    // downloaded — keeps things snappy for large repos.
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `ctm-tree-${crypto.randomBytes(4).toString("hex")}-`));

    const cloneArgs = [
      "clone",
      "--no-checkout",
      "--depth=1",
      "--filter=tree:0",
    ];
    if (branch) cloneArgs.push("--branch", branch);
    cloneArgs.push(`"${fetchUrl}"`, tmpDir);

    await execAsync(`git ${cloneArgs.join(" ")}`, { timeout: 15000, env });

    const ref = branch ? branch : "HEAD";
    const treeRef = requestedPath ? `${ref}:${requestedPath}` : ref;

    const { stdout } = await execAsync(
      `git -C "${tmpDir}" ls-tree --name-only -- "${treeRef}" 2>/dev/null || true`,
      { timeout: 10000, env },
    );

    // ls-tree --name-only with no extra args lists names but not types.
    // Re-run with -l to get the type column. Use raw form below.
    const { stdout: rawOut } = await execAsync(
      `git -C "${tmpDir}" ls-tree -- "${treeRef}"`,
      { timeout: 10000, env },
    );

    // Each line: <mode> SP <type> SP <object> TAB <name>
    const entries: TreeEntry[] = rawOut
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const tabIdx = line.indexOf("\t");
        if (tabIdx === -1) return null;
        const meta = line.slice(0, tabIdx).split(" ");
        const name = line.slice(tabIdx + 1);
        const type = meta[1] as "tree" | "blob" | string;
        if (type !== "tree" && type !== "blob") return null;
        return { name, type } as TreeEntry;
      })
      .filter((e): e is TreeEntry => e !== null);

    // Avoid an unused-var lint warning when ls-tree --name-only succeeded but we
    // prefer the typed output above. Keeping the call defends against shells
    // that strip the `|| true` pipe — if rawOut is empty we still have stdout
    // as a sanity check.
    if (entries.length === 0 && stdout.trim()) {
      const names = stdout.split("\n").filter(Boolean).map((n) => ({ name: n, type: "blob" as const }));
      return NextResponse.json({ entries: names });
    }

    // Sort: folders first, then files, both alphabetical
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "tree" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({ entries });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ entries: [], error: msg }, { status: 200 });
  } finally {
    if (keyPath) await fs.unlink(keyPath).catch(() => {});
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
