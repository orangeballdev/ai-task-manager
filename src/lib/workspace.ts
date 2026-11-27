import path from "path";
import fs from "fs/promises";

const WORKSPACES_ROOT = process.env.WORKSPACES_PATH ?? "/workspaces";

export function getWorkspacePath(taskId: string): string {
  return path.join(WORKSPACES_ROOT, taskId);
}

export function getRepoDest(taskId: string, alias: string): string {
  return path.join(WORKSPACES_ROOT, taskId, alias);
}

export async function ensureWorkspace(taskId: string): Promise<string> {
  const dir = getWorkspacePath(taskId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function cleanWorkspace(taskId: string): Promise<void> {
  const dir = getWorkspacePath(taskId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // ignore if already gone
  }
}

/**
 * Remove task workspaces without making the caller wait.
 *
 * A workspace holds full repo clones (often with node_modules, build output,
 * etc.), so `rm -rf` on it can take minutes on a slow disk. Deleting a task is
 * a DB operation as far as the user is concerned — the directory is just
 * garbage left behind — so the delete routes respond as soon as the row is
 * gone and let the disk cleanup finish on its own. Failures are logged, never
 * thrown (cleanWorkspace already swallows "already gone").
 */
export function cleanWorkspacesInBackground(taskIds: string[]): void {
  if (taskIds.length === 0) return;
  void Promise.all(taskIds.map((id) => cleanWorkspace(id))).catch((err) => {
    console.error("Background workspace cleanup failed:", err);
  });
}
