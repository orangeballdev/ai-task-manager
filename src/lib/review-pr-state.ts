// Server-only: looks up the state of a review-only task's PR link with the GitHub
// CLI (`gh pr view`), so the task page can show it the way it shows an agent PR.
// Best effort — no `gh`, no access, a non-GitHub link or a slow call all return
// null and the page just shows the link. Parsing is the pure parseGhPrView().
import { execFile } from "child_process";
import { findGhBinary, loadGitHubCliSettings } from "@/lib/agent-tools-runtime";
import { isGitHubPrUrl, parseGhPrView, type ReviewPrState } from "@/lib/review-only";

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: ReviewPrState | null }>();

export async function fetchReviewPrState(prUrl: string | null | undefined): Promise<ReviewPrState | null> {
  if (!prUrl || !isGitHubPrUrl(prUrl)) return null;
  const hit = cache.get(prUrl);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const bin = await findGhBinary();
  if (!bin) return null;
  const { token } = await loadGitHubCliSettings().catch(() => ({ token: null }));

  const value = await new Promise<ReviewPrState | null>((resolve) => {
    execFile(
      bin,
      ["pr", "view", prUrl.trim(), "--json", "number,title,state,isDraft,mergeable,statusCheckRollup"],
      {
        timeout: 8000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, ...(token && { GH_TOKEN: token }), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      },
      (err, stdout) => resolve(err ? null : parseGhPrView(stdout)),
    );
  });
  cache.set(prUrl, { at: Date.now(), value });
  return value;
}
