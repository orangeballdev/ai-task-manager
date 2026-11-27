// Review metadata of a review-only ticket (src/lib/review-only.ts), shown on the
// task page where an agent task shows its repository, branch, commits and PR.
// Commits and the PR link to GitHub when the repo is on GitHub; each SHA has a
// one-click copy button.
import { AlertTriangle, CheckCircle2, CircleDashed, GitBranch, GitCommitHorizontal, GitMerge, GitPullRequest, XCircle } from "lucide-react";
import { CopyButton } from "@/components/CopyButton";
import { shortRepoUrl } from "@/lib/git-urls";
import {
  githubBranchUrl,
  githubCommitUrl,
  hasReviewMetadata,
  shortSha,
  type ReviewMetadata,
  type ReviewPrState,
} from "@/lib/review-only";

const PR_STATE_STYLE: Record<ReviewPrState["state"], { label: string; className: string; icon: React.ReactNode }> = {
  open: { label: "Open", className: "bg-green-500/10 text-green-500 border-green-500/20", icon: <GitPullRequest className="size-3" /> },
  draft: { label: "Draft", className: "bg-muted text-muted-foreground border-border", icon: <GitPullRequest className="size-3" /> },
  merged: { label: "Merged", className: "bg-violet-500/10 text-violet-400 border-violet-500/20", icon: <GitMerge className="size-3" /> },
  closed: { label: "Closed", className: "bg-red-500/10 text-red-500 border-red-500/20", icon: <XCircle className="size-3" /> },
};

function Chip({ className, icon, children, title }: { className: string; icon: React.ReactNode; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full border ${className}`}>
      {icon}
      {children}
    </span>
  );
}

/** The PR's state the way an agent task's PR is shown: merged/open plus conflict and CI chips. */
export function ReviewPrStateChips({ state }: { state: ReviewPrState }) {
  const s = PR_STATE_STYLE[state.state];
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Chip className={s.className} icon={s.icon}>{s.label}</Chip>
      {state.mergeableState === "conflicting" && (
        <Chip className="bg-red-500/10 text-red-500 border-red-500/20" icon={<AlertTriangle className="size-3" />}>Conflicts</Chip>
      )}
      {state.ciStatus === "failing" && (
        <Chip className="bg-red-500/10 text-red-500 border-red-500/20" icon={<AlertTriangle className="size-3" />}>CI failing</Chip>
      )}
      {state.ciStatus === "pending" && (
        <Chip className="bg-amber-500/10 text-amber-500 border-amber-500/20" icon={<CircleDashed className="size-3" />}>CI running</Chip>
      )}
      {state.ciStatus === "passing" && (
        <Chip className="bg-green-500/10 text-green-500 border-green-500/20" icon={<CheckCircle2 className="size-3" />}>CI passing</Chip>
      )}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 text-sm min-w-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function ReviewMetadataDetails({ meta, prState }: { meta: ReviewMetadata; prState: ReviewPrState | null }) {
  if (!hasReviewMetadata(meta)) {
    return <p className="text-xs text-muted-foreground">No repository, branch, commits or PR attached. Edit the ticket to add them.</p>;
  }
  const branchHref = meta.branch ? githubBranchUrl(meta, meta.branch) : null;
  return (
    <div className="flex flex-col gap-3">
      {meta.repo && (
        <Row label="Repository">
          <span className="block text-xs font-mono break-all" title={meta.repo}>{shortRepoUrl(meta.repo)}</span>
        </Row>
      )}
      {meta.branch && (
        <Row label="Branch">
          <span className="flex items-center gap-1.5 min-w-0">
            <GitBranch className="size-3.5 text-muted-foreground shrink-0" />
            {branchHref ? (
              <a href={branchHref} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-blue-400 hover:underline truncate" title={meta.branch}>
                {meta.branch}
              </a>
            ) : (
              <code className="bg-muted px-1.5 py-0.5 rounded text-xs truncate" title={meta.branch}>{meta.branch}</code>
            )}
            <CopyButton text={meta.branch} label="Copy branch name" successMessage="Copied branch name" />
          </span>
        </Row>
      )}
      {meta.commits.length > 0 && (
        <Row label={meta.commits.length > 1 ? "Commits" : "Commit"}>
          <span className="flex flex-col gap-0.5">
            {meta.commits.map((sha) => {
              const href = githubCommitUrl(meta, sha);
              return (
                <span key={sha} className="flex items-center gap-1 min-w-0">
                  <GitCommitHorizontal className="size-3.5 text-muted-foreground shrink-0" />
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-blue-400 hover:underline" title={sha}>
                      {shortSha(sha)}
                    </a>
                  ) : (
                    <code className="font-mono text-xs bg-muted px-1 rounded" title={sha}>{shortSha(sha)}</code>
                  )}
                  <CopyButton text={sha} label="Copy commit ID" successMessage="Copied commit ID" />
                </span>
              );
            })}
          </span>
        </Row>
      )}
      {meta.prUrl && (
        <Row label="Pull request">
          <span className="flex flex-col gap-1">
            <a href={meta.prUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:underline break-all">
              {prState?.number ? `#${prState.number}${prState.title ? ` ${prState.title}` : ""}` : meta.prUrl}
            </a>
            {prState && <ReviewPrStateChips state={prState} />}
          </span>
        </Row>
      )}
    </div>
  );
}
