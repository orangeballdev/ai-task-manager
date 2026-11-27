"use client";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import { useState } from "react";

type StepStatus = "idle" | "checking" | "ok" | "error";

interface Step {
  id: string;
  title: string;
  description: string;
  instructions: string[];
  codeSnippet?: string;
  settingsLink?: string;
}

const STEPS: Step[] = [
  {
    id: "claude-cli",
    title: "Install Claude CLI",
    description: "The Claude CLI lets the system run Claude on your behalf using your subscription.",
    instructions: ["Run the install command below in your terminal.", "Verify by checking the version."],
    codeSnippet: "npm install -g @anthropic-ai/claude-code",
  },
  {
    id: "claude-auth",
    title: "Authenticate Claude",
    description: "Log in to Claude CLI with your Anthropic account.",
    instructions: ["Click the button below to open the Claude settings and configure authentication."],
    settingsLink: "/settings/ai",
  },
  {
    id: "git-config",
    title: "Configure Git",
    description: "Git must be configured with your name, email, and credentials for commits and repo access.",
    instructions: ["Click the button below to open the Git settings and configure your identity and authentication."],
    settingsLink: "/settings/git",
  },
  {
    id: "test-task",
    title: "Test Task",
    description: "Verify the system works end-to-end by creating a test task.",
    instructions: ["Create a task from the dashboard.", "Confirm the worker picks it up and logs appear."],
  },
];

export default function SetupPage() {
  const [statuses, setStatuses] = useState<Record<string, StepStatus>>({});
  const [outputs, setOutputs] = useState<Record<string, string>>({});

  async function verify(stepId: string) {
    setStatuses((s) => ({ ...s, [stepId]: "checking" }));
    try {
      const res = await fetch("/api/setup/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: stepId }),
      });
      const data = await res.json();
      setStatuses((s) => ({ ...s, [stepId]: data.ok ? "ok" : "error" }));
      setOutputs((o) => ({ ...o, [stepId]: data.output ?? "" }));
    } catch {
      setStatuses((s) => ({ ...s, [stepId]: "error" }));
    }
  }

  const allDone = STEPS.slice(0, 3).every((s) => statuses[s.id] === "ok");

  return (
    <div className="max-w-7xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Setup Guide</h1>
        <p className="text-zinc-400 mt-1">Follow these steps to configure Claude Task Manager.</p>
        {allDone && (
          <div className="mt-3 bg-green-900/30 border border-green-700 rounded-lg px-4 py-2 text-green-400 text-sm">
            Core setup complete! You&apos;re ready to run tasks.
          </div>
        )}
      </div>

      <div className="flex flex-col gap-4">
        {STEPS.map((step, i) => {
          const status = statuses[step.id] ?? "idle";
          const output = outputs[step.id];

          return (
            <Card key={step.id} className={`bg-zinc-900 border-zinc-800 ${status === "ok" ? "border-green-800" : ""}`}>
              <CardHeader className="pb-2">
                <div className="flex items-center gap-3">
                  <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${status === "ok" ? "bg-green-700 text-white" : status === "error" ? "bg-red-700 text-white" : "bg-zinc-700 text-zinc-300"}`}>
                    {status === "ok" ? "✓" : status === "error" ? "✕" : i + 1}
                  </span>
                  <CardTitle className="text-base">{step.title}</CardTitle>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="text-sm text-zinc-400">{step.description}</p>
                <ul className="text-sm text-zinc-400 list-disc list-inside space-y-1">
                  {step.instructions.map((ins, j) => <li key={j}>{ins}</li>)}
                </ul>
                {step.codeSnippet && (
                  <pre className="bg-zinc-950 border border-zinc-800 rounded p-3 text-xs text-zinc-300 font-mono whitespace-pre-wrap">
                    {step.codeSnippet}
                  </pre>
                )}

                <div className="flex items-center gap-3">
                  {step.settingsLink && (
                    <Link href={step.settingsLink} className={buttonVariants({ size: "sm", variant: "outline" })}>
                      ⚙ Open Settings
                    </Link>
                  )}
                  <Button
                    size="sm"
                    variant={status === "ok" ? "outline" : "default"}
                    onClick={() => verify(step.id)}
                    disabled={status === "checking"}
                    className={status === "ok" ? "border-green-700 text-green-400" : ""}
                  >
                    {status === "checking" ? "Checking..." : status === "ok" ? "✓ Verified" : "Verify"}
                  </Button>
                  {output && (
                    <span className={`text-xs font-mono ${status === "ok" ? "text-green-400" : "text-red-400"}`}>
                      {output.slice(0, 120)}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
