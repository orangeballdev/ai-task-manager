"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ChevronDown, ChevronRight, Download, Search, X } from "lucide-react";
import { TASK_MESSAGE_SENT_EVENT, type TaskMessageSentDetail } from "@/components/TaskComposer";
import { TEAM_MEMBER_FILTER_EVENT, type TeamMemberFilterDetail } from "@/components/TeamProgressTracker";

interface LogEntry {
  id: string;
  content: string;
  level: string;
  /** Team member (pipeline stage) that produced the line — null outside team runs. */
  member?: string | null;
  createdAt: string;
}

// Stable per-member colour so each team member's lines are easy to tell apart.
const MEMBER_COLORS = [
  "bg-violet-500/15 text-violet-400 border-violet-500/30",
  "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  "bg-sky-500/15 text-sky-400 border-sky-500/30",
  "bg-amber-500/15 text-amber-400 border-amber-500/30",
  "bg-pink-500/15 text-pink-400 border-pink-500/30",
  "bg-teal-500/15 text-teal-400 border-teal-500/30",
];

function memberColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return MEMBER_COLORS[Math.abs(h) % MEMBER_COLORS.length];
}

function MemberPrefix({ member, compact }: { member?: string | null; compact?: boolean }) {
  if (!member) return null;
  if (compact) {
    // Inline in the monospace error/system lines.
    return <span className="text-violet-400 mr-2 select-none">[{member}]</span>;
  }
  return (
    <span className={`inline-flex items-center self-start rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${memberColor(member)}`}>
      {member}
    </span>
  );
}

interface Turn {
  userMessage: string | null;
  logs: LogEntry[];
}

const TERMINAL_STATUSES = new Set(["completed", "no_changes", "failed", "killed", "timedout"]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function HighlightText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegex(query)})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="bg-yellow-400/30 text-yellow-200 rounded px-0.5">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function segmentIntoTurns(logs: LogEntry[]): Turn[] {
  const turns: Turn[] = [];
  let currentLogs: LogEntry[] = [];
  let currentUserMsg: string | null = null;

  for (const log of logs) {
    if (log.level === "user") {
      turns.push({ userMessage: currentUserMsg, logs: currentLogs });
      currentUserMsg = log.content;
      currentLogs = [];
    } else {
      currentLogs.push(log);
    }
  }
  turns.push({ userMessage: currentUserMsg, logs: currentLogs });
  return turns.filter((t) => t.userMessage !== null || t.logs.length > 0);
}

function LoadingDots() {
  return (
    <span className="flex gap-1">
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
    </span>
  );
}

function AgentTurn({ logs, isStreaming, searchQuery, filterMode = "all" }: { logs: LogEntry[]; isStreaming?: boolean; searchQuery?: string; filterMode?: FilterMode }) {
  const infoLogs = logs.filter((l) => l.level === "info");
  const systemLogs = logs.filter((l) => l.level === "system");
  const errorLogs = logs.filter((l) => l.level === "error");

  // Each tab shows ONLY its own category. "All" shows everything. This is the
  // core fix: previously the tabs filtered whole turns but every turn still
  // rendered every log type, so lines showed up under the wrong tab.
  const showInfo = filterMode === "all" || filterMode === "ai";
  const showSystem = filterMode === "all" || filterMode === "system";
  const showError = filterMode === "all" || filterMode === "errors";

  const visibleInfo = showInfo ? infoLogs : [];
  const visibleError = showError ? errorLogs : [];
  const visibleSystem = showSystem ? systemLogs : [];

  // System events are noisy, so collapse them by default — but expand
  // automatically when the System tab is active (that's what the user asked for).
  const [detailsOpen, setDetailsOpen] = useState(filterMode === "system");
  const [detailsFilterMode, setDetailsFilterMode] = useState(filterMode);
  if (detailsFilterMode !== filterMode) {
    setDetailsFilterMode(filterMode);
    setDetailsOpen(filterMode === "system");
  }

  if (isStreaming && logs.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoadingDots />
        Responding…
      </div>
    );
  }

  const hasVisible = visibleInfo.length > 0 || visibleError.length > 0 || visibleSystem.length > 0;

  // Nothing to render for the active tab (e.g. a user-message-only turn under
  // the Errors tab). Stay quiet rather than showing a misleading "(no output)";
  // only "All" should ever surface a genuinely empty turn.
  if (!hasVisible && !isStreaming) {
    if (filterMode !== "all") return null;
    return (
      <div className="bg-muted rounded-2xl rounded-tl-sm px-4 py-3 text-sm text-muted-foreground italic">
        (no output)
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5 max-w-[85%]">
      {visibleInfo.map((log) => (
        <div key={log.id} className="flex flex-col gap-0.5">
          <MemberPrefix member={log.member} />
          <div className="bg-muted rounded-2xl rounded-tl-sm px-4 py-3 text-sm text-foreground whitespace-pre-wrap break-words">
            {searchQuery ? <HighlightText text={log.content} query={searchQuery} /> : log.content}
          </div>
          <span className="text-xs text-muted-foreground px-1">{formatTimestamp(log.createdAt)}</span>
        </div>
      ))}
      {isStreaming && visibleInfo.length > 0 && (
        <div className="flex gap-1 pl-1">
          <LoadingDots />
        </div>
      )}
      {/* Errors get their own always-visible, high-visibility treatment.
          Previously they were buried inside the collapsed "system events" list. */}
      {visibleError.length > 0 && (
        <div className="flex flex-col gap-1">
          {visibleError.map((log) => (
            <div
              key={log.id}
              className="bg-red-950/40 border border-red-900/50 rounded-lg px-3 py-2 font-mono text-xs text-red-300 whitespace-pre-wrap break-all"
            >
              <span className="text-red-500/70 mr-2 select-none">{formatTimestamp(log.createdAt)}</span>
              <MemberPrefix member={log.member} compact />
              {searchQuery ? <HighlightText text={log.content} query={searchQuery} /> : log.content}
            </div>
          ))}
        </div>
      )}
      {visibleSystem.length > 0 && (
        <div>
          <button
            onClick={() => setDetailsOpen((o) => !o)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {detailsOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            {visibleSystem.length} system event{visibleSystem.length !== 1 ? "s" : ""}
          </button>
          {detailsOpen && (
            <div className="mt-1 bg-zinc-950 border border-zinc-800 rounded-lg p-3 font-mono text-xs space-y-0.5">
              {visibleSystem.map((log) => (
                <div key={log.id} className="whitespace-pre-wrap break-all text-blue-400">
                  <span className="text-zinc-500 mr-2 select-none">{formatTimestamp(log.createdAt)}</span>
                  <MemberPrefix member={log.member} compact />
                  {searchQuery ? <HighlightText text={log.content} query={searchQuery} /> : log.content}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

type FilterMode = "all" | "ai" | "system" | "errors";

const FILTER_LABELS: Record<FilterMode, string> = {
  all: "All",
  ai: "AI",
  system: "System",
  errors: "Errors",
};

export function LogViewer({ taskId, initialStatus }: { taskId: string; initialStatus: string }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [done, setDone] = useState(TERMINAL_STATUSES.has(initialStatus));
  // A status change from the server (e.g. a rerun) re-derives `done`. Adjusted
  // during render so the SSE effect below sees the new value straight away.
  const [syncedStatus, setSyncedStatus] = useState(initialStatus);
  if (syncedStatus !== initialStatus) {
    setSyncedStatus(initialStatus);
    setDone(TERMINAL_STATUSES.has(initialStatus));
    // Never clear logs — keep full history across reruns
  }
  const [connected, setConnected] = useState(false);
  // Default to AI-only: system/debug events are useful when digging into a
  // problem but add noise for day-to-day monitoring.
  const [filterMode, setFilterMode] = useState<FilterMode>("ai");
  const [logSearch, setLogSearch] = useState("");
  // Team runs: show only one member's lines (set from the dropdown or the Team progress tracker).
  const [memberFilter, setMemberFilter] = useState<string | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const router = useRouter();

  // SSE stream for live log updates
  useEffect(() => {
    if (done) return;

    const es = new EventSource(`/api/tasks/${taskId}/logs/stream`);
    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.done) {
        setConnected(false);
        setDone(true);
        es.close();
        router.refresh();
        return;
      }
      if (data.content) {
        setLogs((prev) => {
          if (prev.some((l) => l.id === data.id)) return prev;
          return [...prev, data];
        });
      }
    };

    es.onerror = () => { setConnected(false); es.close(); };
    return () => { setConnected(false); es.close(); };
  }, [taskId, done, router]);

  // Load existing logs for terminal-state tasks on mount
  useEffect(() => {
    if (!done) return;
    fetch(`/api/tasks/${taskId}`)
      .then((r) => r.json())
      .then((data) => {
        const incoming: LogEntry[] = data.logs ?? [];
        setLogs((prev) => {
          if (prev.length === 0) return incoming;
          // Merge: keep existing, add any new ones not already present
          const existingIds = new Set(prev.map((l) => l.id));
          const newOnes = incoming.filter((l) => !existingIds.has(l.id));
          return newOnes.length ? [...prev, ...newOnes] : prev;
        });
      });
  }, [taskId, done]);

  // Messages are sent from the page-level TaskComposer. When a follow-up re-queues a
  // finished task, reconnect the live stream (and the status poll below, which
  // refreshes the page once the status changes) and snap back to the latest output.
  useEffect(() => {
    const onSent = (e: Event) => {
      const detail = (e as CustomEvent<TaskMessageSentDetail>).detail;
      if (detail?.taskId !== taskId) return;
      setAutoScroll(true);
      if (detail.requeued) setDone(false);
    };
    window.addEventListener(TASK_MESSAGE_SENT_EVENT, onSent);
    return () => window.removeEventListener(TASK_MESSAGE_SENT_EVENT, onSent);
  }, [taskId]);

  useEffect(() => {
    const onFilter = (e: Event) => {
      const detail = (e as CustomEvent<TeamMemberFilterDetail>).detail;
      if (detail?.taskId !== taskId) return;
      setMemberFilter(detail.member);
    };
    window.addEventListener(TEAM_MEMBER_FILTER_EVENT, onFilter);
    return () => window.removeEventListener(TEAM_MEMBER_FILTER_EVENT, onFilter);
  }, [taskId]);

  // Poll task status while running
  useEffect(() => {
    if (done) return;
    let lastStatus: string = initialStatus;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`);
        const data = await res.json() as { status: string };
        if (data.status !== lastStatus) {
          lastStatus = data.status;
          router.refresh();
        }
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(interval);
  }, [taskId, done, initialStatus, router]);

  // Scroll conversation to bottom on new logs — only when auto-scroll is enabled.
  // Scroll the container's own scrollTop (never scrollIntoView) so the page
  // viewport is not affected when the user is looking elsewhere.
  useEffect(() => {
    if (!autoScroll) return;
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [logs, autoScroll]);

  // Detect when the user manually scrolls away from the bottom
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAutoScroll(nearBottom);
  }, []);

  // Focus the search input as soon as it's revealed
  useEffect(() => {
    if (showSearch) searchInputRef.current?.focus();
  }, [showSearch]);

  const jumpToLatest = useCallback(() => {
    setAutoScroll(true);
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, []);

  const downloadLogs = () => {
    const LEVEL_LABELS: Record<string, string> = {
      info: "AI",
      error: "ERROR",
      system: "SYSTEM",
      user: "USER",
    };
    const text = logs
      .map((l) => {
        const ts = formatTimestamp(l.createdAt);
        const label = LEVEL_LABELS[l.level] ?? l.level.toUpperCase();
        return `[${ts}] [${label}]${l.member ? ` [${l.member}]` : ""} ${l.content}`;
      })
      .join("\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `task-${taskId}-logs.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Task is on hold waiting to resume (rate-limited / throttled) rather than
  // actively running — show the history instead of a "waiting for output" stub.
  const isHeld = initialStatus === "paused" || initialStatus === "throttled";

  // No logs yet and still running: simple waiting state
  if (logs.length === 0 && !done && !isHeld) {
    return (
      <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 font-mono text-sm h-24 flex items-center">
        <span className="text-zinc-500">Waiting for output…</span>
      </div>
    );
  }

  // Members seen in this task's logs, in first-appearance (i.e. pipeline) order.
  const members = Array.from(new Set(logs.map((l) => l.member).filter((m): m is string => !!m)));
  const activeMemberFilter = memberFilter && members.includes(memberFilter) ? memberFilter : null;
  const allTurns = segmentIntoTurns(
    activeMemberFilter ? logs.filter((l) => l.level === "user" || l.member === activeMemberFilter) : logs,
  );

  const normalizedLogSearch = logSearch.trim().toLowerCase();

  // Apply filter to turns. A turn is kept only if it has at least one log for
  // the active category (so we don't render empty turns), matching what
  // AgentTurn will actually show. User-message turns are always kept so the
  // conversation context is preserved across tabs.
  const turns = allTurns.filter((turn) => {
    // Level filter
    if (filterMode === "ai" && !(turn.logs.some((l) => l.level === "info") || turn.userMessage !== null)) return false;
    if (filterMode === "system" && !(turn.logs.some((l) => l.level === "system") || turn.userMessage !== null)) return false;
    if (filterMode === "errors" && !turn.logs.some((l) => l.level === "error")) return false;
    // Keyword search filter
    if (normalizedLogSearch) {
      const matchesMessage = turn.userMessage?.toLowerCase().includes(normalizedLogSearch) ?? false;
      const matchesLog = turn.logs.some((l) =>
        l.content.toLowerCase().includes(normalizedLogSearch) || (l.member?.toLowerCase().includes(normalizedLogSearch) ?? false));
      if (!matchesMessage && !matchesLog) return false;
    }
    return true;
  });

  // Count actual log lines per category for the tab badges — more informative
  // than counting turns (a single turn can contain many events).
  const countLevel = (level: string) =>
    allTurns.reduce((n, t) => n + t.logs.filter((l) => l.level === level).length, 0);
  const aiCount = countLevel("info");
  const systemCount = countLevel("system");
  const errorCount = countLevel("error");

  return (
    <div className="flex flex-col gap-3">
      {/* Toolbar */}
      {logs.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            {/* Filter tabs */}
            <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5">
              {(Object.entries(FILTER_LABELS) as [FilterMode, string][]).map(([mode, label]) => {
                const count = mode === "ai" ? aiCount : mode === "system" ? systemCount : mode === "errors" ? errorCount : logs.length;
                const isActive = filterMode === mode;
                // Draw the eye to errors: red badge whenever any exist.
                const isErrorBadge = mode === "errors" && errorCount > 0;
                return (
                  <button
                    key={mode}
                    onClick={() => setFilterMode(mode)}
                    className={`px-2.5 py-1 text-xs rounded-md font-medium transition-colors flex items-center gap-1 ${
                      isActive
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    title={`Show ${label.toLowerCase()} logs only`}
                  >
                    {label}
                    {mode !== "all" && count > 0 && (
                      <span
                        className={`text-[10px] tabular-nums ${
                          isErrorBadge
                            ? "text-red-500 font-semibold"
                            : isActive
                              ? "text-muted-foreground"
                              : "text-muted-foreground/60"
                        }`}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-0.5">
              {members.length > 0 && (
                <select
                  value={activeMemberFilter ?? ""}
                  onChange={(e) => {
                    // Broadcast rather than set directly, so the Team progress tracker's
                    // highlighted member follows the dropdown (our own listener sets the state).
                    window.dispatchEvent(new CustomEvent<TeamMemberFilterDetail>(TEAM_MEMBER_FILTER_EVENT, {
                      detail: { taskId, member: e.target.value || null },
                    }));
                  }}
                  title="Filter by team member"
                  aria-label="Filter by team member"
                  className="mr-1 h-7 rounded-md border border-border bg-muted/50 px-2 text-xs text-foreground focus:outline-none focus:border-zinc-500"
                >
                  <option value="">All members</option>
                  {members.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              )}
              <button
                onClick={() => setShowSearch((s) => {
                  if (s) setLogSearch(""); // clear the (now-hidden) filter so it doesn't silently keep filtering
                  return !s;
                })}
                title={showSearch ? "Hide search" : "Search logs"}
                aria-label={showSearch ? "Hide search" : "Search logs"}
                aria-pressed={showSearch}
                className={`inline-flex items-center justify-center size-7 rounded-md transition-colors ${
                  showSearch ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                <Search className="size-3.5" />
              </button>
              <button
                onClick={downloadLogs}
                title="Download logs as text file"
                aria-label="Download logs as text file"
                className="inline-flex items-center justify-center size-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <Download className="size-3.5" />
              </button>
            </div>
          </div>
          {/* Keyword search — collapsed behind the search icon until requested */}
          {showSearch && (
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
              <input
                ref={searchInputRef}
                type="search"
                value={logSearch}
                onChange={(e) => setLogSearch(e.target.value)}
                placeholder="Search logs…"
                className="w-full bg-muted/50 border border-border rounded-lg pl-8 pr-8 py-1.5 text-xs text-foreground placeholder-muted-foreground focus:outline-none focus:border-zinc-500 focus:bg-muted"
              />
              {logSearch && (
                <button
                  onClick={() => { setLogSearch(""); searchInputRef.current?.focus(); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          )}
          {showSearch && normalizedLogSearch && (
            <p className="text-xs text-muted-foreground">
              {turns.length === 0
                ? "No turns match your search."
                : `${turns.length} of ${allTurns.length} turn${allTurns.length !== 1 ? "s" : ""} match`}
            </p>
          )}
        </div>
      )}

      {/* Conversation */}
      <div className="relative">
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="flex flex-col gap-4 max-h-[600px] overflow-y-auto pr-1"
        >
          {turns.length === 0 && logs.length > 0 && (
            <div className="text-center py-6 text-sm text-muted-foreground">
              {filterMode === "errors"
                ? "No errors, nice. 🎉"
                : filterMode === "ai"
                  ? "No AI responses in this task yet."
                  : filterMode === "system"
                    ? "No system events in this task."
                    : "No logs in this task."}
            </div>
          )}
          {turns.map((turn, i) => {
            const isLastTurn = i === turns.length - 1;
            const isStreaming = isLastTurn && connected && initialStatus === "running";
            return (
              <div key={i} className="flex flex-col gap-3">
                {turn.userMessage && (
                  <div className="flex justify-end">
                    <div className="bg-primary text-primary-foreground rounded-2xl rounded-br-sm px-4 py-2.5 text-sm max-w-[85%] whitespace-pre-wrap break-words">
                      {turn.userMessage}
                    </div>
                  </div>
                )}
                <AgentTurn logs={turn.logs} isStreaming={isStreaming} searchQuery={normalizedLogSearch || undefined} filterMode={filterMode} />
              </div>
            );
          })}
        </div>
        {/* "Jump to latest" button — only shown when user has scrolled away from the bottom */}
        {!autoScroll && (
          <button
            onClick={jumpToLatest}
            className="absolute bottom-2 right-4 flex items-center gap-1.5 bg-primary/90 hover:bg-primary text-primary-foreground text-xs font-medium px-3 py-1.5 rounded-full shadow-lg transition-colors"
            aria-label="Jump to latest log entry"
          >
            <ArrowDown className="size-3" />
            Jump to latest
          </button>
        )}
      </div>

    </div>
  );
}
