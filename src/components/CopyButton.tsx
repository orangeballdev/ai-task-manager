"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { copyToClipboard } from "@/lib/clipboard";

interface CopyButtonProps {
  text: string;
  /** Accessible label shown on hover. Defaults to "Copy to clipboard". */
  label?: string;
  /** Message shown in the success toast. Defaults to "Copied to clipboard". */
  successMessage?: string;
}

/**
 * Small icon button that copies `text` to the clipboard and briefly shows
 * a checkmark plus a toast to confirm the copy succeeded (or failed).
 */
export function CopyButton({ text, label = "Copy to clipboard", successMessage = "Copied to clipboard" }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await copyToClipboard(text);
      setCopied(true);
      toast.success(successMessage);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? "Copied!" : label}
      aria-label={copied ? "Copied!" : label}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-1.5 py-1 rounded-md hover:bg-muted shrink-0"
    >
      {copied ? (
        <Check className="size-3.5 text-green-400" />
      ) : (
        <Copy className="size-3.5" />
      )}
      <span className="sr-only">{copied ? "Copied!" : label}</span>
    </button>
  );
}
