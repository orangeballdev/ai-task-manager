"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Check,
  GitBranch,
  Loader2,
  MessageSquare,
  Mic,
  RefreshCw,
  Send,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { MarkdownContent } from "@/components/MarkdownContent";
import { useSpeechDictation } from "@/hooks/useSpeechDictation";
import { getModelsForProviderType } from "@/lib/models";
import { shortRepoUrl } from "@/lib/git-urls";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import type { ChatMessage } from "@/lib/chat";
import type { AIProvider } from "@/lib/types";
import { getAnalytics } from "@/components/WebAnalytics";

/**
 * Starter questions shown on an empty conversation. Deliberately generic enough
 * to work for any codebase — the answers are what make them repo-specific.
 */
const SUGGESTED_QUESTIONS = [
  "What does this repository do, and how is it structured?",
  "How do I run it locally?",
  "Walk me through the main entry points.",
  "What are the key conventions I should follow when changing this code?",
  "Where would I add a new API endpoint?",
];

/**
 * Cloning a repo to build its snapshot takes seconds, so cache the result per
 * repo in sessionStorage. Short-lived on purpose: long enough to survive
 * navigating away and back mid-conversation, short enough that a snapshot never
 * silently goes stale against a moving branch.
 */
const CONTEXT_TTL_MS = 30 * 60 * 1000;
const contextCacheKey = (url: string) => `repo-chat-context:${url}`;
const messagesCacheKey = (url: string) => `repo-chat-messages:${url}`;

function readCachedContext(url: string): string | null {
  try {
    const raw = sessionStorage.getItem(contextCacheKey(url));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { context: string; at: number };
    if (!parsed.context || Date.now() - parsed.at > CONTEXT_TTL_MS) return null;
    return parsed.context;
  } catch {
    return null;
  }
}

function writeCachedContext(url: string, context: string) {
  try {
    sessionStorage.setItem(contextCacheKey(url), JSON.stringify({ context, at: Date.now() }));
  } catch {
    /* snapshot is just a cache — quota errors are fine to swallow */
  }
}

function readCachedMessages(url: string): ChatMessage[] {
  try {
    const raw = sessionStorage.getItem(messagesCacheKey(url));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ChatMessage[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

type ContextState = "idle" | "loading" | "ready" | "error";

export default function RepoChatClient() {
  const searchParams = useSearchParams();
  const repoUrl = (searchParams.get("url") ?? "").trim();
  const aliasParam = (searchParams.get("alias") ?? "").trim();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [providerId, setProviderId] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [modelSelectValue, setModelSelectValue] = useState<string>("");
  const [showOptions, setShowOptions] = useState(false);

  const [gitContext, setGitContext] = useState<string | null>(null);
  const [contextState, setContextState] = useState<ContextState>(repoUrl ? "loading" : "idle");
  const [contextError, setContextError] = useState<string | null>(null);
  // Bumped by "Refresh"/"Retry". 0 means "first load, cache is fine"; anything
  // higher forces a re-clone, which is the whole point of pressing the button.
  const [contextReload, setContextReload] = useState(0);
  // Switching to another repo starts a fresh snapshot load. Done during render
  // (not in the effect below) so the old repo's snapshot is never shown as ready.
  const [contextRepoUrl, setContextRepoUrl] = useState(repoUrl);
  if (contextRepoUrl !== repoUrl) {
    setContextRepoUrl(repoUrl);
    setGitContext(null);
    setContextState(repoUrl ? "loading" : "idle");
    setContextError(null);
  }

  function reloadContext() {
    setContextState("loading");
    setContextError(null);
    setContextReload((n) => n + 1);
  }

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { isRecording, isSupported: isSpeechSupported, toggleRecording } = useSpeechDictation((transcript) => {
    setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
  });

  const alias = aliasParam || (repoUrl ? shortRepoUrl(repoUrl).split("/").pop() ?? "repository" : "repository");
  const selectedProvider = providers.find((p) => p.id === providerId);

  // Live model list for the selected provider, falling back to the static list
  // for its vendor when the API can't be queried.
  const [providerModels, setProviderModels] = useState<{ id: string; label: string }[]>([]);
  const modelList = useMemo(
    () => (providerModels.length > 0 ? providerModels : getModelsForProviderType(selectedProvider?.type ?? "")),
    [providerModels, selectedProvider?.type]
  );

  // Restore any in-flight conversation for this repo (survives navigating back
  // to the repositories list and returning).
  useEffect(() => {
    if (!repoUrl) return;
    // sessionStorage only exists in the browser, so this can't be read during
    // render without a hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMessages(readCachedMessages(repoUrl));
  }, [repoUrl]);

  useEffect(() => {
    if (!repoUrl) return;
    try {
      if (messages.length === 0) sessionStorage.removeItem(messagesCacheKey(repoUrl));
      else sessionStorage.setItem(messagesCacheKey(repoUrl), JSON.stringify(messages));
    } catch {
      /* ignore quota errors */
    }
  }, [messages, repoUrl]);

  // Default to the app's globally configured AI connection and its model. An
  // empty model means "whatever this provider is set to" — the server falls
  // back to provider.model — so the defaults here are exactly Settings → AI.
  useEffect(() => {
    fetch("/api/providers")
      .then((r) => r.json())
      .then((providerData: AIProvider[]) => {
        setProviders(providerData);
        const def =
          providerData.find((p) => p.isDefault && p.isEnabled)
          ?? providerData.find((p) => p.isEnabled)
          ?? providerData[0];
        if (!def) return;
        setProviderId(def.id);
        setModel(def.model ?? "");
        setModelSelectValue(def.model || "default");
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!providerId) return;
    fetch(`/api/providers/${providerId}/models`)
      .then((r) => r.json())
      .then((d: { models?: { id: string; label: string }[] }) => setProviderModels(d.models ?? []))
      .catch(() => setProviderModels([]));
  }, [providerId]);

  // Build (or restore) the repo snapshot. Cloning takes seconds, so the first
  // load reuses a cached snapshot when there is one and only a deliberate
  // Refresh/Retry re-clones.
  useEffect(() => {
    if (!repoUrl) return;

    const cached = contextReload === 0 ? readCachedContext(repoUrl) : null;
    if (cached) {
      // The snapshot cache is in sessionStorage, which only exists in the browser.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGitContext(cached);
      setContextState("ready");
      return;
    }

    // contextState is already "loading" here: set by the initial state, the
    // repo switch above, or reloadContext().
    let cancelled = false;

    fetch("/api/tasks/git-context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: repoUrl }),
    })
      .then(async (res) => {
        const data = (await res.json()) as { context?: string; error?: string };
        if (!res.ok || !data.context) throw new Error(data.error || "Failed to read the repository");
        return data.context;
      })
      .then((context) => {
        if (cancelled) return;
        writeCachedContext(repoUrl, context);
        setGitContext(context);
        setContextState("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setGitContext(null);
        setContextState("error");
        setContextError(err instanceof Error ? err.message : "Failed to read the repository");
      });

    return () => { cancelled = true; };
  }, [repoUrl, contextReload]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  // Switching connections re-seeds the model from the new provider, so an
  // Anthropic model id can't be left selected against an OpenAI connection.
  function handleProviderChange(value: string | null) {
    if (!value) return;
    setProviderId(value);
    setProviderModels([]);
    const next = providers.find((p) => p.id === value)?.model ?? "";
    setModel(next);
    setModelSelectValue(next || "default");
  }

  function handleModelChange(value: string | null) {
    if (!value) return;
    setModelSelectValue(value);
    // "default" clears the override so the server uses provider.model;
    // "custom" waits for the free-text input below to supply an id.
    if (value === "default") setModel("");
    else if (value !== "custom") setModel(value);
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending || !repoUrl) return;

    const next: ChatMessage[] = [...messages, { role: "user", content: trimmed }];
    setMessages(next);
    setInput("");
    setError(null);
    setSending(true);

    try {
      const res = await fetch("/api/repos/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next,
          repoUrl,
          repoAlias: alias,
          gitContext: gitContext || undefined,
          providerId: providerId || undefined,
          model: model || undefined,
        }),
      });
      const data = (await res.json()) as { reply?: string; error?: string };
      if (!res.ok) throw new Error(data.error || "Chat failed");
      getAnalytics()?.capture("repo_chat_asked", { turn: next.filter((m) => m.role === "user").length });
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply || "(no response)" }]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Chat failed";
      setError(msg);
      toast.error(msg);
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  function resetChat() {
    setMessages([]);
    setError(null);
    try { sessionStorage.removeItem(messagesCacheKey(repoUrl)); } catch { /* ignore */ }
  }

  if (!repoUrl) {
    return (
      <div className="mx-auto flex w-full max-w-7xl flex-col items-center gap-3 py-16 text-center">
        <TriangleAlert className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">No repository selected</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Open this page from the Repositories list to ask questions about a specific repo.
        </p>
        <Link href="/repositories">
          <Button variant="outline" className="mt-1">
            <ArrowLeft className="size-4" />
            Back to Repositories
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-3">
      {/* Header — kept to two compact lines so it doesn't eat a phone screen */}
      <div className="flex items-center gap-2">
        <Link
          href="/repositories"
          aria-label="Back to Repositories"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground sm:size-8"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-1.5 truncate text-base font-bold sm:text-lg">
            <MessageSquare className="size-4 shrink-0 sm:size-5" />
            <span className="truncate">Ask {alias}</span>
          </h1>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{shortRepoUrl(repoUrl)}</p>
        </div>
        {messages.length > 0 && (
          <Button variant="ghost" size="sm" className="shrink-0" onClick={resetChat} disabled={sending}>
            New chat
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          onClick={() => setShowOptions((v) => !v)}
          aria-expanded={showOptions}
          aria-label="Chat options"
          title="Provider and model"
        >
          <SlidersHorizontal className="size-4" />
        </Button>
      </div>

      {/* Snapshot status + optional provider/model controls */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {contextState === "loading" && (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Reading the repository…
            </span>
          )}
          {contextState === "ready" && (
            <span className="flex items-center gap-1.5 text-green-500">
              <Check className="size-3.5" />
              Repository loaded as context
            </span>
          )}
          {contextState === "error" && (
            <span className="flex items-center gap-1.5 text-red-400">
              <TriangleAlert className="size-3.5" />
              {contextError ?? "Couldn't read the repository"}
            </span>
          )}
          {contextState !== "loading" && (
            <button
              type="button"
              onClick={reloadContext}
              className="flex items-center gap-1 text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              <RefreshCw className="size-3" />
              {contextState === "error" ? "Retry" : "Refresh"}
            </button>
          )}
        </div>

        {showOptions && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2.5">
            <Select value={providerId} onValueChange={handleProviderChange}>
              <SelectTrigger size="sm" className="h-8 w-full text-xs sm:w-40">
                <span className="flex-1 truncate text-left">{selectedProvider?.name ?? "Provider"}</span>
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id} label={p.name} className="text-xs">
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={modelSelectValue} onValueChange={handleModelChange}>
              <SelectTrigger size="sm" className="h-8 w-full text-xs sm:w-48">
                <span className="flex-1 truncate text-left">
                  {modelList.find((m) => m.id === modelSelectValue)?.label
                    ?? (modelSelectValue === "custom" ? "Custom" : model || "Provider default")}
                </span>
              </SelectTrigger>
              <SelectContent>
                {/* Lets the user get back to Settings → AI's model after picking
                    an override; sends no model so the server uses provider.model. */}
                <SelectItem value="default" className="text-xs">Provider default</SelectItem>
                {modelList.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-xs">{m.label}</SelectItem>
                ))}
                <SelectItem value="custom" className="text-xs">Custom…</SelectItem>
              </SelectContent>
            </Select>

            {modelSelectValue === "custom" && (
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="model-id"
                className="h-8 w-full text-xs sm:w-40"
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </div>
        )}
      </div>

      {/* Conversation */}
      <div className="flex h-[52dvh] min-h-72 flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-card p-3 sm:h-[56vh] sm:p-4">
        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-2 py-6 text-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <GitBranch className="size-5" />
            </span>
            <p className="text-sm font-medium">Ask anything about {alias}</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              This is a read-only conversation — nothing is committed and no task is created.
            </p>
            <div className="mt-1 flex w-full flex-col gap-1.5">
              {SUGGESTED_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => void send(q)}
                  disabled={sending}
                  className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
                >
                  <Sparkles className="size-3.5 shrink-0" />
                  <span className="min-w-0">{q}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, i) => (
            <div key={i} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  // min-w-0 so fenced code blocks scroll inside the bubble
                  // instead of stretching it past the conversation pane.
                  "min-w-0 max-w-[92%] overflow-hidden rounded-2xl px-3.5 py-2.5 text-sm sm:max-w-[85%]",
                  msg.role === "user"
                    ? "whitespace-pre-wrap rounded-br-sm bg-primary text-primary-foreground"
                    : "rounded-bl-sm bg-muted text-foreground"
                )}
              >
                {msg.role === "user" ? msg.content : <MarkdownContent content={msg.content} />}
              </div>
            </div>
          ))
        )}
        {sending && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2.5 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-800 bg-red-950/60 px-3 py-2.5 text-sm text-red-300">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      {/* Composer */}
      <div className="flex items-end gap-2">
        <Textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          placeholder={contextState === "loading" ? "Reading the repository…" : `Ask about ${alias}…`}
          rows={2}
          className="max-h-32 flex-1 resize-none overflow-y-auto"
          disabled={sending}
        />
        <button
          type="button"
          onClick={isSpeechSupported ? toggleRecording : undefined}
          disabled={!isSpeechSupported}
          aria-label={isRecording ? "Stop recording" : "Start voice dictation"}
          title={isSpeechSupported ? (isRecording ? "Stop recording" : "Voice dictation") : "Voice dictation not supported in this browser"}
          className={cn(
            "shrink-0 rounded-lg border p-2.5 transition-colors sm:p-2",
            !isSpeechSupported
              ? "cursor-not-allowed border-border text-muted-foreground/40"
              : isRecording
                ? "animate-pulse border-red-500 bg-red-500/10 text-red-500"
                : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
          )}
        >
          <Mic className="size-4" />
        </button>
        <Button
          size="lg"
          className="h-11 shrink-0 sm:h-9"
          onClick={() => void send(input)}
          disabled={sending || !input.trim()}
          aria-label="Send"
        >
          <Send className="size-4" />
          <span className="hidden sm:inline">Send</span>
        </Button>
      </div>

      <p className="px-1 text-center text-[11px] text-muted-foreground">
        Answers come from a snapshot of the repo (tree, README, config and key source files), so they can miss
        details. Need a change made?{" "}
        <Link href="/tasks/new" className="underline underline-offset-2 hover:text-foreground">
          Create a task
        </Link>
        .
      </p>
    </div>
  );
}
