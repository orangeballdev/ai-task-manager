"use client";
import { useState } from "react";
import Link from "next/link";
import { Bot, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AboutButton({ buildTime }: { buildTime?: string | null }) {
  const [open, setOpen] = useState(false);

  const formattedBuildTime = buildTime
    ? new Date(buildTime).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-6 h-6 rounded-full border border-muted-foreground/40 text-muted-foreground hover:text-foreground hover:border-foreground transition-colors text-xs flex items-center justify-center"
        aria-label="About"
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
              <h2 className="text-lg font-semibold">Claude Task Manager</h2>
            </div>

            <div className="flex flex-col gap-3 text-sm text-muted-foreground leading-relaxed">
              <p>
                This app lets you queue up coding tasks and have Claude work on them automatically, one at a time, in the background.
              </p>
              <p>
                You describe what you want done, point it at a Git repo, and the agent clones the repo, makes the changes, and opens a pull request.
              </p>
              <p>
                You can use your <strong className="text-foreground">Claude subscription</strong> (via the CLI) or your own <strong className="text-foreground">Anthropic API key</strong>, configure either in Settings.
              </p>
              <p>
                Tasks run one at a time. You can watch the live output, reorder the queue, and retry failed tasks.
              </p>
              <div className="border-t border-border pt-3 flex flex-col gap-2">
                <p className="font-medium text-foreground">Designed to keep token usage low</p>
                <ul className="flex flex-col gap-1.5 list-none">
                  <li>→ Each task runs in a <strong className="text-foreground">fresh, isolated context</strong>, no conversation history bleeding in</li>
                  <li>→ Repo-level <strong className="text-foreground">CLAUDE.md files</strong> are loaded automatically, so standing context lives in the repo, not the prompt</li>
                  <li>→ Tasks are <strong className="text-foreground">scoped to specific repos</strong>, so Claude never explores code it doesn&apos;t need</li>
                </ul>
              </div>
              <div className="border-t border-border pt-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => setOpen(false)}
                  render={<Link href="/setup" />}
                >
                  Setup Guide
                </Button>
              </div>
              {formattedBuildTime && (
                <p className="border-t border-border pt-3 text-xs text-muted-foreground/70">
                  Last deployed: {formattedBuildTime}
                </p>
              )}
            </div>

            <Button className="mt-5 w-full" onClick={() => setOpen(false)}>
              Got it
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
