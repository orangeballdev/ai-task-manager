"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PlayCircle, X } from "lucide-react";

interface BulkRunNowModalProps {
  selectedCount: number;
  running: boolean;
  onClose: () => void;
  onConfirm: (count: number) => void;
}

export function BulkRunNowModal({ selectedCount, running, onClose, onConfirm }: BulkRunNowModalProps) {
  const [count, setCount] = useState("1");

  const parsedCount = Math.max(1, Math.min(parseInt(count, 10) || 1, 50));
  const totalInstances = parsedCount * selectedCount;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-background border border-border rounded-xl shadow-xl w-full max-w-sm flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold">Run Now</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {selectedCount} scheduled task{selectedCount !== 1 ? "s" : ""} selected
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="bulkRunCount" className="font-medium">
              Instances per task
            </Label>
            <Input
              id="bulkRunCount"
              type="number"
              min="1"
              max="50"
              value={count}
              onChange={(e) => setCount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !running) onConfirm(parsedCount);
              }}
              autoFocus
              className="w-24"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Queues <span className="font-medium text-foreground">{totalInstances}</span> task
            instance{totalInstances !== 1 ? "s" : ""} in total.
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
          <Button type="button" variant="ghost" onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={running}
            className="flex items-center gap-1.5"
            onClick={() => onConfirm(parsedCount)}
          >
            <PlayCircle size={14} />
            {running ? "Queuing…" : `Queue ${totalInstances}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
