import { readFileSync } from "fs";
import { join } from "path";

/** What scripts/write-build-info.mjs recorded at build time. */
export interface BuildInfo {
  buildTime: string | null;
  /** The image tag this build was published as (`sha-<short sha>`); null for a local build. */
  version: string | null;
  /** Full commit SHA, when known. */
  commit: string | null;
}

const asString = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function getBuildInfo(): BuildInfo {
  try {
    const raw = JSON.parse(readFileSync(join(process.cwd(), "src/generated/build-info.json"), "utf-8"));
    return { buildTime: asString(raw.buildTime), version: asString(raw.version), commit: asString(raw.commit) };
  } catch {
    return { buildTime: null, version: null, commit: null };
  }
}
