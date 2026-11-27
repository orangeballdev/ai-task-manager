"use client";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowUp, Loader2, MessageSquareText, Mic } from "lucide-react";
import { useSpeechDictation } from "@/hooks/useSpeechDictation";
import { Textarea } from "@/components/ui/textarea";
import { taskMessageMode, type TaskMessageMode } from "@/lib/task-message-mode";
import { getAnalytics } from "@/components/WebAnalytics";

/**
 * Window event fired after a message is accepted by `POST /api/tasks/[id]/message`.
 * `LogViewer` listens for it so it can reconnect its live stream when a finished
 * task is re-queued, without the composer having to live inside the logs card.
 */
export const TASK_MESSAGE_SENT_EVENT = "task-message-sent";

export interface TaskMessageSentDetail {
  taskId: string;
  requeued: boolean;
}

const COPY: Record<TaskMessageMode, { title: string; hint: string; placeholder: string; cta: string }> = {
  live: {
    title: "Guide the agent",
    hint: "Delivered to the running agent at the next opportunity.",
    placeholder: "Send guidance to the running agent…",
    cta: "Send",
  },
  held: {
    title: "Add instructions",
    hint: "The task is on hold — these instructions are added to its context and used when it resumes.",
    placeholder: "Add instructions to include when this task resumes…",
    cta: "Add",
  },
  followup: {
    title: "Send a follow-up",
    hint: "Re-queues this task with your message as the new prompt. The previous prompt is kept as context, and the agent continues on the same workspace.",
    placeholder: "Ask for changes or next steps…",
    cta: "Send & re-run",
  },
};

export function TaskComposer({ taskId, status }: { taskId: string; status: string }) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { isRecording, isSupported: isSpeechSupported, toggleRecording } = useSpeechDictation((transcript) => {
    setMessage((prev) => (prev ? `${prev} ${transcript}` : transcript));
  });

  const mode = taskMessageMode(status);
  if (!mode) return null;
  const copy = COPY[mode];

  const send = async () => {
    const content = message.trim();
    if (!content || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/tasks/${taskId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = (await res.json().catch(() => ({}))) as { requeued?: boolean; queued?: boolean; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't send message");
        return;
      }
      setMessage("");
      getAnalytics()?.capture("task_message_sent", { task_status: status, mode, requeued: !!data.requeued });
      window.dispatchEvent(
        new CustomEvent<TaskMessageSentDetail>(TASK_MESSAGE_SENT_EVENT, {
          detail: { taskId, requeued: !!data.requeued },
        }),
      );
      if (data.requeued) toast.success("Follow-up sent — task re-queued");
      else if (data.queued) toast.success("Instructions saved for when the task resumes");
    } catch {
      toast.error("Couldn't send message");
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card/95 text-card-foreground shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <div className="flex items-start gap-2 px-4 pt-3">
        <MessageSquareText className="size-4 mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight flex items-center gap-2">
            {copy.title}
            {mode === "live" && (
              <span className="inline-flex items-center gap-1 text-[11px] font-normal text-sky-400">
                <span className="size-1.5 rounded-full bg-sky-400 animate-pulse" />
                Agent is running
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">{copy.hint}</p>
        </div>
      </div>
      <div className="p-3 pt-2">
        <div className="flex items-end gap-2 rounded-lg border border-input bg-background/60 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 transition-colors pr-1.5 pb-1.5">
          <Textarea
            ref={inputRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={copy.placeholder}
            aria-label={copy.title}
            disabled={sending}
            rows={1}
            className="min-h-10 max-h-48 flex-1 border-0 bg-transparent dark:bg-transparent focus-visible:ring-0 resize-none shadow-none"
          />
          {isSpeechSupported && (
            <button
              type="button"
              onClick={toggleRecording}
              aria-label={isRecording ? "Stop recording" : "Start voice dictation"}
              title={isRecording ? "Stop recording" : "Voice dictation"}
              className={`shrink-0 inline-flex items-center justify-center size-8 rounded-md transition-colors ${
                isRecording
                  ? "text-red-500 bg-red-500/10 animate-pulse"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              }`}
            >
              <Mic className="size-4" />
            </button>
          )}
          <button
            type="button"
            onClick={send}
            disabled={!message.trim() || sending}
            className="shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUp className="size-3.5" />}
            {sending ? "Sending…" : copy.cta}
          </button>
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-muted-foreground/70">
          <kbd className="font-sans">Enter</kbd> to send · <kbd className="font-sans">Shift+Enter</kbd> for a new line
        </p>
      </div>
    </div>
  );
}
