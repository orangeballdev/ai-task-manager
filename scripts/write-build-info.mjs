import { mkdirSync, writeFileSync } from "fs";

const outDir = new URL("../src/generated/", import.meta.url);
mkdirSync(outDir, { recursive: true });

writeFileSync(
  new URL("build-info.json", outDir),
  JSON.stringify({ buildTime: new Date().toISOString() }, null, 2),
);
