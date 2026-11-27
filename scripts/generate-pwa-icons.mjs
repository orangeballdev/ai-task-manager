// Generates the PNG icons required for PWA / iOS "Add to Home Screen" support.
//
// iOS Safari does not read icons from manifest.json — it only looks at the
// `apple-touch-icon` <link> tag (which Next.js generates automatically from
// `src/app/apple-icon.png`). Android + the web manifest spec want real PNG
// files with explicit sizes, so we rasterize the brand mark (same design as
// src/app/icon.svg) at the sizes each surface expects.
//
// Re-run with `node scripts/generate-pwa-icons.mjs` any time the brand mark
// changes.

import sharp from "sharp";
import { mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const BG = "#09090b";
const STROKE = "#E8865A";

// Full-bleed icon: the 24x24 glyph is scaled up to fill the whole canvas,
// used for the standard "icon" purpose entries and the apple touch icon.
function fullBleedSvg(size) {
  const scale = size / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <g transform="scale(${scale})" fill="none" stroke="${STROKE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 8V4H8"/>
    <rect width="16" height="12" x="4" y="8" rx="2"/>
    <path d="M2 14h2"/>
    <path d="M20 14h2"/>
    <path d="M15 13v2"/>
    <path d="M9 13v2"/>
  </g>
</svg>`;
}

// Maskable icon: glyph kept inside the ~80% "safe zone" circle so OS-applied
// masks (circle/squircle/rounded-square) never clip the artwork.
function maskableSvg(size) {
  const glyphSize = size * 0.6; // 24x24 glyph rendered at 60% of the canvas
  const scale = glyphSize / 24;
  const inset = (size - glyphSize) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${BG}"/>
  <g transform="translate(${inset} ${inset}) scale(${scale})" fill="none" stroke="${STROKE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 8V4H8"/>
    <rect width="16" height="12" x="4" y="8" rx="2"/>
    <path d="M2 14h2"/>
    <path d="M20 14h2"/>
    <path d="M15 13v2"/>
    <path d="M9 13v2"/>
  </g>
</svg>`;
}

async function render(svg, outPath) {
  // Flatten away the alpha channel: Apple explicitly recommends apple-touch
  // icons have no transparency (iOS renders any transparent pixels as black).
  await sharp(Buffer.from(svg))
    .flatten({ background: BG })
    .png()
    .toFile(outPath);
  console.log(`wrote ${path.relative(root, outPath)}`);
}

async function main() {
  const iconsDir = path.join(root, "public", "icons");
  mkdirSync(iconsDir, { recursive: true });

  await render(fullBleedSvg(192), path.join(iconsDir, "icon-192.png"));
  await render(fullBleedSvg(512), path.join(iconsDir, "icon-512.png"));
  await render(maskableSvg(512), path.join(iconsDir, "maskable-icon-512.png"));

  // Next.js picks up `src/app/apple-icon.png` automatically and injects
  // <link rel="apple-touch-icon">. 180x180 is Apple's recommended size.
  await render(fullBleedSvg(180), path.join(root, "src", "app", "apple-icon.png"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
