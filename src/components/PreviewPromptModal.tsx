"use client";

import { copyToClipboard } from "@/lib/clipboard";
import { useState } from "react";
import { Eye, X, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface PreviewPromptProps {
  title: string;
  description: string;
  context?: string;
  labels?: string[];
  systemPrompt?: string | null;
  outputType?: string;
  repos?: Array<{ alias: string; url: string }>;
  contextFiles?: Array<{ repoAlias: string; path: string }>;
}

interface PromptPreview {
  system: string;
  user: string;
  meta: {
    hasRepos: boolean;
    usingCustomPrompt: boolean;
    claudeMdNote: string | null;
  };
}

function CopyIconButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    copyToClipboard(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="p-1.5 rounded text-muted-foreground hover:text-foreground transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
    </button>
  );
}

export function PreviewPromptModal({
  title,
  description,
  context,
  labels,
  systemPrompt,
  outputType,
  repos = [],
  contextFiles,
}: PreviewPromptProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PromptPreview | null>(null);

  async function loadPreview() {
    if (!title.trim() || !description.trim()) {
      toast.error("Enter a title and description first.");
      return;
    }
    setLoading(true);
    setPreview(null);
    setOpen(true);
    try {
      const res = await fetch("/api/tasks/preview-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description,
          context: context || undefined,
          labels: labels && labels.length > 0 ? labels : undefined,
          systemPrompt: systemPrompt || undefined,
          outputType: outputType || undefined,
          repos: repos.filter((r) => r.url).map((r) => ({ alias: r.alias, url: r.url })),
          contextFiles: contextFiles && contextFiles.length > 0 ? contextFiles : undefined,
        }),
      });
      const data = await res.json() as PromptPreview & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "Failed to load preview");
      setPreview(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load prompt preview");
      setOpen(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={!title.trim() || !description.trim()}
        onClick={() => void loadPreview()}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        title="Preview the exact prompt that will be sent to the AI"
      >
        <Eye size={13} />
        Preview prompt
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-background/80 backdrop-blur-sm" />

          {/* Modal */}
          <div className="relative z-10 w-full max-w-3xl max-h-[90vh] flex flex-col rounded-xl border border-border bg-card shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
              <div className="flex items-center gap-2">
                <Eye size={16} className="text-muted-foreground" />
                <h2 className="font-semibold text-base">Prompt Preview</h2>
                {preview?.meta.usingCustomPrompt && (
                  <span className="text-xs bg-purple-500/15 text-purple-400 border border-purple-500/30 px-2 py-0.5 rounded-full">Custom system prompt</span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            {loading ? (
              <div className="flex-1 flex items-center justify-center py-16 text-sm text-muted-foreground">
                Building prompt…
              </div>
            ) : preview ? (
              <div className="flex-1 overflow-y-auto">
                {/* System prompt section */}
                <div className="px-6 py-4 border-b border-border">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">System</span>
                      {preview.meta.usingCustomPrompt && (
                        <span className="text-[10px] text-purple-400 bg-purple-500/10 rounded px-1.5 py-0.5">overridden</span>
                      )}
                    </div>
                    <CopyIconButton text={preview.system} />
                  </div>
                  <pre className="text-xs text-foreground/80 font-mono whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto bg-muted/40 rounded-lg p-3">
                    {preview.system}
                  </pre>
                </div>

                {/* User prompt section */}
                <div className="px-6 py-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">User</span>
                    <CopyIconButton text={preview.user} />
                  </div>
                  <pre className="text-xs text-foreground/80 font-mono whitespace-pre-wrap leading-relaxed max-h-72 overflow-y-auto bg-muted/40 rounded-lg p-3">
                    {preview.user}
                  </pre>
                </div>

                {preview.meta.claudeMdNote && (
                  <div className="mx-6 mb-4 rounded-md border border-sky-500/30 bg-sky-500/5 px-3 py-2.5 text-xs text-sky-400">
                    ℹ️ {preview.meta.claudeMdNote}
                  </div>
                )}
              </div>
            ) : null}

            {/* Footer */}
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-border shrink-0">
              {preview && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void loadPreview()}
                  disabled={loading}
                >
                  Refresh
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
