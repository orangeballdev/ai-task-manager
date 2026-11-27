"use client";
import { useState } from "react";
import { BookOpen, Bot, Bug, ExternalLink, Globe, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BuildInfo } from "@/lib/build-info";
import { GITHUB_URL, PUBLIC_DOCS_URL, PUBLIC_SITE_URL } from "@/lib/public-site";

const LINKS = [
  { href: PUBLIC_DOCS_URL, label: "Documentation", icon: BookOpen },
  { href: PUBLIC_SITE_URL, label: "Website", icon: Globe },
  { href: GITHUB_URL, label: "GitHub", icon: ExternalLink },
  { href: `${GITHUB_URL}/issues`, label: "Report an issue", icon: Bug },
];

export function AboutButton({ buildInfo }: { buildInfo: BuildInfo }) {
  const [open, setOpen] = useState(false);

  const { buildTime, version, commit } = buildInfo;
  const formattedBuildTime = buildTime
    ? new Date(buildTime).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : null;
  // A published image shows its tag (sha-xxxxxxx); a local build shows its commit if known.
  const versionLabel = version ?? (commit ? `local build (${commit.slice(0, 7)})` : "local build");

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-6 h-6 rounded-full border border-muted-foreground/40 text-muted-foreground hover:text-foreground hover:border-foreground transition-colors text-xs flex items-center justify-center"
        aria-label="Help and version"
      >
        ?
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-black/60 backdrop-blur-sm overflow-y-auto p-4 sm:p-6"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative bg-card border border-border rounded-xl shadow-2xl max-w-md w-full mx-auto my-auto p-4 sm:p-6 max-h-[calc(100vh-2rem)] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setOpen(false)}
              className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>

            <div className="flex items-center gap-3 mb-4 pr-8">
              <Bot size={28} className="shrink-0" style={{ color: "#E8865A" }} />
              <h2 className="text-lg font-semibold">AI Task Manager</h2>
            </div>

            <div className="flex flex-col gap-3 text-sm text-muted-foreground leading-relaxed">
              <p>
                Queue coding tasks and let AI agents work through them in the background. Point a task at one or more
                Git repos: the agent clones them, makes the changes, and pushes a branch or opens a pull request for you to review.
              </p>
              <p>
                Agents run on your <strong className="text-foreground">Claude or ChatGPT subscription</strong> (Claude Code or
                Codex CLI) or an <strong className="text-foreground">API key</strong>, set up in Settings → AI. Run a single
                agent per task, or a <strong className="text-foreground">team</strong> that hands the work from one stage to the next.
              </p>

              <div className="border-t border-border pt-3 grid grid-cols-2 gap-2">
                {LINKS.map(({ href, label, icon: Icon }) => (
                  <a
                    key={href}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-foreground hover:bg-muted transition-colors"
                  >
                    <Icon size={14} className="shrink-0 text-muted-foreground" />
                    {label}
                  </a>
                ))}
              </div>

              <dl className="border-t border-border pt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-muted-foreground/80">
                <dt>Version</dt>
                <dd className="font-mono text-foreground/90">
                  {commit ? (
                    <a
                      href={`${GITHUB_URL}/commit/${commit}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                      title="View this commit on GitHub"
                    >
                      {versionLabel}
                    </a>
                  ) : (
                    versionLabel
                  )}
                </dd>
                {formattedBuildTime && (
                  <>
                    <dt>Built</dt>
                    <dd>{formattedBuildTime}</dd>
                  </>
                )}
              </dl>
            </div>

            <Button className="mt-5 w-full" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
