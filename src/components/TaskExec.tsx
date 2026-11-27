"use client";
import { useState, useRef, useEffect } from "react";
import { Terminal } from "lucide-react";

interface ExecResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  cwd: string;
}

interface TaskExecProps {
  taskId: string;
  repos: Array<{ alias: string }>;
}

export function TaskExec({ taskId, repos }: TaskExecProps) {
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [history, setHistory] = useState<ExecResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  const commandHistory = history.map((h) => h.command);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: "smooth" });
  }, [history]);

  async function runCommand() {
    const cmd = command.trim();
    if (!cmd || loading) return;
    setLoading(true);
    setHistoryIndex(-1);
    try {
      const res = await fetch(`/api/tasks/${taskId}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd, cwd: cwd || undefined }),
      });
      const data = await res.json() as ExecResult & { error?: string };
      if (!res.ok) {
        setHistory((prev) => [...prev, {
          command: cmd,
          stdout: "",
          stderr: data.error ?? "Request failed",
          exitCode: -1,
          timedOut: false,
          cwd: cwd || "",
        }]);
      } else {
        setHistory((prev) => [...prev, { ...data, command: cmd }]);
      }
    } catch (err) {
      setHistory((prev) => [...prev, {
        command: cmd,
        stdout: "",
        stderr: err instanceof Error ? err.message : "Request failed",
        exitCode: -1,
        timedOut: false,
        cwd: cwd || "",
      }]);
    } finally {
      setCommand("");
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      void runCommand();
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const newIndex = Math.min(historyIndex + 1, commandHistory.length - 1);
      setHistoryIndex(newIndex);
      setCommand(commandHistory[commandHistory.length - 1 - newIndex] ?? "");
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setCommand("");
        return;
      }
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      setCommand(commandHistory[commandHistory.length - 1 - newIndex] ?? "");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Workspace: <code className="bg-muted px-1 py-0.5 rounded">/workspaces/{taskId}</code></span>
        {repos.length > 0 && (
          <span>
            Repos: {repos.map((r) => (
              <code key={r.alias} className="bg-muted px-1 py-0.5 rounded ml-1">{r.alias}/</code>
            ))}
          </span>
        )}
      </div>

      {/* Output area */}
      <div
        ref={outputRef}
        className="bg-black/80 rounded-lg font-mono text-xs text-green-400 p-3 overflow-y-auto max-h-96 min-h-24 flex flex-col gap-2"
        onClick={() => inputRef.current?.focus()}
      >
        {history.length === 0 && (
          <span className="text-muted-foreground/50">Run a command to see output here.</span>
        )}
        {history.map((entry, i) => (
          <div key={i} className="flex flex-col gap-0.5">
            <div className="text-blue-400">
              <span className="text-muted-foreground/60">$ </span>
              {entry.command}
            </div>
            {entry.stdout && (
              <pre className="whitespace-pre-wrap text-green-300 text-xs">{entry.stdout}</pre>
            )}
            {entry.stderr && (
              <pre className="whitespace-pre-wrap text-red-400 text-xs">{entry.stderr}</pre>
            )}
            {entry.timedOut && (
              <span className="text-yellow-400 text-xs">[timed out after 30s]</span>
            )}
            {!entry.timedOut && entry.exitCode !== 0 && entry.exitCode !== -1 && (
              <span className="text-red-400 text-xs">[exit {entry.exitCode}]</span>
            )}
          </div>
        ))}
        {loading && (
          <span className="text-muted-foreground/60 animate-pulse">Running…</span>
        )}
      </div>

      {/* Command input */}
      <div className="flex gap-2">
        <div className="flex items-center gap-1.5 flex-1 bg-muted rounded-md px-3 py-1.5 font-mono text-sm border border-border focus-within:border-primary/50 transition-colors">
          <Terminal size={14} className="text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="bash command…"
            className="flex-1 bg-transparent outline-none text-foreground placeholder:text-muted-foreground/50 text-sm"
            disabled={loading}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {repos.length > 0 && (
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="cwd (e.g. myrepo)"
            className="w-36 bg-muted rounded-md px-3 py-1.5 text-xs border border-border outline-none font-mono focus:border-primary/50 transition-colors"
            title="Working directory relative to workspace (leave blank for workspace root)"
          />
        )}
        <button
          onClick={() => void runCommand()}
          disabled={loading || !command.trim()}
          className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50 transition-opacity hover:opacity-90"
        >
          Run
        </button>
      </div>
    </div>
  );
}
