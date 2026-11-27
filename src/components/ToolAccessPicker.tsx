"use client";

/**
 * Per-task agent tool access (Advanced Options → Tool Access).
 *
 * One row per registered tool (src/lib/agent-tools.ts) with three choices:
 * "Default" (follow Settings → Agent Tools, shown with what that currently
 * means), "Allow" and "Deny". Only explicit choices are stored on the task, so
 * a task left on Default follows later changes to the global default.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Label } from "@/components/ui/label";
import { TriangleAlert } from "lucide-react";
import { GITHUB_CLI_TOOL_ID, type ToolAccessMap } from "@/lib/agent-tools";

interface ToolInfo {
  id: string;
  name: string;
  command: string;
  description: string;
  settingsAnchor: string;
  grantedByDefault: boolean;
}

interface AgentToolsResponse {
  tools: ToolInfo[];
  github: { ready: boolean };
}

type Choice = "default" | "allow" | "deny";

export interface ToolAccessPickerProps {
  value: ToolAccessMap;
  onChange: (next: ToolAccessMap) => void;
}

export function ToolAccessPicker({ value, onChange }: ToolAccessPickerProps) {
  const [data, setData] = useState<AgentToolsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/agent-tools")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: AgentToolsResponse | null) => { if (!cancelled && d) setData(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!data || data.tools.length === 0) return null;

  function setChoice(toolId: string, choice: Choice) {
    const next = { ...value };
    if (choice === "default") delete next[toolId];
    else next[toolId] = choice === "allow";
    onChange(next);
  }

  return (
    <div>
      <Label>Tool Access</Label>
      <p className="text-xs text-muted-foreground mt-0.5 mb-2">
        External tools the agent may use for this task. <em>Default</em> follows{" "}
        <Link href="/settings/tools" className="underline">Settings → Agent Tools</Link>.
      </p>
      <div className="flex flex-col gap-2">
        {data.tools.map((tool) => {
          const choice: Choice = tool.id in value ? (value[tool.id] ? "allow" : "deny") : "default";
          const effective = choice === "default" ? tool.grantedByDefault : choice === "allow";
          const ready = tool.id === GITHUB_CLI_TOOL_ID ? data.github.ready : true;
          const options: { id: Choice; label: string }[] = [
            { id: "default", label: `Default (${tool.grantedByDefault ? "on" : "off"})` },
            { id: "allow", label: "Allow" },
            { id: "deny", label: "Deny" },
          ];
          return (
            <div key={tool.id} className="rounded-md border border-border px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {tool.name} <code className="text-xs bg-muted px-1 py-0.5 rounded font-normal">{tool.command}</code>
                  </div>
                  <div className="text-xs text-muted-foreground">{tool.description}</div>
                </div>
                <div role="radiogroup" aria-label={`${tool.name} access`} className="flex rounded-md border border-border overflow-hidden shrink-0">
                  {options.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={choice === o.id}
                      onClick={() => setChoice(tool.id, o.id)}
                      className={`px-2.5 py-1 text-xs font-medium transition-colors border-r last:border-r-0 border-border ${
                        choice === o.id
                          ? o.id === "deny"
                            ? "bg-destructive/20 text-destructive"
                            : "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>
              {effective && !ready && (
                <p className="mt-1.5 flex items-center gap-1 text-xs text-amber-500">
                  <TriangleAlert className="size-3" />
                  Not set up yet —{" "}
                  <Link href={`/settings/tools#${tool.settingsAnchor}`} className="underline">add a token in Settings</Link>
                  , otherwise the agent will be told it&apos;s unavailable.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
