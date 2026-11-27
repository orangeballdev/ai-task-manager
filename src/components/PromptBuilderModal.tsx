"use client";
import { useState, useEffect, useRef } from "react";
import { X, Wand2, GitBranch, Check, Mic } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { getModelsForProviderType, DEFAULT_ASSISTANT_MODEL } from "@/lib/models";
import { useSpeechDictation } from "@/hooks/useSpeechDictation";
import { RepoUrlInput, type RepoHistory } from "@/components/TaskFormContent";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface AIProvider {
  id: string;
  name: string;
  type: string;
  isDefault: boolean;
}

interface PromptBuilderModalProps {
  initialDescription?: string;
  repoHistory?: RepoHistory[];
  onUsePrompt: (prompt: string) => void;
  onClose: () => void;
}

async function saveSetting(key: string, value: string) {
  await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
}

export function PromptBuilderModal({ initialDescription, repoHistory = [], onUsePrompt, onClose }: PromptBuilderModalProps) {
  // Seeded once on open: the caller's description (sent for a reply on mount
  // below) or a greeting asking what the agent should do.
  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    initialDescription?.trim()
      ? [{ role: "user", content: initialDescription }]
      : [{
          role: "assistant",
          content: "Hi! I'll help you write a clear, detailed task description for the AI agent.\n\nWhat do you want the agent to do?",
        }]
  );
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [refinedPrompt, setRefinedPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [model, setModel] = useState<string>(DEFAULT_ASSISTANT_MODEL);
  const [modelSelectValue, setModelSelectValue] = useState<string>(DEFAULT_ASSISTANT_MODEL);
  const [showGitInput, setShowGitInput] = useState(false);
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [gitContext, setGitContext] = useState<string | null>(null);
  const [loadingContext, setLoadingContext] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const initializedRef = useRef(false);

  const { isRecording, isSupported: isSpeechSupported, toggleRecording } = useSpeechDictation((transcript) => {
    setInput((prev) => prev ? `${prev} ${transcript}` : transcript);
  });

  const selectedProvider = providers.find((p) => p.id === selectedProviderId);
  const [dynamicModels, setDynamicModels] = useState<{ id: string; label: string }[] | null>(null);
  const staticModels = getModelsForProviderType(selectedProvider?.type ?? "");
  const modelList = dynamicModels ?? staticModels;

  useEffect(() => {
    Promise.all([
      fetch("/api/providers").then((r) => r.json()),
      fetch("/api/settings").then((r) => r.json()),
    ])
      .then(([providerData, settingsData]: [AIProvider[], Record<string, string>]) => {
        setProviders(providerData);
        const def = providerData.find((p) => p.isDefault) ?? providerData[0];
        if (def) setSelectedProviderId(def.id);
        const savedModel = settingsData.prompt_builder_model;
        if (savedModel) {
          setModel(savedModel);
          setModelSelectValue(savedModel);
        }
      })
      .catch(() => {});
  }, []);

  // Fetch live model list when selected provider changes (free — no tokens consumed)
  useEffect(() => {
    if (!selectedProviderId) return;
    fetch(`/api/providers/${selectedProviderId}/models`)
      .then((r) => r.json())
      .then((d: { models: { id: string; label: string }[] }) => {
        if (d.models?.length) setDynamicModels(d.models);
      })
      .catch(() => setDynamicModels(null));
  }, [selectedProviderId]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    if (initialDescription?.trim()) {
      // One-off kick-off of the first reply when the modal opens with a description.
      sendToApi([{ role: "user", content: initialDescription }]);
    } else {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function handleModelChange(value: string | null) {
    if (!value) return;
    setModelSelectValue(value);
    if (value !== "custom") {
      setModel(value);
      void saveSetting("prompt_builder_model", value).catch(() => {});
    }
  }

  async function loadGitContext() {
    const url = gitRepoUrl.trim();
    if (!url) return;
    setLoadingContext(true);
    setContextError(null);
    try {
      const res = await fetch("/api/tasks/git-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const err = await res.json() as { error: string };
        throw new Error(err.error || "Failed to load context");
      }
      const data = await res.json() as { context: string };
      setGitContext(data.context);
      setShowGitInput(false);
    } catch (err) {
      setContextError(err instanceof Error ? err.message : "Failed to load context");
    } finally {
      setLoadingContext(false);
    }
  }

  async function sendToApi(msgs: ChatMessage[]) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tasks/prompt-builder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: msgs,
          providerId: selectedProviderId || undefined,
          model: model || undefined,
          gitContext: gitContext || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json() as { error: string };
        throw new Error(err.error || "Request failed");
      }
      const data = await res.json() as { reply: string; refinedPrompt?: string };
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
      if (data.refinedPrompt) {
        setRefinedPrompt(data.refinedPrompt);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Request failed";
      setError(msg);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;
    const newMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(newMessages);
    setInput("");
    await sendToApi(newMessages);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
    >
      <div
        className="relative bg-card border border-border rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-2xl mx-0 sm:mx-4 flex flex-col"
        style={{ maxHeight: "85dvh" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — title row + controls row, both inside the header border */}
        <div className="flex flex-col gap-2 px-4 pt-3 pb-2 border-b border-border shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Wand2 size={16} className="text-primary" />
              <span className="font-semibold text-sm">Prompt Builder</span>
            </div>
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          {providers.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <Select value={selectedProviderId} onValueChange={(v) => { if (v) setSelectedProviderId(v); }}>
                <SelectTrigger size="sm" className="w-32 h-7 text-xs">
                  <span className="flex-1 text-left truncate">
                    {providers.find((p) => p.id === selectedProviderId)?.name ?? "Provider"}
                  </span>
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
                <SelectTrigger size="sm" className="w-44 h-7 text-xs">
                  <span className="flex-1 text-left truncate">
                    {modelList.find((m) => m.id === modelSelectValue)?.label ?? (modelSelectValue === "custom" ? "Custom" : (model || "Model"))}
                  </span>
                </SelectTrigger>
                <SelectContent>
                  {modelList.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="text-xs">
                      {m.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom" className="text-xs">Custom…</SelectItem>
                </SelectContent>
              </Select>

              {modelSelectValue === "custom" && (
                <Input
                  value={model}
                  onChange={(e) => {
                    setModel(e.target.value);
                    void saveSetting("prompt_builder_model", e.target.value).catch(() => {});
                  }}
                  placeholder="model-id"
                  className="h-7 text-xs w-36"
                />
              )}

              <button
                onClick={() => setShowGitInput((v) => !v)}
                className={`flex items-center gap-1 text-xs px-2 py-1.5 rounded-md border transition-colors ${gitContext ? "border-green-500/50 bg-green-500/10 text-green-500" : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"}`}
                title={gitContext ? "Repo context loaded, click to change" : "Attach git repo for context"}
              >
                {gitContext ? <Check size={12} /> : <GitBranch size={12} />}
                <span>{gitContext ? "Context loaded" : "Attach repo"}</span>
              </button>
            </div>
          )}
        </div>

        {/* Git context input */}
        {showGitInput && (
          <div className="px-4 py-2.5 border-b border-border bg-muted/30 shrink-0 flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Attach a git repository to give the assistant codebase context. This is ephemeral, it won&apos;t be saved to the task.
            </p>
            <div className="flex gap-2">
              <div className="flex-1">
                <RepoUrlInput
                  value={gitRepoUrl}
                  onChange={setGitRepoUrl}
                  history={repoHistory}
                  placeholder="https://github.com/org/repo.git"
                  className="h-8 text-xs"
                />
              </div>
              <Button size="sm" onClick={() => void loadGitContext()} disabled={loadingContext || !gitRepoUrl.trim()} className="h-8 text-xs">
                {loadingContext ? "Loading…" : "Load"}
              </Button>
              {gitContext && (
                <Button size="sm" variant="ghost" onClick={() => { setGitContext(null); setGitRepoUrl(""); setShowGitInput(false); }} className="h-8 text-xs">
                  Clear
                </Button>
              )}
            </div>
            {contextError && (
              <p className="text-xs text-red-500">{contextError}</p>
            )}
          </div>
        )}

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3 min-h-0">
          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : "bg-muted text-foreground rounded-bl-sm"
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm text-muted-foreground">
                Thinking…
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Refined prompt preview */}
        {refinedPrompt && (
          <div className="mx-4 mb-3 rounded-xl border border-primary/30 bg-primary/5 p-3 flex flex-col gap-2 shrink-0">
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs font-medium text-primary uppercase tracking-wide shrink-0">Suggested Prompt</span>
              <Button size="sm" onClick={() => onUsePrompt(refinedPrompt)}>
                Use Prompt
              </Button>
            </div>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap line-clamp-4">{refinedPrompt}</p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mx-4 mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300 shrink-0">
            {error}
          </div>
        )}

        {/* Input */}
        <div className="border-t border-border p-3 flex gap-2 items-end shrink-0">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void sendMessage();
              }
            }}
            placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
            rows={2}
            className="flex-1 resize-none max-h-32 overflow-y-auto"
            disabled={loading}
          />
          <button
            type="button"
            onClick={isSpeechSupported ? toggleRecording : undefined}
            aria-label={isRecording ? "Stop recording" : "Start voice dictation"}
            title={isSpeechSupported ? (isRecording ? "Stop recording" : "Voice dictation") : "Voice dictation not supported in this browser"}
            disabled={!isSpeechSupported}
            className={`shrink-0 p-2 rounded-lg border transition-colors ${
              !isSpeechSupported
                ? "border-border text-muted-foreground/40 cursor-not-allowed"
                : isRecording
                  ? "border-red-500 text-red-500 bg-red-500/10 animate-pulse"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
            }`}
          >
            <Mic size={16} />
          </button>
          <Button onClick={() => void sendMessage()} disabled={loading || !input.trim()} className="shrink-0">
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
