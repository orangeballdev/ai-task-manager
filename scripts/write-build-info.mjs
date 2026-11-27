// Runs before `next build` (npm "prebuild"). Records when and from what this build
// was made, for the version shown in the help (?) modal — see src/lib/build-info.ts.
//
// APP_VERSION and GIT_COMMIT are build args set by .github/workflows/images.yml
// (APP_VERSION = the image's `sha-<short sha>` tag). A local build has no
// APP_VERSION, and falls back to the checkout's commit when git is available
// (the Docker build context excludes .git, so a local `--build` image has neither).
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

const version = process.env.APP_VERSION?.trim() || null;
const commit = process.env.GIT_COMMIT?.trim() || gitCommit();

const outDir = new URL("../src/generated/", import.meta.url);
mkdirSync(outDir, { recursive: true });

writeFileSync(
  new URL("build-info.json", outDir),
  JSON.stringify({ buildTime: new Date().toISOString(), version, commit }, null, 2),
);
