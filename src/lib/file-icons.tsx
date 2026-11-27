import {
  Folder,
  File as FileIcon,
  FileText,
  FileCode,
  FileJson,
  Image as ImageIcon,
  Archive,
  Monitor,
} from "lucide-react";

export const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "swift", "php",
  "c", "cpp", "h", "hpp", "cs", "scala",
  "html", "htm", "css", "scss", "sass", "less",
  "sh", "bash", "zsh", "ps1",
  "sql", "graphql", "gql", "prisma",
  "vue", "svelte", "astro",
  "ex", "exs", "zig", "nim", "lua",
]);

export const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown"]);
export const JSON_EXTENSIONS = new Set(["json", "yaml", "yml", "toml", "xml"]);
export const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"]);
export const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "bz2", "7z", "rar"]);
export const SLIDESHOW_EXTENSIONS = new Set(["slides"]);

/** Extract the lowercase extension from a file name (without the dot). */
export function getFileExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

interface IconEntry {
  name: string;
  type?: "file" | "directory";
  ext?: string;
}

/**
 * Returns a colored lucide icon for a file/directory based on its extension.
 * Markdown → blue, code → green, json/config → orange, images → purple,
 * archives → red, slideshows → pink, directories → yellow.
 */
export function getFileIcon(entry: IconEntry, size = "size-5") {
  if (entry.type === "directory") {
    return <Folder className={`${size} text-yellow-400 shrink-0`} />;
  }
  const name = entry.name ?? "";
  const ext = entry.ext ?? getFileExt(name);
  if (SLIDESHOW_EXTENSIONS.has(ext) || name.endsWith(".slides.md")) return <Monitor className={`${size} text-pink-400 shrink-0`} />;
  if (MARKDOWN_EXTENSIONS.has(ext)) return <FileText className={`${size} text-blue-400 shrink-0`} />;
  if (CODE_EXTENSIONS.has(ext)) return <FileCode className={`${size} text-green-400 shrink-0`} />;
  if (JSON_EXTENSIONS.has(ext)) return <FileJson className={`${size} text-orange-400 shrink-0`} />;
  if (IMAGE_EXTENSIONS.has(ext)) return <ImageIcon className={`${size} text-purple-400 shrink-0`} />;
  if (ARCHIVE_EXTENSIONS.has(ext)) return <Archive className={`${size} text-red-400 shrink-0`} />;
  return <FileIcon className={`${size} text-muted-foreground shrink-0`} />;
}
