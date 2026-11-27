/* eslint-disable @next/next/no-img-element -- static HTML generator, not a Next.js page */
// Screenshots: the build writes a lossless WebP next to every PNG (60–75% smaller, pixel
// identical) and records each image's size, so pages can serve <picture> with WebP + PNG
// fallback and reserve the image's space before it loads (no layout shift).
// If sharp can't load, pages fall back to the plain PNG without dimensions.
import fs from "fs";
import path from "path";

interface ImageInfo {
  width: number;
  height: number;
  webp: boolean;
}

/** Keyed by site-root-relative path, e.g. "screenshots/board.png". */
const images = new Map<string, ImageInfo>();

export async function prepareImages(dist: string, dir = "screenshots"): Promise<void> {
  const abs = path.join(dist, dir);
  if (!fs.existsSync(abs)) return;
  let sharp: (typeof import("sharp"))["default"];
  try {
    sharp = (await import("sharp")).default;
  } catch {
    console.warn("sharp is not available: screenshots are served as PNG only");
    return;
  }
  for (const file of fs.readdirSync(abs).filter((f) => f.endsWith(".png"))) {
    const src = path.join(abs, file);
    const meta = await sharp(src).metadata();
    await sharp(src).webp({ lossless: true }).toFile(src.replace(/\.png$/, ".webp"));
    images.set(`${dir}/${file}`, { width: meta.width ?? 0, height: meta.height ?? 0, webp: true });
  }
}

export function imageInfo(rootPath: string): ImageInfo | undefined {
  return images.get(rootPath.replace(/^\/+/, ""));
}

/**
 * A screenshot as <picture>. `rootPath` is relative to the site root ("screenshots/board.png"),
 * `prefix` the page's "../" prefix. `eager` is for the above-the-fold image (the LCP element).
 */
export function Picture({ rootPath, prefix, alt, eager }: { rootPath: string; prefix: string; alt: string; eager?: boolean }) {
  const clean = rootPath.replace(/^\/+/, "");
  const info = imageInfo(clean);
  const src = prefix + clean;
  const img = (
    <img
      src={src}
      alt={alt}
      width={info?.width || undefined}
      height={info?.height || undefined}
      loading={eager ? "eager" : "lazy"}
      decoding={eager ? undefined : "async"}
      fetchPriority={eager ? "high" : undefined}
    />
  );
  if (!info?.webp) return img;
  return (
    <picture>
      <source srcSet={src.replace(/\.png$/, ".webp")} type="image/webp" />
      {img}
    </picture>
  );
}
