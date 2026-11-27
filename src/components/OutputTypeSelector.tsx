"use client";

import { FileText, GitBranch, MessageSquareText, Palette } from "lucide-react";
import type { OutputType } from "@/lib/output-type";

export type { OutputType } from "@/lib/output-type";

interface OutputTypeSelectorProps {
  value: OutputType;
  onChange: (v: OutputType) => void;
}

interface OptionConfig {
  value: OutputType;
  icon: typeof FileText;
  title: string;
  description: string;
}

const OPTIONS: OptionConfig[] = [
  {
    value: "repository",
    icon: GitBranch,
    title: "Commit to repository",
    description: "Agent clones repos, writes code, and pushes commits or a PR.",
  },
  {
    value: "file",
    icon: FileText,
    title: "Create file(s)",
    description: "Agent produces documents (markdown, CSV, HTML…) stored in the Files section.",
  },
  {
    value: "design",
    icon: Palette,
    title: "Design",
    description: 'Say "design me an app" or "design a diagram": the agent produces interactive HTML mockups you can view in the Files section.',
  },
  {
    value: "result",
    icon: MessageSquareText,
    title: "Result only",
    description: "No files or commits: the agent's answer is shown in the Result section of the task details page.",
  },
];

export function OutputTypeSelector({ value, onChange }: OutputTypeSelectorProps) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium">Output Type</span>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
        {OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const selected = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={`flex flex-col items-start gap-1.5 rounded-lg border px-4 py-3 text-left transition-colors ${
                selected
                  ? "border-primary bg-primary/10 shadow-sm"
                  : "border-border hover:border-border/80 hover:bg-muted/40"
              }`}
            >
              <div className="flex items-center gap-2">
                <Icon
                  size={15}
                  className={selected ? "text-primary" : "text-muted-foreground"}
                />
                <span
                  className={`text-sm font-medium ${selected ? "text-foreground" : "text-muted-foreground"}`}
                >
                  {opt.title}
                </span>
              </div>
              <p className="text-xs text-muted-foreground leading-snug pl-6">
                {opt.description}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
