/**
 * Shared marker + prompt builder for the "Review PR" task action.
 *
 * The action re-runs the existing (completed) task on its existing branch,
 * asking the agent to review its own pull request, fix anything it finds,
 * and end with a message that reads as a standalone PR review comment. The
 * worker detects the marker in `task.context` after the run completes and
 * posts the agent's final message as a comment on the PR(s) this task is
 * attached to (see `src/worker/index.ts`).
 */
export const REVIEW_PR_MARKER = "## Review PR";

export function buildReviewPrContext(branchName: string): string {
  return `${REVIEW_PR_MARKER}
This is a review pass over your own prior work, continuing on the existing branch \`${branchName}\` and its open pull request.

1. Review the changes on this branch (e.g. \`git diff origin/main...HEAD\`, or the appropriate base branch, and \`git log\`) for correctness, code quality, missed edge cases, and test coverage.
2. If you find real issues, fix them directly — make the necessary code changes and commit them as you normally would.
3. End your final message with a concise, well-formatted PR review comment (Markdown) summarizing what you reviewed, any issues found, and any changes you made in response. Write it exactly as it should appear as a standalone PR comment — no extra preamble like "Here's my review". This final message will be posted automatically as a comment on the pull request.`;
}
