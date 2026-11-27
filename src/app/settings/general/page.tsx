"use client";
import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Flame } from "lucide-react";

async function saveSetting(key: string, value: string) {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error("Failed to save");
}

type ChatbotLevel = "low" | "medium" | "high";

const CHATBOT_LEVELS: { value: ChatbotLevel; label: string; description: string }[] = [
  { value: "low", label: "Low (Quick)", description: "Proposes a task immediately after your first message with minimal questions. Best for experienced users who want to create tasks fast." },
  { value: "medium", label: "Medium", description: "Asks one or two focused follow-up questions before proposing. Good balance of speed and accuracy." },
  { value: "high", label: "High (Thorough)", description: "Guides you through a detailed conversation, asking about repos, scheduling, and edge cases. Best for complex tasks." },
];

const HOME_PAGE_OPTIONS: { value: string; label: string }[] = [
  { value: "/tasks", label: "Tasks" },
  { value: "/tasks/kanban", label: "Board" },
  { value: "/tasks/new", label: "New Task" },
  { value: "/analytics", label: "Analytics" },
];

export default function GeneralSettingsPage() {
  const [throttle, setThrottle] = useState("");
  const [timeout, setTimeout_] = useState("60");
  const [concurrentTasks, setConcurrentTasks] = useState("1");
  const [maxAutoRetries, setMaxAutoRetries] = useState("0");
  const [chatbotLevel, setChatbotLevel] = useState<ChatbotLevel>("low");
  const [homePage, setHomePage] = useState("/tasks");
  const [taskBoardEnabled, setTaskBoardEnabled] = useState(true);
  const [hailMaryEnabled, setHailMaryEnabled] = useState(true);
  const [hailMaryThreshold, setHailMaryThreshold] = useState("20");
  const [hailMaryWindow, setHailMaryWindow] = useState("24");
  const [hailMaryBurstLimit, setHailMaryBurstLimit] = useState("1");
  const [autoEnhanceDescription, setAutoEnhanceDescription] = useState(false);

  // Tracks the last value persisted for each key so re-committing an
  // unchanged field (e.g. blur without edits) is a no-op.
  const savedRef = useRef<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data: Record<string, string>) => {
        if (data.task_throttle_per_hour) setThrottle(data.task_throttle_per_hour);
        if (data.task_timeout_minutes) setTimeout_(data.task_timeout_minutes);
        if (data.concurrent_tasks) setConcurrentTasks(data.concurrent_tasks);
        if (data.max_auto_retries) setMaxAutoRetries(data.max_auto_retries);
        if (data.chat_assistant_level) setChatbotLevel(data.chat_assistant_level as ChatbotLevel);
        if (data.home_page) setHomePage(data.home_page === "/" ? "/tasks" : data.home_page);
        // Enabled by default: only an explicit "false" turns it off.
        setTaskBoardEnabled(data.task_board_enabled !== "false");
        setHailMaryEnabled(data.hail_mary_enabled !== "false");
        if (data.hail_mary_remaining_threshold) setHailMaryThreshold(data.hail_mary_remaining_threshold);
        if (data.hail_mary_window_hours) setHailMaryWindow(data.hail_mary_window_hours);
        if (data.hail_mary_default_burst_limit) setHailMaryBurstLimit(data.hail_mary_default_burst_limit);
        // Auto-enhance is off by default: only an explicit "true" turns it on.
        setAutoEnhanceDescription(data.auto_enhance_description === "true");
        savedRef.current = { ...data };
      })
      .catch(() => {});
  }, []);

  // Persist a single setting, skipping the request when the value is unchanged.
  async function commit(key: string, value: string) {
    if (savedRef.current[key] === value) return;
    try {
      await saveSetting(key, value);
      savedRef.current[key] = value;
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    }
  }

  function commitThrottle() {
    const parsed = parseInt(throttle, 10);
    if (throttle !== "" && (isNaN(parsed) || parsed < 0)) {
      toast.error("Throttle must be a positive number, or leave blank to disable");
      return;
    }
    commit("task_throttle_per_hour", throttle === "" ? "0" : String(parsed));
  }

  function commitTimeout() {
    const parsed = parseInt(timeout, 10);
    if (isNaN(parsed) || parsed < 0) {
      toast.error("Timeout must be 0 (disabled) or a positive number of minutes");
      return;
    }
    commit("task_timeout_minutes", String(parsed));
  }

  function commitConcurrent() {
    const parsed = parseInt(concurrentTasks, 10);
    if (isNaN(parsed) || parsed < 1) {
      toast.error("Number of concurrent tasks must be at least 1");
      return;
    }
    commit("concurrent_tasks", String(parsed));
  }

  function commitAutoRetries() {
    const parsed = parseInt(maxAutoRetries, 10);
    if (isNaN(parsed) || parsed < 0) {
      toast.error("Max auto-retries must be 0 (disabled) or a positive number");
      return;
    }
    commit("max_auto_retries", String(parsed));
  }

  function commitHailThreshold() {
    const parsed = parseFloat(hailMaryThreshold);
    if (isNaN(parsed) || parsed < 0 || parsed > 100) {
      toast.error("Hail Mary remaining quota threshold must be between 0 and 100");
      return;
    }
    commit("hail_mary_remaining_threshold", String(parsed));
  }

  function commitHailWindow() {
    const parsed = parseInt(hailMaryWindow, 10);
    if (isNaN(parsed) || parsed < 1) {
      toast.error("Hail Mary trigger window must be at least 1 hour");
      return;
    }
    commit("hail_mary_window_hours", String(parsed));
  }

  function commitHailBurstLimit() {
    const parsed = parseInt(hailMaryBurstLimit, 10);
    if (isNaN(parsed) || parsed < 1) {
      toast.error("Hail Mary default burst limit must be at least 1");
      return;
    }
    commit("hail_mary_default_burst_limit", String(parsed));
  }

  function toggleTaskBoard() {
    const next = !taskBoardEnabled;
    setTaskBoardEnabled(next);
    commit("task_board_enabled", next ? "true" : "false");
  }

  function toggleHailMary() {
    const next = !hailMaryEnabled;
    setHailMaryEnabled(next);
    commit("hail_mary_enabled", next ? "true" : "false");
  }

  function toggleAutoEnhanceDescription() {
    const next = !autoEnhanceDescription;
    setAutoEnhanceDescription(next);
    commit("auto_enhance_description", next ? "true" : "false");
  }

  function selectChatbotLevel(level: ChatbotLevel) {
    setChatbotLevel(level);
    commit("chat_assistant_level", level);
  }

  function selectHomePage(value: string | null) {
    if (!value) return;
    setHomePage(value);
    commit("home_page", value);
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle id="task-timeout" className="text-base scroll-mt-24">Task Timeout</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Maximum time a task is allowed to run before it is killed and marked as failed. Defaults to 60 minutes. Set to 0 to disable the timeout and let tasks run indefinitely.
          </p>
          <div className="flex flex-col gap-2 max-w-xs">
            <Label htmlFor="timeout">Timeout (minutes, 0 = disabled)</Label>
            <Input
              id="timeout"
              type="number"
              min={0}
              value={timeout}
              onChange={(e) => setTimeout_(e.target.value)}
              onBlur={commitTimeout}
              placeholder="60"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="concurrent-tasks" className="text-base scroll-mt-24">Number Of Concurrent Tasks</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            How many tasks can run at the same time. Defaults to 1.
          </p>
          <div className="flex flex-col gap-2 max-w-xs">
            <Label htmlFor="concurrentTasks">Concurrent tasks</Label>
            <Input
              id="concurrentTasks"
              type="number"
              min={1}
              value={concurrentTasks}
              onChange={(e) => setConcurrentTasks(e.target.value)}
              onBlur={commitConcurrent}
              placeholder="1"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="task-throttling" className="text-base scroll-mt-24">Task Throttling</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Limit how many tasks the worker will start per hour. Leave blank or set to 0 to disable throttling.
          </p>
          <div className="flex flex-col gap-2 max-w-xs">
            <Label htmlFor="throttle">Max tasks per hour</Label>
            <Input
              id="throttle"
              type="number"
              min={0}
              value={throttle}
              onChange={(e) => setThrottle(e.target.value)}
              onBlur={commitThrottle}
              placeholder="Unlimited"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="auto-retry" className="text-base scroll-mt-24">Auto-Retry on Failure</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Automatically retry a task when it fails due to a transient error (e.g. a brief network blip or temporary API outage). The worker will reset the task to <code className="bg-muted px-1 rounded text-xs">pending</code> and run it again up to this many times before giving up. Set to 0 to disable: tasks will stay <code className="bg-muted px-1 rounded text-xs">failed</code> and require a manual retry. Rate-limit retries are handled separately and are not counted toward this limit.
          </p>
          <div className="flex flex-col gap-2 max-w-xs">
            <Label htmlFor="maxAutoRetries">Max auto-retries (0 = disabled)</Label>
            <Input
              id="maxAutoRetries"
              type="number"
              min={0}
              max={10}
              value={maxAutoRetries}
              onChange={(e) => setMaxAutoRetries(e.target.value)}
              onBlur={commitAutoRetries}
              placeholder="0"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="hail-mary" className="text-base flex items-center gap-2 scroll-mt-24">
            <Flame className={`size-4 ${hailMaryEnabled ? "text-orange-400" : "text-muted-foreground"}`} />
            Hail Mary Burst Mode
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            When a healthy (non–rate-limited) CLI provider&apos;s usage window is about to reset with significant quota still unused, the worker automatically spawns extra runs of the recurring templates you&apos;ve flagged as Hail Mary tasks, using up that quota before it&apos;s lost. Flag individual templates from their <span className="font-medium">Advanced Options</span>. This master switch turns the whole behavior on or off.
          </p>
          <label className="flex items-center gap-3 cursor-pointer">
            <button
              type="button"
              role="switch"
              aria-checked={hailMaryEnabled}
              onClick={toggleHailMary}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${hailMaryEnabled ? "bg-orange-500" : "bg-muted-foreground/30"}`}
            >
              <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition-transform ${hailMaryEnabled ? "translate-x-4" : "translate-x-0"}`} />
            </button>
            <span className="text-sm font-medium">{hailMaryEnabled ? "Enabled" : "Disabled"}</span>
          </label>

          <div className={`flex flex-col gap-4 ${hailMaryEnabled ? "" : "opacity-50 pointer-events-none"}`}>
            <div className="flex flex-col gap-2 max-w-xs">
              <Label htmlFor="hailMaryThreshold">Remaining quota threshold (%)</Label>
              <Input
                id="hailMaryThreshold"
                type="number"
                min={0}
                max={100}
                value={hailMaryThreshold}
                onChange={(e) => setHailMaryThreshold(e.target.value)}
                onBlur={commitHailThreshold}
                placeholder="20"
              />
              <span className="text-xs text-muted-foreground/70">Only burst when at least this much quota remains. Default 20%.</span>
            </div>
            <div className="flex flex-col gap-2 max-w-xs">
              <Label htmlFor="hailMaryWindow">Trigger window before reset (hours)</Label>
              <Input
                id="hailMaryWindow"
                type="number"
                min={1}
                value={hailMaryWindow}
                onChange={(e) => setHailMaryWindow(e.target.value)}
                onBlur={commitHailWindow}
                placeholder="24"
              />
              <span className="text-xs text-muted-foreground/70">How close to the quota reset the burst is allowed to fire. Default 24h.</span>
            </div>
            <div className="flex flex-col gap-2 max-w-xs">
              <Label htmlFor="hailMaryBurstLimit">Default runs per template per burst</Label>
              <Input
                id="hailMaryBurstLimit"
                type="number"
                min={1}
                value={hailMaryBurstLimit}
                onChange={(e) => setHailMaryBurstLimit(e.target.value)}
                onBlur={commitHailBurstLimit}
                placeholder="1"
              />
              <span className="text-xs text-muted-foreground/70">Fallback cap for templates that don&apos;t set their own per-task limit. Default 1.</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="home-page" className="text-base scroll-mt-24">Home Page</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            The page shown when you load the app and the page the logo links to. Defaults to Tasks.
          </p>
          <div className="flex flex-col gap-2 max-w-xs">
            <Label htmlFor="homePage">Home page</Label>
            <Select value={homePage} onValueChange={selectHomePage}>
              <SelectTrigger id="homePage" className="w-full">
                <SelectValue>{(value: string) => HOME_PAGE_OPTIONS.find((opt) => opt.value === value)?.label ?? value}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {HOME_PAGE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="task-board" className="text-base scroll-mt-24">Task Board</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Show or hide the Task Board view in the navigation. When disabled, the Board link is removed from the nav bar entirely.
          </p>
          <label className="flex items-center gap-3 cursor-pointer">
            <button
              type="button"
              role="switch"
              aria-checked={taskBoardEnabled}
              onClick={toggleTaskBoard}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${taskBoardEnabled ? "bg-primary" : "bg-muted-foreground/30"}`}
            >
              <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition-transform ${taskBoardEnabled ? "translate-x-4" : "translate-x-0"}`} />
            </button>
            <span className="text-sm font-medium">{taskBoardEnabled ? "Enabled" : "Disabled"}</span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="repositories" className="text-base scroll-mt-24">Repositories</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Save the Git repos you work with and give each a <a href="/repositories" className="underline">default context</a> that&apos;s automatically added to every task for that repo. Useful for standing instructions, conventions, or gotchas that shouldn&apos;t have to be retyped each time.
          </p>
          <a href="/repositories" className="text-sm font-medium underline w-fit">
            Manage repositories →
          </a>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="auto-enhance-description" className="text-base scroll-mt-24">Auto-Enhance Task Descriptions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            When enabled, the AI will automatically enhance your task description when you submit a new task, the same time the task title is auto-generated. The Enhance button on the task form will display a green indicator to show this is active.
          </p>
          <label className="flex items-center gap-3 cursor-pointer">
            <button
              type="button"
              role="switch"
              aria-checked={autoEnhanceDescription}
              onClick={toggleAutoEnhanceDescription}
              className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${autoEnhanceDescription ? "bg-green-500" : "bg-muted-foreground/30"}`}
            >
              <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-lg ring-0 transition-transform ${autoEnhanceDescription ? "translate-x-4" : "translate-x-0"}`} />
            </button>
            <span className="text-sm font-medium">{autoEnhanceDescription ? "Enabled" : "Disabled"}</span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle id="chat-assistant-level" className="text-base scroll-mt-24">Chat Assistant Level</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Controls how much back-and-forth the AI chat assistant uses when creating tasks. Lower levels propose tasks faster; higher levels ask more questions for accuracy.
          </p>
          <div className="flex flex-col gap-2">
            {CHATBOT_LEVELS.map((lvl) => (
              <label
                key={lvl.value}
                className={`flex items-start gap-3 cursor-pointer rounded-md px-3 py-2.5 border transition-colors ${
                  chatbotLevel === lvl.value
                    ? "border-primary/50 bg-primary/5"
                    : "border-border hover:bg-muted/40"
                }`}
              >
                <input
                  type="radio"
                  name="chatbotLevel"
                  value={lvl.value}
                  checked={chatbotLevel === lvl.value}
                  onChange={() => selectChatbotLevel(lvl.value)}
                  className="accent-primary mt-0.5 shrink-0"
                />
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className={`text-sm font-medium ${chatbotLevel === lvl.value ? "text-foreground" : "text-muted-foreground"}`}>
                    {lvl.label}
                    {lvl.value === "low" && <span className="ml-2 text-xs font-normal text-primary/70">default</span>}
                  </span>
                  <span className="text-xs text-muted-foreground">{lvl.description}</span>
                </div>
              </label>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
