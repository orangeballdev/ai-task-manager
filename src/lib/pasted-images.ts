// Helpers for pasting / dropping screenshots straight into the task
// description field. Kept free of DOM globals (beyond the structural types
// below) so it can be unit-tested under node.

/** Image types the attachments API (`POST /api/tasks/attachments`) accepts. */
export const ATTACHABLE_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** Minimal shape of a clipboard / drag `DataTransfer` that we rely on. */
export interface DataTransferLike {
  files?: ArrayLike<FileLike> | null;
  items?: ArrayLike<{ kind: string; type: string; getAsFile(): FileLike | null }> | null;
  getData?(format: string): string;
}

export interface FileLike {
  name: string;
  type: string;
}

/**
 * Pulls the attachable images out of a paste/drop payload. Returns an empty
 * array when there's nothing to upload, so callers can fall through to the
 * browser's default handling (i.e. a normal text paste).
 *
 * When the clipboard also carries plain text — e.g. a copy from a word
 * processor, which often bundles a rendered image of the selection — the text
 * is what the user meant, so we don't hijack the paste.
 */
export function extractImageFiles<F extends FileLike>(data: DataTransferLike | null | undefined, opts: { ignoreWhenText?: boolean } = {}): F[] {
  if (!data) return [];
  if (opts.ignoreWhenText !== false) {
    const text = data.getData?.("text/plain") ?? "";
    if (text.trim()) return [];
  }
  const out: F[] = [];
  const files = data.files ? Array.from(data.files) : [];
  for (const f of files) {
    if (ATTACHABLE_IMAGE_TYPES.has(f.type)) out.push(f as F);
  }
  if (out.length > 0) return out;
  // Some browsers only expose pasted images through `items`.
  const items = data.items ? Array.from(data.items) : [];
  for (const item of items) {
    if (item.kind !== "file" || !ATTACHABLE_IMAGE_TYPES.has(item.type)) continue;
    const f = item.getAsFile();
    if (f) out.push(f as F);
  }
  return out;
}

/**
 * Clipboard screenshots arrive with a generic name ("image.png"), so every
 * paste would look identical in the attachment list. Give those a
 * timestamped name; real file names (from a drag-and-drop) are kept.
 */
export function pastedImageName(file: FileLike, now: Date = new Date(), index = 0): string {
  const generic = !file.name || /^image\.(png|jpe?g|gif|webp|svg)$/i.test(file.name);
  if (!generic) return file.name;
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const ext = EXT_BY_TYPE[file.type] ?? "png";
  return `screenshot-${stamp}${index > 0 ? `-${index + 1}` : ""}.${ext}`;
}
