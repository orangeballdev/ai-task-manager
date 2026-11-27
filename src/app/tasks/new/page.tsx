"use client";
import { useState, useEffect, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { GitBranch, Check, Mic, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { toast } from "sonner";
import { PromptBuilderModal } from "@/components/PromptBuilderModal";
import { TaskFormContent, RepoUrlInput, deriveAlias, type Repo, type RepoTestState, type RepoHistory } from "@/components/TaskFormContent";
import type { AdvancedOptionField } from "@/components/AdvancedOptions";
import type { OutputType } from "@/components/OutputTypeSelector";
import { DEFAULT_PRIORITY, normalizePriority } from "@/lib/priority";
import { normalizeEffort } from "@/lib/effort";
import { normalizeToolAccess, type ToolAccessMap } from "@/lib/agent-tools";
import { getModelsForProviderType, DEFAULT_ASSISTANT_MODEL } from "@/lib/models";
import { useSpeechDictation } from "@/hooks/useSpeechDictation";
import { getAnalytics } from "@/components/WebAnalytics";
import { ReviewTaskForm } from "@/components/ReviewTaskForm";

import type { ChatMessage, ProposedTask, ChatbotLevel } from "@/lib/chat";
import type { TaskAttachment, TaskContextFile, AIProvider } from "@/lib/types";

async function saveSetting(key: string, value: string) {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error("Failed to save");
}

function ChatTab({ repoHistory, homePage }: { repoHistory: RepoHistory[]; homePage: string }) {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [proposedTask, setProposedTask] = useState<ProposedTask | null>(null);
  const [creating, setCreating] = useState(false);
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [model, setModel] = useState<string>(DEFAULT_ASSISTANT_MODEL);
  const [modelSelectValue, setModelSelectValue] = useState<string>(DEFAULT_ASSISTANT_MODEL);
  const [taskProviderId, setTaskProviderId] = useState<string>("");
  const [taskModel, setTaskModel] = useState<string>("");
  const [taskModelSelectValue, setTaskModelSelectValue] = useState<string>("");
  const [showGitInput, setShowGitInput] = useState(false);
  const [gitRepoUrl, setGitRepoUrl] = useState("");
  const [gitContext, setGitContext] = useState<string | null>(null);
  const [loadingContext, setLoadingContext] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [selectedRepoUrl, setSelectedRepoUrl] = useState<string | null>(null);
  const [chatbotLevel, setChatbotLevel] = useState<ChatbotLevel>("low");
  // "Push to main" doesn't literally mean the branch named "main" — it means "push directly
  // to whatever Settings > Git's default base branch is" (see worker/index.ts), so the review
  // card below needs the real value to avoid showing "main" when the configured default is
  // something else (e.g. "develop").
  const [defaultBaseBranch, setDefaultBaseBranch] = useState("main");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatStartedRef = useRef(false);

  const { isRecording, isSupported: isSpeechSupported, toggleRecording } = useSpeechDictation((transcript) => {
    setInput((prev) => prev ? `${prev} ${transcript}` : transcript);
  });

  const selectedProvider = providers.find((p) => p.id === selectedProviderId);

  // Dynamic model lists — fetched from the API (free, no tokens consumed)
  const [chatProviderModels, setChatProviderModels] = useState<{ id: string; label: string }[]>([]);
  const [taskProviderModels, setTaskProviderModels] = useState<{ id: string; label: string }[]>([]);

  // Helper: static fallback by provider type
  function staticModelsFallback(type?: string) {
    return getModelsForProviderType(type);
  }

  const modelList = chatProviderModels.length > 0
    ? chatProviderModels
    : staticModelsFallback(selectedProvider?.type);

  const taskModelList = taskProviderModels.length > 0
    ? taskProviderModels
    : staticModelsFallback(providers.find((p) => p.id === taskProviderId)?.type);

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
        if (settingsData.chat_assistant_level) {
          setChatbotLevel(settingsData.chat_assistant_level as ChatbotLevel);
        }
        if (settingsData.git_default_base_branch) {
          setDefaultBaseBranch(settingsData.git_default_base_branch);
        }
      })
      .catch(() => {});
  }, []);

  // Fetch live models for the chat provider
  useEffect(() => {
    if (!selectedProviderId) return;
    fetch(`/api/providers/${selectedProviderId}/models`)
      .then((r) => r.json())
      .then((d: { models: { id: string; label: string }[] }) => {
        if (d.models?.length) setChatProviderModels(d.models);
      })
      .catch(() => setChatProviderModels([]));
  }, [selectedProviderId]);

  // Fetch live models for the task provider
  useEffect(() => {
    if (!taskProviderId) return;
    fetch(`/api/providers/${taskProviderId}/models`)
      .then((r) => r.json())
      .then((d: { models: { id: string; label: string }[] }) => {
        if (d.models?.length) setTaskProviderModels(d.models);
      })
      .catch(() => setTaskProviderModels([]));
  }, [taskProviderId]);

  useEffect(() => {
    // Don't update welcome message once the conversation has started
    if (chatStartedRef.current) return;
    const welcomeMessage = chatbotLevel === "low"
      ? `What do you need done? Just describe it and I'll create the task right away.`
      : chatbotLevel === "medium"
      ? `Hi! Describe what you need and I'll put together a task. I may ask one quick follow-up if needed.`
      : `Hi! I'll help you create a task for the AI agent. To get started, it helps to know:\n\n1. **What should the agent do?** Describe the goal in plain language.\n2. **Which repository?** Paste a git URL if the task involves a codebase.\n3. **When should it run?** Immediately, at a specific time, or on a recurring schedule?\n\nYou don't need to answer all of these, just tell me what you have in mind.`;
    setMessages([{ role: "assistant", content: welcomeMessage }]);
  }, [chatbotLevel]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleModelChange(value: string | null) {
    if (!value) return;
    setModelSelectValue(value);
    if (value !== "custom") {
      setModel(value);
      void saveSetting("prompt_builder_model", value).catch(() => {});
    }
  }

  function handleTaskModelChange(value: string | null) {
    if (!value) return;
    setTaskModelSelectValue(value);
    if (value !== "custom") setTaskModel(value);
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

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;

    chatStartedRef.current = true;
    const newMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(newMessages);
    setInput("");
    setChatError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/tasks/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: newMessages,
          providerId: selectedProviderId || undefined,
          model: model || undefined,
          gitContext: gitContext || undefined,
          selectedRepoUrl: selectedRepoUrl || undefined,
          level: chatbotLevel,
        }),
      });
      if (!res.ok) {
        const err = await res.json() as { error: string };
        throw new Error(err.error || "Chat failed");
      }
      const data = await res.json() as { reply: string; proposedTask?: ProposedTask };
      setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
      if (data.proposedTask) {
        setProposedTask(data.proposedTask);
        // Seed task provider/model from the current chat selection on first proposal
        setTaskProviderId((prev) => prev || selectedProviderId);
        setTaskModel((prev) => prev || model);
        setTaskModelSelectValue((prev) => prev || model);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Chat failed";
      setChatError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  async function createTask() {
    if (!proposedTask) return;
    setCreating(true);
    try {
      const repos = (proposedTask.repos ?? [])
        .filter((r) => r.url)
        .map((r) => ({ url: r.url, alias: deriveAlias(r.url), branch: r.branch || undefined }));

      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: proposedTask.title,
          description: proposedTask.description,
          context: proposedTask.context || undefined,
          repos,
          scheduledFor: !proposedTask.isRecurring && proposedTask.scheduledFor ? proposedTask.scheduledFor : undefined,
          isRecurringTemplate: proposedTask.isRecurring ?? false,
          cronExpression: proposedTask.isRecurring ? proposedTask.cronExpression : undefined,
          maxRuns: proposedTask.isRecurring ? (proposedTask.maxRuns ?? null) : undefined,
          targetBranch: proposedTask.targetBranch || undefined,
          pushToMain: proposedTask.pushToMain ?? false,
          createPR: proposedTask.createPR ?? false,
          outputType: proposedTask.outputType || undefined,
          aiProviderId: taskProviderId || undefined,
          model: taskModel || undefined,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const created = await res.json() as { id: string; isRecurringTemplate?: boolean };
      getAnalytics()?.capture("task_created", {
        source: "chat",
        provider_mode: taskProviderId ? "pinned" : "default",
        uses_team: false,
        recurring: proposedTask.isRecurring ?? false,
        repo_count: repos.length,
        git_output: proposedTask.createPR ? "pr" : proposedTask.pushToMain ? "main" : proposedTask.targetBranch ? "target" : "branch",
      });
      toast.success("Task created");
      // If the homepage is the new-task page itself, navigate to the created task
      // so the form actually closes instead of staying on the same page.
      const destination = homePage === "/tasks/new"
        ? (created.isRecurringTemplate ? "/tasks" : `/tasks/${created.id}`)
        : homePage;
      router.push(destination);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create task");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="p-0">
          {/* Header — title + provider/model/repo controls */}
          <div className="flex flex-col gap-2 px-4 pt-3 pb-2 border-b border-border">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-sm">AI Chat</span>
              <span className="text-xs text-muted-foreground capitalize">{chatbotLevel} mode</span>
            </div>
            {providers.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                <Select value={selectedProviderId} onValueChange={(v) => { if (v) setSelectedProviderId(v); }}>
                  <SelectTrigger size="sm" className="w-36 h-7 text-xs">
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
                      <SelectItem key={m.id} value={m.id} className="text-xs">{m.label}</SelectItem>
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

            {/* Quick repo selection chips */}
            {repoHistory.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Quick repo select</span>
                <div className="flex flex-wrap gap-1.5">
                  {repoHistory.slice(0, 6).map((r) => (
                    <button
                      key={r.url}
                      type="button"
                      onClick={() => {
                        if (selectedRepoUrl === r.url) {
                          setSelectedRepoUrl(null);
                        } else {
                          setSelectedRepoUrl(r.url);
                        }
                      }}
                      className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border transition-colors ${
                        selectedRepoUrl === r.url
                          ? "border-primary/60 bg-primary/10 text-primary"
                          : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                      }`}
                      title={r.url}
                    >
                      {selectedRepoUrl === r.url && <Check size={10} />}
                      <GitBranch size={10} />
                      <span className="max-w-32 truncate">{r.alias}</span>
                    </button>
                  ))}
                  {selectedRepoUrl && (
                    <button
                      type="button"
                      onClick={() => setSelectedRepoUrl(null)}
                      className="flex items-center gap-1 text-xs px-2 py-1 rounded-full border border-border text-muted-foreground hover:text-foreground transition-colors"
                      title="Clear selected repo"
                    >
                      <X size={10} />
                      <span>Clear</span>
                    </button>
                  )}
                </div>
                {selectedRepoUrl && (
                  <p className="text-[10px] text-primary/80">
                    Using: <span className="font-mono">{selectedRepoUrl}</span>
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-col h-96 overflow-y-auto p-4 gap-3">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
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
          {chatError && (
            <div className="mx-3 mb-0 mt-2 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
              <svg xmlns="http://www.w3.org/2000/svg" className="mt-0.5 h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <span>{chatError}</span>
            </div>
          )}
          {/* Git context input */}
          {showGitInput && (
            <div className="border-t border-border px-3 py-2.5 bg-muted/30 flex flex-col gap-2">
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
              {contextError && <p className="text-xs text-red-500">{contextError}</p>}
            </div>
          )}

          <div className="border-t border-border p-3 flex gap-2 items-end">
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder={chatbotLevel === "low" ? "Describe your task and I'll create it immediately… (Enter to send)" : "Describe your task… (Enter to send, Shift+Enter for newline)"}
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
            <Button onClick={sendMessage} disabled={loading || !input.trim()} className="shrink-0">
              Send
            </Button>
          </div>
        </CardContent>
      </Card>

      {proposedTask && (
        <Card className="border-primary/50">
          <CardHeader>
            <CardTitle className="text-base">Proposed Task</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Title</span>
              <p className="mt-0.5 font-medium">{proposedTask.title}</p>
            </div>
            <div>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Description</span>
              <p className="mt-0.5 text-muted-foreground whitespace-pre-wrap">{proposedTask.description}</p>
            </div>
            {proposedTask.context && (
              <div>
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Context</span>
                <p className="mt-0.5 text-muted-foreground whitespace-pre-wrap">{proposedTask.context}</p>
              </div>
            )}
            {proposedTask.outputType && proposedTask.outputType !== "repository" && (
              <div>
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Output</span>
                <p className="mt-0.5 text-muted-foreground">
                  {proposedTask.outputType === "design" ? "Design mockups (viewable in Files)" : proposedTask.outputType === "result" ? "Result shown on the task page" : "File(s) in the Files section"}
                </p>
              </div>
            )}
            {proposedTask.repos && proposedTask.repos.length > 0 && (
              <div>
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Repositories</span>
                <ul className="mt-0.5 space-y-0.5">
                  {proposedTask.repos.map((r, i) => (
                    <li key={i} className="font-mono text-xs text-muted-foreground break-all">
                      {r.url}{r.branch ? <span className="text-muted-foreground/60"> @ {r.branch}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(proposedTask.targetBranch || proposedTask.pushToMain || proposedTask.createPR) && (
              <div>
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Git output</span>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {proposedTask.createPR ? "Create PR" : proposedTask.pushToMain ? `Push to ${defaultBaseBranch}` : proposedTask.targetBranch ? `Push to ${proposedTask.targetBranch}` : "New branch"}
                </p>
              </div>
            )}
            {proposedTask.isRecurring && proposedTask.cronExpression && (
              <div>
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Schedule</span>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {proposedTask.cronExpression} (recurring{proposedTask.maxRuns ? `, max ${proposedTask.maxRuns} runs` : ", unlimited runs"})
                </p>
              </div>
            )}
            {!proposedTask.isRecurring && proposedTask.scheduledFor && (
              <div>
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Scheduled For</span>
                <p className="mt-0.5 text-muted-foreground">{new Date(proposedTask.scheduledFor).toLocaleString()}</p>
              </div>
            )}
            <div className="flex flex-col gap-1.5 pt-1">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Run task with</span>
              <div className="flex items-center gap-2 flex-wrap">
                <Select value={taskProviderId} onValueChange={(v) => { if (v) setTaskProviderId(v); }}>
                  <SelectTrigger size="sm" className="w-36 h-7 text-xs">
                    <span className="flex-1 text-left truncate">
                      {providers.find((p) => p.id === taskProviderId)?.name ?? "Provider"}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id} label={p.name} className="text-xs">{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={taskModelSelectValue}
                  onValueChange={handleTaskModelChange}
                >
                  <SelectTrigger size="sm" className="w-44 h-7 text-xs">
                    <span className="flex-1 text-left truncate">
                      {taskModelList.find((m) => m.id === taskModelSelectValue)?.label
                        ?? (taskModelSelectValue === "custom" ? "Custom" : (taskModel || "Model"))}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {taskModelList.map((m) => (
                      <SelectItem key={m.id} value={m.id} className="text-xs">{m.label}</SelectItem>
                    ))}
                    <SelectItem value="custom" className="text-xs">Custom…</SelectItem>
                  </SelectContent>
                </Select>
                {taskModelSelectValue === "custom" && (
                  <Input
                    value={taskModel}
                    onChange={(e) => setTaskModel(e.target.value)}
                    placeholder="model-id"
                    className="h-7 text-xs w-36"
                  />
                )}
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <Button onClick={createTask} disabled={creating}>
                {creating ? "Creating…" : "Create Task"}
              </Button>
              <Button
                variant="outline"
                onClick={() => setProposedTask(null)}
                disabled={creating}
              >
                Keep chatting
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Link href={homePage} className={buttonVariants({ variant: "ghost" })}>Cancel</Link>
      </div>
    </div>
  );
}

const DRAFT_KEY = "new-task-draft";
const LAST_MODE_KEY = "new-task-last-mode";

interface DraftState {
  title: string;
  description: string;
  context: string;
  costBudget: string;
  labels: string[];
  tokenBudget: string;
  repos: Repo[];
  gitMode: "branch" | "target" | "main" | "pr";
  targetBranch: string;
  outputType: OutputType;
  priority: string;
  effort: string | null;
  toolAccess?: ToolAccessMap;
  aiProviderId: string | null;
  useSmartProvider: boolean;
  taskModel: string | null;
  contextFiles: TaskContextFile[];
  isRecurring: boolean;
  cronExpression: string;
  addToBacklog: boolean;
  createValidationTask: boolean;
  allowSubtasks?: boolean;
  systemPrompt: string | null;
  dependsOnTaskId: string | null;
  teamId: string | null;
}

function NewTaskPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromId = searchParams.get("from");
  const fromFileId = searchParams.get("fromFile");
  const fromFolderId = searchParams.get("fromFolder");
  // "review" = a review-only ticket (src/lib/review-only.ts) — straight into In Review, never run.
  const [tab, setTab] = useState<"chat" | "manual" | "review">(searchParams.get("mode") === "review" ? "review" : "chat");
  const [loading, setLoading] = useState(false);
  const [isRecurring, setIsRecurring] = useState(false);
  const [cronExpression, setCronExpression] = useState("");
  // "" == unlimited runs (the default). Kept as a string so the number input can be cleared.
  const [maxRuns, setMaxRuns] = useState("");
  const [addToBacklog, setAddToBacklog] = useState(false);
  const [subtaskPreview, setSubtaskPreview] = useState<Array<{ title: string; description: string; context: string; enabled: boolean }> | null>(null);
  const [gitMode, setGitMode] = useState<"branch" | "target" | "main" | "pr">("pr");
  const [targetBranch, setTargetBranch] = useState("");
  const [form, setForm] = useState({
    title: "",
    description: "",
    context: "",
    scheduledFor: "",
    tokenBudget: "",
    costBudget: "",
  });
  const [labels, setLabels] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<TaskAttachment[]>([]);
  const [attachmentsFolder, setAttachmentsFolder] = useState<string>("");
  const [contextFiles, setContextFiles] = useState<TaskContextFile[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repoTests, setRepoTests] = useState<Record<number, RepoTestState>>({});
  const [repoHistory, setRepoHistory] = useState<RepoHistory[]>([]);
  const [promptBuilderOpen, setPromptBuilderOpen] = useState(false);
  const [providerConfigured, setProviderConfigured] = useState<{ configured: boolean; reason: string; throttledUntil?: string | null; throttledProviderName?: string | null } | null>(null);
  const [aiProviderId, setAiProviderId] = useState<string | null>(null);
  const [useSmartProvider, setUseSmartProvider] = useState(false);
  const [taskModel, setTaskModel] = useState<string | null>(null);
  const [dependsOnTaskId, setDependsOnTaskId] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [priority, setPriority] = useState<string>(DEFAULT_PRIORITY);
  const [effort, setEffort] = useState<string | null>(null);
  // Explicit per-task tool grants/denials; tools left out follow Settings → Agent Tools.
  const [toolAccess, setToolAccess] = useState<ToolAccessMap>({});
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [createValidationTask, setCreateValidationTask] = useState(false);
  const [allowSubtasks, setAllowSubtasks] = useState(false);
  const [outputType, setOutputType] = useState<OutputType>("repository");
  const [draftRestored, setDraftRestored] = useState(false);
  const [fromFileName, setFromFileName] = useState<string | null>(null);
  const [fromFolderName, setFromFolderName] = useState<string | null>(null);
  const [homePage, setHomePage] = useState("/tasks");
  const [autoEnhanceDescription, setAutoEnhanceDescription] = useState(false);
  const [autoApplyPreviousRunSettings, setAutoApplyPreviousRunSettings] = useState(false);
  const [isEnhancing, setIsEnhancing] = useState(false);
  const draftSuppressedRef = useRef(false);
  // Advanced Options the user has edited by hand. A saved repo's defaults are
  // only allowed to fill in options that aren't in here, so picking a repo
  // never overwrites a deliberate choice.
  const touchedAdvancedRef = useRef<Set<AdvancedOptionField>>(new Set());
  // Same idea for the "After task completes" choice: once the user (or a
  // duplicated task / restored draft) has picked one, a repo's saved default
  // git mode no longer overrides it.
  const gitModeTouchedRef = useRef(false);
  // And for "Use a team": once the user has toggled it or picked a team, a
  // repo's saved default team no longer overrides it — and switching it off
  // is sent as an explicit `teamId: null` so POST /api/tasks doesn't put the
  // repo default straight back.
  const teamTouchedRef = useRef(false);
  const changeTeamId = (id: string | null) => {
    teamTouchedRef.current = true;
    setTeamId(id);
  };

  // Restore last-used tab mode from localStorage (runs before other effects so
  // provider-not-configured and draft-restore effects can still override it)
  useEffect(() => {
    if (fromId || fromFileId || fromFolderId) return; // cloning/seeding always uses manual (handled below)
    if (searchParams.get("mode") === "review") return;
    try {
      const saved = localStorage.getItem(LAST_MODE_KEY);
      if (saved === "chat" || saved === "manual") setTab(saved);
    } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    fetch("/api/settings/provider-configured")
      .then((r) => r.json())
      .then((data: { configured: boolean; reason: string; throttledUntil?: string | null; throttledProviderName?: string | null }) => {
        setProviderConfigured(data);
        // Chat mode needs a live provider to answer; a rate-limited one can't, even though the
        // task itself can still be created and left to queue.
        if (!data.configured || data.throttledUntil) setTab((t) => (t === "review" ? t : "manual"));
      })
      .catch(() => setProviderConfigured({ configured: true, reason: "" }));
  }, []);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (data.home_page && data.home_page !== "/") setHomePage(data.home_page);
        setAutoEnhanceDescription(data.auto_enhance_description === "true");
        setAutoApplyPreviousRunSettings(data.git_auto_apply_previous_run_settings === "true");
        // When the global Smart Provider Picker is enabled, default new tasks to it
        // (unless cloning an existing task, which carries its own provider selection).
        if (!fromId && !fromFileId && !fromFolderId && data.smart_provider_picker === "true") {
          setUseSmartProvider(true);
        }
        // Pre-fill the Effort field from the configured default (unless cloning an
        // existing task, which carries over its own effort override instead).
        if (!fromId && !fromFileId && !fromFolderId) {
          const defaultEffort = normalizeEffort(data.default_effort);
          if (defaultEffort) setEffort(defaultEffort);
        }
      })
      .catch(() => {});
  }, [fromId, fromFileId, fromFolderId]);

  // Restore draft from localStorage on mount (only when not cloning another task)
  useEffect(() => {
    if (fromId || fromFileId || fromFolderId) return;
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw) as DraftState;
      if (draft.title || draft.description) {
        setForm((f) => ({
          ...f,
          title: draft.title || f.title,
          description: draft.description || f.description,
          context: draft.context || f.context,
          costBudget: draft.costBudget || f.costBudget,
          tokenBudget: draft.tokenBudget || f.tokenBudget,
        }));
        if (draft.labels && draft.labels.length > 0) setLabels(draft.labels);
        if (draft.repos && draft.repos.length > 0) setRepos(draft.repos);
        if (draft.gitMode) {
          setGitMode(draft.gitMode);
          // "pr" is the form's initial value, so it says nothing about intent.
          if (draft.gitMode !== "pr") gitModeTouchedRef.current = true;
        }
        if (draft.targetBranch) setTargetBranch(draft.targetBranch);
        if (draft.outputType) setOutputType(draft.outputType);
        if (draft.priority) setPriority(normalizePriority(draft.priority));
        if (draft.effort) setEffort(normalizeEffort(draft.effort));
        if (draft.toolAccess) setToolAccess(normalizeToolAccess(draft.toolAccess));
        if (draft.aiProviderId) setAiProviderId(draft.aiProviderId);
        if (draft.useSmartProvider) setUseSmartProvider(draft.useSmartProvider);
        if (draft.taskModel) setTaskModel(draft.taskModel);
        if (draft.contextFiles && draft.contextFiles.length > 0) setContextFiles(draft.contextFiles);
        if (draft.isRecurring) setIsRecurring(draft.isRecurring);
        if (draft.cronExpression) setCronExpression(draft.cronExpression);
        if (draft.addToBacklog) setAddToBacklog(draft.addToBacklog);
        if (draft.createValidationTask) setCreateValidationTask(draft.createValidationTask);
        if (draft.allowSubtasks) setAllowSubtasks(draft.allowSubtasks);
        if (draft.systemPrompt) setSystemPrompt(draft.systemPrompt);
        if (draft.dependsOnTaskId) setDependsOnTaskId(draft.dependsOnTaskId);
        if (draft.teamId) {
          setTeamId(draft.teamId);
          teamTouchedRef.current = true;
        }
        setDraftRestored(true);
        setTab("manual");
      }
    } catch { /* ignore malformed draft */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save draft to localStorage whenever key form fields change
  useEffect(() => {
    if (fromId) return; // Don't auto-save when cloning (original task isn't lost)
    const isEmpty = !form.title && !form.description;
    if (isEmpty) {
      localStorage.removeItem(DRAFT_KEY);
      return;
    }
    const timeout = setTimeout(() => {
      if (draftSuppressedRef.current) return;
      const draft: DraftState = {
        title: form.title,
        description: form.description,
        context: form.context,
        costBudget: form.costBudget,
        tokenBudget: form.tokenBudget,
        labels,
        repos,
        gitMode,
        targetBranch,
        outputType,
        priority,
        effort,
        toolAccess,
        aiProviderId,
        useSmartProvider,
        taskModel,
        contextFiles,
        isRecurring,
        cronExpression,
        addToBacklog,
        createValidationTask,
        allowSubtasks,
        systemPrompt,
        dependsOnTaskId,
        teamId,
      };
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* ignore quota errors */ }
    }, 500);
    return () => clearTimeout(timeout);
  }, [
    form.title,
    form.description,
    form.context,
    form.costBudget,
    form.tokenBudget,
    labels,
    repos,
    gitMode,
    targetBranch,
    outputType,
    priority,
    effort,
    toolAccess,
    aiProviderId,
    useSmartProvider,
    taskModel,
    contextFiles,
    isRecurring,
    cronExpression,
    addToBacklog,
    createValidationTask,
    allowSubtasks,
    systemPrompt,
    dependsOnTaskId,
    teamId,
    fromId,
    fromFileId,
  ]);

  function refreshRepoHistory() {
    fetch("/api/repos")
      .then((r) => r.json())
      .then((data) => setRepoHistory(data as RepoHistory[]))
      .catch(() => {});
  }

  useEffect(() => {
    refreshRepoHistory();
  }, []);

  useEffect(() => {
    if (!fromId) return;
    fetch(`/api/tasks/${fromId}`)
      .then((r) => r.json())
      .then((task: { title: string; description: string; context?: string | null; repos?: { url: string; branch?: string | null }[]; cronExpression?: string | null; maxRuns?: number | null; isRecurringTemplate?: boolean; pushToMain?: boolean; targetBranch?: string | null; createPR?: boolean; aiProviderId?: string | null; useSmartProvider?: boolean; model?: string | null; tokenBudget?: number | null; costBudget?: number | null; contextFiles?: string | null; priority?: string | null; effort?: string | null; toolAccess?: string | null; allowSubtasks?: boolean }) => {
        setForm({
          title: task.title,
          description: task.description,
          context: task.context ?? "",
          scheduledFor: "",
          tokenBudget: task.tokenBudget ? String(task.tokenBudget) : "",
          costBudget: task.costBudget ? String(task.costBudget) : "",
        });
        if (task.repos && task.repos.length > 0) {
          setRepos(task.repos.map((r) => ({ url: r.url, branch: r.branch ?? undefined })));
        }
        if (task.isRecurringTemplate && task.cronExpression) {
          setIsRecurring(true);
          setCronExpression(task.cronExpression);
          // Copy the run cap too, but the clone starts its own count from zero.
          setMaxRuns(task.maxRuns ? String(task.maxRuns) : "");
        }
        if (task.targetBranch) { setGitMode("target"); setTargetBranch(task.targetBranch); }
        else if (task.pushToMain) setGitMode("main");
        else if (task.createPR) setGitMode("pr");
        gitModeTouchedRef.current = true;
        setUseSmartProvider(Boolean(task.useSmartProvider));
        setAiProviderId(task.aiProviderId ?? null);
        setTaskModel(task.model ?? null);
        setPriority(normalizePriority(task.priority));
        setEffort(normalizeEffort(task.effort));
        setToolAccess(normalizeToolAccess(task.toolAccess));
        setAllowSubtasks(Boolean(task.allowSubtasks));
        // Carry over context-file selection when cloning
        if (task.contextFiles) {
          try {
            const parsed = JSON.parse(task.contextFiles) as TaskContextFile[];
            if (Array.isArray(parsed)) setContextFiles(parsed);
          } catch { /* ignore */ }
        }
        setTab("manual");
      })
      .catch(() => {});
  }, [fromId]);

  // Seed a new task from an uploaded file's contents, e.g. "do what this file recommends".
  useEffect(() => {
    if (!fromFileId) return;
    fetch(`/api/files/${fromFileId}`)
      .then((r) => r.json())
      .then((file: { name: string; content: string | null; isFolder: boolean }) => {
        if (file.isFolder || file.content === null) return;
        const baseName = file.name.replace(/\.[^./]+$/, "");
        setForm((f) => ({
          ...f,
          title: baseName,
          context: file.content ?? "",
        }));
        setFromFileName(file.name);
        setTab("manual");
      })
      .catch(() => {});
  }, [fromFileId]);

  // Seed a new task from a Files folder, e.g. "implement these design mockups".
  // The endpoint lists the folder's files, inlines text contents, and
  // materializes any images as task attachments so the agent can view them.
  useEffect(() => {
    if (!fromFolderId) return;
    fetch(`/api/files/${fromFolderId}/task-seed`)
      .then(async (r) => {
        if (!r.ok) {
          const err = await r.json().catch(() => ({})) as { error?: string };
          throw new Error(err.error || "Failed to load folder");
        }
        return r.json() as Promise<{
          folderName: string;
          context: string;
          attachments: TaskAttachment[];
          attachmentsFolder: string;
        }>;
      })
      .then((seed) => {
        setForm((f) => ({
          ...f,
          title: f.title || `Implement ${seed.folderName}`,
          context: seed.context ?? "",
        }));
        if (seed.attachments && seed.attachments.length > 0) {
          setAttachments(seed.attachments);
          if (seed.attachmentsFolder) setAttachmentsFolder(seed.attachmentsFolder);
        }
        setFromFolderName(seed.folderName);
        setTab("manual");
      })
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Failed to load folder");
      });
  }, [fromFolderId]);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const addRepo = () => setRepos((r) => [...r, { url: "" }]);
  const removeRepo = (i: number) => {
    setRepos((r) => r.filter((_, idx) => idx !== i));
    setRepoTests((t) => {
      const next: Record<number, RepoTestState> = {};
      Object.entries(t).forEach(([k, v]) => {
        const idx = Number(k);
        if (idx < i) next[idx] = v;
        else if (idx > i) next[idx - 1] = v;
      });
      return next;
    });
  };
  const setRepo = (i: number, v: string) => {
    setRepos((r) => r.map((repo, idx) => (idx === i ? { ...repo, url: v } : repo)));
    setRepoTests((t) => ({ ...t, [i]: { status: "idle", output: "" } }));
  };
  const setRepoBranch = (i: number, branch: string) => {
    setRepos((r) => r.map((repo, idx) => (idx === i ? { ...repo, branch: branch || undefined } : repo)));
  };

  // When a repo is picked from the history dropdown, only fill in the URL —
  // remembered settings are applied separately (see applyPreviousRunSettings)
  // via an explicit "Use previous run settings" button, so picking a repo
  // never silently overrides settings the user already chose.
  function selectRepoFromHistory(i: number, entry: RepoHistory) {
    setRepos((r) => r.map((repo, idx) => (idx === i ? { ...repo, url: entry.url } : repo)));
    // When "Auto-apply previous run settings" is enabled globally (Settings →
    // Git), skip the extra "Use previous run settings" click and apply the
    // remembered branch / "after task completes" defaults right away.
    if (autoApplyPreviousRunSettings) applyPreviousRunSettings(i, entry);
    // Applied after the previous-run settings so a repo's *saved* default
    // branch / git mode (configured deliberately on the Repositories page)
    // beats whatever happened to be used last time.
    applyRepoDefaults(entry, i);
  }

  /**
   * Decide what to send for an advanced option that currently has no value.
   *
   * POST /api/tasks fills omitted options in from the repo's saved defaults, so
   * an option the user deliberately cleared has to go over the wire as an
   * explicit `null` — otherwise the repo default would come straight back. An
   * option they never touched is omitted, which is what lets the default apply.
   */
  function clearedIfTouched<T>(field: AdvancedOptionField, value: T | undefined): T | null | undefined {
    if (value !== undefined) return value;
    return touchedAdvancedRef.current.has(field) ? null : undefined;
  }

  /**
   * Prefill this form from the Advanced Options defaults saved for a repo on
   * the Repositories page.
   *
   * A default is only applied when the user hasn't touched that option by hand
   * (tracked in touchedAdvancedRef): an explicit choice always beats a repo
   * default, including when a second repo is added afterwards. Defaults from an
   * earlier repo are *not* protected, so the most recently picked repo wins
   * when two repos both set the same option.
   */
  function applyRepoDefaults(entry: RepoHistory, i: number) {
    const untouched = (field: AdvancedOptionField) => !touchedAdvancedRef.current.has(field);

    // Git defaults. The branch is per repo row, so it's set on the row that was
    // just picked. The "after task completes" mode is deferred to a macrotask
    // for the same reason as in applyPreviousRunSettings (TaskFormContent's
    // branch → target-branch sync effect would otherwise clobber it).
    if (entry.defaultBranch) {
      setRepos((r) => r.map((repo, idx) => (idx === i ? { ...repo, branch: entry.defaultBranch } : repo)));
    }
    if (entry.defaultGitMode && !gitModeTouchedRef.current) {
      const mode = entry.defaultGitMode;
      setTimeout(() => {
        setGitMode(mode);
        setTargetBranch(mode === "target" ? (entry.defaultTargetBranch ?? "") : "");
      }, 0);
    }

    // Context is the one field the user types into directly, so "has the user
    // written anything?" is a better signal than the touched set alone.
    if (entry.defaultContext?.trim() && untouched("context")) {
      setForm((f) => (f.context.trim() ? f : { ...f, context: entry.defaultContext!.trim() }));
    }
    if (entry.defaultPriority && untouched("priority")) setPriority(entry.defaultPriority);
    if (entry.defaultEffort && untouched("effort")) setEffort(entry.defaultEffort);
    if (entry.defaultCostBudget != null && untouched("costBudget")) {
      setForm((f) => ({ ...f, costBudget: String(entry.defaultCostBudget) }));
    }
    if (entry.defaultTokenBudget != null && untouched("tokenBudget")) {
      setForm((f) => ({ ...f, tokenBudget: String(entry.defaultTokenBudget) }));
    }
    // The provider select is auto-populated with the configured default on
    // mount, which isn't a user choice — so this checks the touched set only.
    if (untouched("aiProviderId")) {
      if (entry.defaultUseSmartProvider) {
        setUseSmartProvider(true);
        setAiProviderId(null);
      } else if (entry.defaultAiProviderId) {
        setUseSmartProvider(false);
        setAiProviderId(entry.defaultAiProviderId);
      }
    }
    if (entry.defaultModel && untouched("model")) setTaskModel(entry.defaultModel);
    if (entry.defaultLabels?.length && untouched("labels")) {
      // Merged rather than replaced: labels from a second repo add to the first
      // repo's, the same way the task ends up spanning both repos.
      setLabels((current) => Array.from(new Set([...current, ...entry.defaultLabels!])));
    }
    if (entry.defaultCreateValidationTask && untouched("createValidationTask")) {
      setCreateValidationTask(true);
    }
    if (entry.defaultAllowSubtasks && untouched("allowSubtasks")) {
      setAllowSubtasks(true);
    }
    // Default team: switches "Use a team" on with the repo's team, unless the
    // user already chose (or turned off) a team for this task.
    if (entry.defaultTeamId && !teamTouchedRef.current) setTeamId(entry.defaultTeamId);
  }

  // Fired by the "Use previous run settings" button: prepopulate the branch
  // the repo was last cloned at and the "after task completes" setting last
  // used with it (create PR / push to main / push to a target branch / plain
  // agent branch). Deferred to a macrotask so it runs after TaskFormContent's
  // own effect that auto-syncs targetBranch from the repo's clone branch
  // (otherwise that effect would clobber the remembered target branch right
  // after we set it).
  function applyPreviousRunSettings(i: number, entry: RepoHistory) {
    setRepos((r) => r.map((repo, idx) => (idx === i ? { ...repo, branch: entry.lastBranch ?? repo.branch } : repo)));
    if (!entry.lastGitMode) return;
    setTimeout(() => {
      setGitMode(entry.lastGitMode!);
      setTargetBranch(entry.lastGitMode === "target" ? (entry.lastTargetBranch ?? "") : "");
    }, 0);
  }

  async function testRepo(i: number, url: string) {
    setRepoTests((t) => ({ ...t, [i]: { status: "testing", output: "" } }));
    try {
      const res = await fetch("/api/git/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json() as { ok: boolean; output: string };
      setRepoTests((t) => ({
        ...t,
        [i]: { status: data.ok ? "ok" : "error", output: data.output },
      }));
    } catch (err) {
      setRepoTests((t) => ({
        ...t,
        [i]: { status: "error", output: err instanceof Error ? err.message : "Request failed" },
      }));
    }
  }

  async function handleCreateSubtasks(subtasks: Array<{ title: string; description: string; context: string; enabled: boolean }>) {
    if (providerConfigured && !providerConfigured.configured) {
      throw new Error(providerConfigured.reason || "Configure an AI provider in Settings → AI first");
    }
    const filteredRepos = repos.filter((r) => r.url).map((r) => ({
      url: r.url,
      alias: deriveAlias(r.url),
      branch: r.branch || undefined,
    }));
    let previousId: string | null = null;
    for (const subtask of subtasks) {
      // Merge parent additional instructions with the AI-generated subtask context so
      // user-specified constraints apply to every subtask.
      const mergedContext = [form.context.trim(), subtask.context.trim()]
        .filter(Boolean)
        .join("\n\n") || undefined;

      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: subtask.title,
          description: subtask.description,
          context: mergedContext,
          repos: filteredRepos,
          pushToMain: gitMode === "main",
          targetBranch: gitMode === "target" ? targetBranch.trim() : null,
          createPR: gitMode === "pr",
          isEnabled: subtask.enabled,
          aiProviderId: aiProviderId || undefined,
          model: taskModel || undefined,
          dependsOnTaskId: previousId || undefined,
          outputType,
          priority,
          effort,
          toolAccess,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const created = await res.json() as { id: string };
      previousId = created.id;
    }
    draftSuppressedRef.current = true;
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
    getAnalytics()?.capture("task_created", {
      source: "subtasks",
      count: subtasks.length,
      provider_mode: aiProviderId ? "pinned" : "default",
      uses_team: false,
      recurring: false,
      repo_count: filteredRepos.length,
      git_output: gitMode,
      priority,
      effort,
    });
    toast.success(`Created ${subtasks.length} linked subtasks`);
    // If the homepage is the new-task page itself, navigate to /tasks so the form closes.
    router.push(homePage === "/tasks/new" ? "/tasks" : homePage);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (providerConfigured && !providerConfigured.configured) {
      toast.error(providerConfigured.reason || "Configure an AI provider in Settings → AI first");
      return;
    }
    if (!form.description.trim()) {
      toast.error("Please enter a description");
      return;
    }
    if (gitMode === "target" && !targetBranch.trim()) {
      toast.error("Enter a branch name");
      return;
    }
    if (outputType === "repository" && repos.filter((r) => r.url.trim()).length === 0) {
      toast.error("Add at least one Git repository, it's required for \"Commit to repository\" tasks");
      return;
    }
    setLoading(true);
    try {
      // If the task was split into subtasks, create those instead of a single task —
      // the "Split into subtasks" preview no longer has its own create button, so this
      // is the only path that turns the preview into real tasks.
      if (subtaskPreview && subtaskPreview.length >= 2) {
        await handleCreateSubtasks(subtaskPreview);
        return;
      }

      // Auto-generate title from description if none was provided
      let finalTitle = form.title.trim();
      if (!finalTitle && form.description.trim()) {
        try {
          const suggestRes = await fetch("/api/tasks/suggest-title", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ description: form.description, context: form.context || undefined, providerId: aiProviderId || undefined }),
          });
          const suggestData = await suggestRes.json() as { title?: string };
          if (suggestData.title) {
            finalTitle = suggestData.title;
            set("title", finalTitle);
          }
        } catch { /* fall back to truncated description */ }
      }
      // Fallback: use first 80 chars of description if still no title
      if (!finalTitle) finalTitle = form.description.slice(0, 80);

      // Auto-enhance description if the setting is enabled
      let finalDescription = form.description;
      if (autoEnhanceDescription && form.description.trim()) {
        setIsEnhancing(true);
        try {
          const enhanceRes = await fetch("/api/tasks/enhance-description", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: finalTitle, description: form.description, providerId: aiProviderId || undefined }),
          });
          const enhanceData = await enhanceRes.json() as { description?: string };
          if (enhanceData.description) {
            finalDescription = enhanceData.description;
            set("description", finalDescription);
          }
        } catch { /* fall back to original description */ } finally {
          setIsEnhancing(false);
        }
      }
      // Fallback: use first 80 chars of description if still no title
      if (!finalTitle) finalTitle = form.description.slice(0, 80);

      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          title: finalTitle,
          description: finalDescription,
          context: form.context || undefined,
          tokenBudget: clearedIfTouched("tokenBudget", form.tokenBudget ? parseInt(form.tokenBudget, 10) : undefined),
          costBudget: clearedIfTouched("costBudget", form.costBudget ? parseFloat(form.costBudget) : undefined),
          attachments: attachments.length > 0 ? attachments : undefined,
          attachmentsFolder: attachmentsFolder.trim() || undefined,
          contextFiles: contextFiles.length > 0 ? contextFiles : undefined,
          labels: clearedIfTouched("labels", labels.length > 0 ? labels : undefined),
          scheduledFor: !isRecurring && form.scheduledFor ? new Date(form.scheduledFor).toISOString() : undefined,
          isRecurringTemplate: isRecurring,
          cronExpression: isRecurring ? cronExpression : undefined,
          maxRuns: isRecurring ? (maxRuns.trim() || null) : undefined,
          pushToMain: gitMode === "main",
          targetBranch: gitMode === "target" ? targetBranch.trim() : null,
          createPR: gitMode === "pr",
          isEnabled: !addToBacklog,
          aiProviderId: useSmartProvider ? null : clearedIfTouched("aiProviderId", aiProviderId || undefined),
          useSmartProvider: useSmartProvider || undefined,
          model: clearedIfTouched("model", taskModel || undefined),
          dependsOnTaskId: dependsOnTaskId || undefined,
          teamId: teamId || (teamTouchedRef.current ? null : undefined),
          priority,
          effort: clearedIfTouched("effort", effort || undefined),
          toolAccess,
          systemPrompt: systemPrompt || undefined,
          createValidationTask: clearedIfTouched("createValidationTask", createValidationTask || undefined),
          allowSubtasks: clearedIfTouched("allowSubtasks", allowSubtasks || undefined),
          outputType,
          repos: repos.filter((r) => r.url).map((r) => ({ url: r.url, alias: deriveAlias(r.url), branch: r.branch || undefined })),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const created = await res.json() as { id: string; isRecurringTemplate?: boolean };
      draftSuppressedRef.current = true;
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      getAnalytics()?.capture("task_created", {
        source: "form",
        provider_mode: useSmartProvider ? "smart" : aiProviderId ? "pinned" : "default",
        uses_team: Boolean(teamId),
        recurring: isRecurring,
        repo_count: repos.filter((r) => r.url).length,
        git_output: gitMode,
        priority,
        effort,
        backlog: addToBacklog,
      });
      toast.success("Task created");
      // If the homepage is the new-task page itself, navigate to the created task
      // (or /tasks for recurring templates) so the form actually closes.
      const destination = homePage === "/tasks/new"
        ? (isRecurring ? "/tasks" : `/tasks/${created.id}`)
        : homePage;
      router.push(destination);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create task");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">New Task</h1>

      {tab !== "review" && providerConfigured && !providerConfigured.configured && (
        <div className="mb-6 rounded-lg border border-yellow-600/50 bg-yellow-600/10 px-4 py-3 text-sm text-yellow-400">
          <strong>AI provider not configured.</strong>{" "}
          {providerConfigured.reason}{" "}
          <a href="/settings/ai" className="underline hover:text-yellow-300">Go to AI settings →</a>
        </div>
      )}

      {tab !== "review" && providerConfigured?.configured && providerConfigured.throttledUntil && (
        <div className="mb-6 rounded-lg border border-blue-600/50 bg-blue-600/10 px-4 py-3 text-sm text-blue-400">
          <strong>All providers are rate-limited.</strong>{" "}
          You can still create this task — it will queue and start automatically when{" "}
          {providerConfigured.throttledProviderName ?? "the provider"} resets at{" "}
          {new Date(providerConfigured.throttledUntil).toLocaleString()}.
        </div>
      )}

      {fromFileName && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-sky-500/40 bg-sky-500/10 px-4 py-2.5 text-sm text-sky-400">
          <span>✦ Using &quot;{fromFileName}&quot; as context.</span>
          <button
            type="button"
            className="ml-4 text-sky-400/60 hover:text-sky-400 text-xs"
            onClick={() => setFromFileName(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {fromFolderName && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-sky-500/40 bg-sky-500/10 px-4 py-2.5 text-sm text-sky-400">
          <span>✦ Using files from the &quot;{fromFolderName}&quot; folder as context.</span>
          <button
            type="button"
            className="ml-4 text-sky-400/60 hover:text-sky-400 text-xs"
            onClick={() => setFromFolderName(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      {draftRestored && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-sky-500/40 bg-sky-500/10 px-4 py-2.5 text-sm text-sky-400">
          <span>✦ Draft restored from your last session.</span>
          <button
            type="button"
            className="ml-4 text-sky-400/60 hover:text-sky-400 text-xs"
            onClick={() => {
              setDraftRestored(false);
              setForm({ title: "", description: "", context: "", scheduledFor: "", tokenBudget: "", costBudget: "" });
              setLabels([]);
              setRepos([]);
              setGitMode("pr");
              gitModeTouchedRef.current = false;
              setTargetBranch("");
              setOutputType("repository");
              setPriority(DEFAULT_PRIORITY);
              setEffort(null);
              setToolAccess({});
              setAiProviderId(null);
              setUseSmartProvider(false);
              setTaskModel(null);
              setContextFiles([]);
              setIsRecurring(false);
              setCronExpression("");
              setAddToBacklog(false);
              setCreateValidationTask(false);
              setAllowSubtasks(false);
              setSystemPrompt(null);
              setDependsOnTaskId(null);
              setTeamId(null);
              teamTouchedRef.current = false;
              try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
            }}
          >
            Discard draft
          </button>
        </div>
      )}

      <div className="flex gap-1 mb-6 bg-muted rounded-lg p-1 w-full sm:w-fit">
        <button
          onClick={() => {
            if (providerConfigured && !providerConfigured.configured) {
              toast.error(providerConfigured.reason || "Configure an AI provider in Settings → AI first");
              return;
            }
            setTab("chat");
            try { localStorage.setItem(LAST_MODE_KEY, "chat"); } catch { /* ignore */ }
          }}
          className={`flex-1 sm:flex-none px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            tab === "chat"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Chat
        </button>
        <button
          onClick={() => {
            setTab("manual");
            try { localStorage.setItem(LAST_MODE_KEY, "manual"); } catch { /* ignore */ }
          }}
          className={`flex-1 sm:flex-none px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            tab === "manual"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Manual
        </button>
        <button
          type="button"
          onClick={() => setTab("review")}
          title="A reminder to review work done elsewhere: goes straight to In Review and never runs an agent"
          className={`flex-1 sm:flex-none px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            tab === "review"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Review only
        </button>
      </div>

      {tab === "review" && (
        <ReviewTaskForm mode="create" cancelHref={homePage} />
      )}

      <div className={tab !== "chat" ? "hidden" : ""}>
        <ChatTab repoHistory={repoHistory} homePage={homePage} />
      </div>

      <form onSubmit={handleSubmit} className={`flex flex-col gap-6 ${tab !== "manual" ? "hidden" : ""}`}>
          <TaskFormContent
            title={form.title}
            description={form.description}
            context={form.context}
            isRecurring={isRecurring}
            cronExpression={cronExpression}
            maxRuns={maxRuns}
            scheduledFor={form.scheduledFor}
            tokenBudget={form.tokenBudget}
            costBudget={form.costBudget}
            attachments={attachments}
            attachmentsFolder={attachmentsFolder}
            contextFiles={contextFiles}
            gitMode={gitMode}
            targetBranch={targetBranch}
            repos={repos}
            repoTests={repoTests}
            repoHistory={repoHistory}
            addToBacklog={addToBacklog}
            onChange={set}
            onIsRecurringChange={setIsRecurring}
            onCronExpressionChange={setCronExpression}
            onMaxRunsChange={setMaxRuns}
            onGitModeChange={setGitMode}
            onGitModeTouched={() => { gitModeTouchedRef.current = true; }}
            onTargetBranchChange={setTargetBranch}
            onAddToBacklogChange={setAddToBacklog}
            onAddRepo={addRepo}
            onRemoveRepo={removeRepo}
            onSetRepo={setRepo}
            onSetRepoBranch={setRepoBranch}
            onTestRepo={testRepo}
            onSelectRepoHistory={selectRepoFromHistory}
            onApplyRepoHistory={applyPreviousRunSettings}
            onAttachmentsChange={setAttachments}
            onAttachmentsFolderChange={setAttachmentsFolder}
            onContextFilesChange={setContextFiles}
            labels={labels}
            onLabelsChange={setLabels}
            showRecurringToggle={true}
            showTokenBudget={false}
            showCostBudget={true}
            showScheduleAsToggle={true}
            onOpenPromptBuilder={() => setPromptBuilderOpen(true)}
            providerConfigured={providerConfigured}
            aiProviderId={aiProviderId}
            onAiProviderIdChange={setAiProviderId}
            useSmartProvider={useSmartProvider}
            onUseSmartProviderChange={setUseSmartProvider}
            taskModel={taskModel}
            onTaskModelChange={setTaskModel}
            dependsOnTaskId={dependsOnTaskId}
            onDependsOnTaskIdChange={setDependsOnTaskId}
            teamId={teamId}
            onTeamIdChange={changeTeamId}
            priority={priority}
            onPriorityChange={setPriority}
            effort={effort}
            onEffortChange={setEffort}
            toolAccess={toolAccess}
            onToolAccessChange={setToolAccess}
            onSubtaskPreviewChange={setSubtaskPreview}
            systemPrompt={systemPrompt}
            onSystemPromptChange={setSystemPrompt}
            createValidationTask={createValidationTask}
            onCreateValidationTaskChange={setCreateValidationTask}
            allowSubtasks={allowSubtasks}
            onAllowSubtasksChange={setAllowSubtasks}
            onRepoHistoryRefresh={refreshRepoHistory}
            onAdvancedFieldTouched={(field) => touchedAdvancedRef.current.add(field)}
            outputType={outputType}
            onOutputTypeChange={setOutputType}
            autoEnhanceDescription={autoEnhanceDescription}
            isEnhancing={isEnhancing}
          />
          <div className="flex gap-3 justify-end">
            <Link href={homePage} className={buttonVariants({ variant: "ghost" })}>Cancel</Link>
            <Button type="submit" disabled={loading || isEnhancing}>
              {isEnhancing
                ? "Enhancing..."
                : loading
                  ? "Creating..."
                  : subtaskPreview && subtaskPreview.length >= 2
                    ? `Create ${subtaskPreview.length} subtasks`
                    : addToBacklog ? "Add to Backlog" : "Create Task"}
            </Button>
          </div>
        </form>

      {promptBuilderOpen && (
        <PromptBuilderModal
          initialDescription={form.description}
          repoHistory={repoHistory}
          onUsePrompt={(prompt) => {
            const previousDescription = form.description;
            set("description", prompt);
            setPromptBuilderOpen(false);
            toast.success("Prompt applied", {
              action: {
                label: "Undo",
                onClick: () => set("description", previousDescription),
              },
            });
          }}
          onClose={() => setPromptBuilderOpen(false)}
        />
      )}
    </div>
  );
}

export default function NewTaskPage() {
  return (
    <Suspense>
      <NewTaskPageContent />
    </Suspense>
  );
}
