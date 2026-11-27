// Shared workspace-file access for the public API (src/app/api/v1/tasks/[id]/files/*).
//
// File-output tasks write their results into the workspace `output/` directory, so an API
// consumer that kicks off a task needs a way to read those files back. These helpers are
// the only place the public API touches the filesystem; both routes go through
// resolveWorkspacePath so a caller can never escape the task's own workspace.
import fs from "fs/promises";
import path from "path";
import { getWorkspacePath } from "@/lib/workspace";

/** Refuse anything larger than this rather than streaming megabytes through a JSON body. */
export const MAX_API_FILE_SIZE = 5_000_000; // 5MB

export interface WorkspaceEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modifiedAt?: string;
}

/**
 * Resolve `relPath` inside a task's workspace, or return null when it escapes.
 *
 * The separator check matters: a plain `startsWith(root)` would accept `/ws/12-evil`
 * for a workspace at `/ws/12`, so the resolved path must either be the root itself or
 * sit beneath `root + sep`.
 */
export function resolveWorkspacePath(taskId: string, relPath: string): string | null {
  const root = path.resolve(getWorkspacePath(taskId));
  const target = path.resolve(root, relPath);
  if (!isWithin(root, target)) return null;
  return target;
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/**
 * Like resolveWorkspacePath, but also follows symlinks. The lexical check alone lets an
 * agent-written `output/x -> /etc/passwd` through, so the real path of the target must
 * still sit inside the real path of the workspace. Returns null when it escapes or does
 * not exist.
 */
export async function resolveRealWorkspacePath(taskId: string, relPath: string): Promise<string | null> {
  const target = resolveWorkspacePath(taskId, relPath);
  if (!target) return null;
  try {
    const realRoot = await fs.realpath(getWorkspacePath(taskId));
    const realTarget = await fs.realpath(target);
    return isWithin(realRoot, realTarget) ? realTarget : null;
  } catch {
    return null;
  }
}

function isLikelyText(buffer: Buffer): boolean {
  // A null byte in the first few KB is the cheapest reliable binary signal.
  for (let i = 0; i < Math.min(buffer.length, 8000); i++) {
    if (buffer[i] === 0) return false;
  }
  return true;
}

export type ReadResult =
  | { ok: true; content: string; size: number; modifiedAt: string }
  | { ok: false; reason: "not_found" | "is_directory" | "too_large" | "binary"; size?: number };

export async function readWorkspaceFile(taskId: string, relPath: string): Promise<ReadResult> {
  const target = await resolveRealWorkspacePath(taskId, relPath);
  if (!target) return { ok: false, reason: "not_found" };

  let stat;
  try {
    stat = await fs.stat(target);
  } catch {
    return { ok: false, reason: "not_found" };
  }

  if (stat.isDirectory()) return { ok: false, reason: "is_directory" };
  if (stat.size > MAX_API_FILE_SIZE) return { ok: false, reason: "too_large", size: stat.size };

  const buffer = await fs.readFile(target);
  if (!isLikelyText(buffer)) return { ok: false, reason: "binary", size: stat.size };

  return {
    ok: true,
    content: buffer.toString("utf-8"),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

/**
 * List a directory inside the workspace. `recursive` walks the whole tree, which is what
 * an API consumer usually wants when it is looking for one known output file and does not
 * want to make a request per directory level.
 */
export async function listWorkspaceFiles(
  taskId: string,
  relPath: string,
  recursive = false,
): Promise<WorkspaceEntry[] | null> {
  const root = path.resolve(getWorkspacePath(taskId));
  const target = await resolveRealWorkspacePath(taskId, relPath);
  if (!target) return null;
  // Report paths relative to the real root, since `target` has had symlinks resolved.
  const realRoot = await fs.realpath(root);

  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }

  const out: WorkspaceEntry[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Skip VCS and dependency noise — nothing an API consumer asked for lives there.
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(realRoot, full);
      try {
        // lstat, not stat: a symlink pointing outside the workspace must not leak the
        // size/mtime of its target. Reading it is refused by resolveRealWorkspacePath.
        const entryStat = await fs.lstat(full);
        out.push({
          name: entry.name,
          path: rel,
          type: entry.isDirectory() ? "directory" : "file",
          size: entry.isFile() ? entryStat.size : undefined,
          modifiedAt: entryStat.mtime.toISOString(),
        });
        // Bounded depth so a symlink loop or a deep tree cannot hang the request.
        if (recursive && entry.isDirectory() && depth < 8) await walk(full, depth + 1);
      } catch {
        // Vanished between readdir and stat — skip it.
      }
    }
  }

  await walk(target, 0);
  return out;
}
