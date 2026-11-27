"use client";
import { copyToClipboard } from "@/lib/clipboard";
import { useState } from "react";
import { Check, Copy } from "lucide-react";

export function CodeBlock({ code, className = "" }: { code: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className={`relative group ${className}`}>
      <pre className="rounded-md bg-zinc-950 border border-border text-zinc-100 text-xs p-4 overflow-x-auto font-mono leading-relaxed">
        <code>{code}</code>
      </pre>
      <button
        type="button"
        aria-label="Copy code"
        onClick={() => {
          copyToClipboard(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }, () => {});
        }}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-zinc-800/80 text-zinc-300 hover:text-white hover:bg-zinc-700 transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}
