// Where task image attachments (pasted / dropped / "Attach Images" screenshots)
// live on disk, and how the worker gets them into a task's workspace.
//
// The upload route runs in the Next.js app, but the files are read by the worker,
// which in the Docker setup is a *different container*. The directory must therefore
// be on storage both processes share: `ATTACHMENTS_PATH` (docker-compose points it at
// the shared `/data` volume), falling back to `<cwd>/data/attachments` for a local
// `npm run dev` + `npm run worker`, where both processes share the checkout.
//
// This used to be hard-coded to `<cwd>/data/attachments`, which in Docker is inside
// the app container's own filesystem: the upload "succeeded", the prompt told the
// agent the screenshot had been copied into its workspace, and the worker silently
// skipped the copy because the file didn't exist on its side.

import fs from "fs";
import path from "path";

export function getAttachmentsDir(): string {
  const configured = process.env.ATTACHMENTS_PATH?.trim();
  return path.resolve(configured || path.join(process.cwd(), "data/attachments"));
}

export interface StoredAttachment {
  name: string;
  path: string;
}

/**
 * The on-disk location of a stored attachment, or null when it can't be found.
 * Tries the recorded path first, then the same file name in the current
 * attachments directory — the recorded path is absolute and was written by
 * whichever process handled the upload, so it may not be valid in this one.
 */
export function resolveAttachmentPath(att: Pick<StoredAttachment, "path">, dir: string = getAttachmentsDir()): string | null {
  if (att.path && fs.existsSync(att.path)) return att.path;
  const base = path.basename(att.path ?? "");
  if (!base) return null;
  const candidate = path.join(dir, base);
  return fs.existsSync(candidate) ? candidate : null;
}

export interface CopyAttachmentsResult {
  /** Workspace-relative paths of the files that were copied. */
  copied: string[];
  /** Attachments that couldn't be found or copied, with the reason. */
  missing: { name: string; reason: string }[];
  /** The directory the files were copied into. */
  targetDir: string;
}

/**
 * Copies a task's attachments into its workspace (the root, or `folder` under it)
 * so the agent can open them. Never throws — anything that can't be copied is
 * reported in `missing` so the caller can log it instead of failing silently.
 */
export function copyAttachmentsToWorkspace(
  attachments: StoredAttachment[],
  workspace: string,
  folder?: string | null,
  dir: string = getAttachmentsDir(),
): CopyAttachmentsResult {
  const cleanFolder = (folder ?? "").trim().replace(/^\/+|\/+$/g, "");
  const root = path.resolve(workspace);
  const wanted = cleanFolder ? path.resolve(root, cleanFolder) : root;
  // Guard against path traversal — must stay inside the workspace.
  const targetDir = wanted === root || wanted.startsWith(root + path.sep) ? wanted : root;

  const result: CopyAttachmentsResult = { copied: [], missing: [], targetDir };
  for (const att of attachments) {
    const name = path.basename(att.name || att.path || "");
    if (!name) {
      result.missing.push({ name: att.name || "(unnamed)", reason: "attachment has no file name" });
      continue;
    }
    const source = resolveAttachmentPath(att, dir);
    if (!source) {
      result.missing.push({ name, reason: `file not found (looked for ${att.path} and in ${dir})` });
      continue;
    }
    try {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(source, path.join(targetDir, name));
      result.copied.push(path.relative(root, path.join(targetDir, name)) || name);
    } catch (err) {
      result.missing.push({ name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
