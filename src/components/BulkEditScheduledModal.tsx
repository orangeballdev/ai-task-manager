"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X } from "lucide-react";
import { toast } from "sonner";
import type { AIProvider } from "@/lib/types";
import { nextCronDates } from "@/components/TaskFormContent";

interface BulkEditScheduledModalProps {
  selectedIds: string[];
  onClose: () => void;
  onSuccess: (updates: { cronExpression?: string | null; aiProviderId?: string | null; model?: string | null }) => void;
}

export function BulkEditScheduledModal({ selectedIds, onClose, onSuccess }: BulkEditScheduledModalProps) {
  const [saving, setSaving] = useState(false);

  // Cron
  const [editCron, setEditCron] = useState(false);
  const [cronExpression, setCronExpression] = useState("");
  const [convertingCron, setConvertingCron] = useState(false);
  const [naturalCronText, setNaturalCronText] = useState("");
  const [showNaturalCron, setShowNaturalCron] = useState(false);

  // Provider
  const [editProvider, setEditProvider] = useState(false);
  const [aiProviderId, setAiProviderId] = useState<string>("");
  const [providers, setProviders] = useState<AIProvider[]>([]);

  // Model
  const [editModel, setEditModel] = useState(false);
  const [model, setModel] = useState("");
  // Tagged with the provider it was fetched for, so switching providers never
  // shows the previous provider's models.
  const [modelsForProvider, setModelsForProvider] = useState<{ providerId: string; models: { id: string; label: string }[] } | null>(null);
  const availableModels = aiProviderId && modelsForProvider?.providerId === aiProviderId ? modelsForProvider.models : [];
  const [modelSelectValue, setModelSelectValue] = useState("");

  useEffect(() => {
    fetch("/api/providers")
      .then((r) => r.json())
      .then((data: AIProvider[]) => setProviders(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!aiProviderId) return;
    let cancelled = false;
    fetch(`/api/providers/${aiProviderId}/models`)
      .then((r) => r.json())
      .then((data: { models: { id: string; label: string }[]; defaultModel: string | null }) => {
        if (!cancelled) setModelsForProvider({ providerId: aiProviderId, models: data.models ?? [] });
      })
      .catch(() => { if (!cancelled) setModelsForProvider({ providerId: aiProviderId, models: [] }); });
    return () => { cancelled = true; };
  }, [aiProviderId]);

  async function convertCronFromText() {
    if (!naturalCronText.trim() || convertingCron) return;
    setConvertingCron(true);
    try {
      const res = await fetch("/api/tasks/cron-from-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: naturalCronText.trim() }),
      });
      const data = await res.json() as { cronExpression?: string; error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? "Conversion failed");
      if (data.cronExpression) {
        setCronExpression(data.cronExpression);
        setNaturalCronText("");
        setShowNaturalCron(false);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to convert cron expression");
    } finally {
      setConvertingCron(false);
    }
  }

  const cronPreviewDates = cronExpression.trim() ? nextCronDates(cronExpression.trim()) : [];
  const cronValid = cronExpression.trim() === "" || cronPreviewDates.length > 0;

  async function handleSave() {
    if (!editCron && !editProvider && !editModel) {
      toast.error("Select at least one field to update");
      return;
    }
    if (editCron && cronExpression.trim() && !cronValid) {
      toast.error("Invalid cron expression");
      return;
    }

    const updates: { cronExpression?: string | null; aiProviderId?: string | null; model?: string | null } = {};
    if (editCron) updates.cronExpression = cronExpression.trim() || null;
    if (editProvider) updates.aiProviderId = aiProviderId || null;
    if (editModel) updates.model = (modelSelectValue === "custom" ? model : modelSelectValue) || null;

    setSaving(true);
    try {
      const res = await fetch("/api/tasks/bulk-edit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedIds, ...updates }),
      });
      if (!res.ok) {
        const err = await res.json() as { error: string };
        throw new Error(err.error ?? "Bulk edit failed");
      }
      const data = await res.json() as { updated: number };
      toast.success(`Updated ${data.updated} task${data.updated !== 1 ? "s" : ""}`);
      onSuccess(updates);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk edit failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-background border border-border rounded-xl shadow-xl w-full max-w-md flex flex-col gap-0 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <h2 className="text-base font-semibold">Bulk Edit</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Editing {selectedIds.length} scheduled task{selectedIds.length !== 1 ? "s" : ""}
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

        <div className="px-5 py-4 flex flex-col gap-5 overflow-y-auto max-h-[70vh]">
          {/* Cron Expression */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="editCron"
                checked={editCron}
                onChange={(e) => setEditCron(e.target.checked)}
                className="size-4 rounded border-2 border-muted-foreground accent-primary"
              />
              <Label htmlFor="editCron" className="cursor-pointer font-medium">
                Update Cron Schedule
              </Label>
            </div>
            {editCron && (
              <div className="ml-6 flex flex-col gap-2">
                <Input
                  value={cronExpression}
                  onChange={(e) => setCronExpression(e.target.value)}
                  placeholder="0 9 * * 1-5"
                  className="font-mono"
                />
                {cronExpression.trim() && !cronValid && (
                  <p className="text-xs text-destructive">Invalid cron expression</p>
                )}
                {cronPreviewDates.length > 0 && (
                  <div className="text-xs text-muted-foreground">
                    <span className="font-medium">Next runs: </span>
                    {cronPreviewDates.map((d, i) => (
                      <span key={i}>{i > 0 && " · "}{d.toLocaleString()}</span>
                    ))}
                  </div>
                )}
                {!showNaturalCron ? (
                  <button
                    type="button"
                    className="text-xs text-primary hover:text-primary/80 transition-colors font-medium text-left"
                    onClick={() => setShowNaturalCron(true)}
                  >
                    ✦ Use plain English instead
                  </button>
                ) : (
                  <div className="flex gap-2 items-center">
                    <input
                      type="text"
                      value={naturalCronText}
                      onChange={(e) => setNaturalCronText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); void convertCronFromText(); }
                        if (e.key === "Escape") { setShowNaturalCron(false); setNaturalCronText(""); }
                      }}
                      placeholder='e.g. "every weekday at 9am"'
                      autoFocus
                      className="flex-1 min-w-0 bg-muted border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-primary/60"
                      disabled={convertingCron}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={!naturalCronText.trim() || convertingCron}
                      onClick={() => void convertCronFromText()}
                      className="shrink-0"
                    >
                      {convertingCron ? "Converting…" : "Convert"}
                    </Button>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground shrink-0"
                      onClick={() => { setShowNaturalCron(false); setNaturalCronText(""); }}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* AI Provider */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="editProvider"
                checked={editProvider}
                onChange={(e) => setEditProvider(e.target.checked)}
                className="size-4 rounded border-2 border-muted-foreground accent-primary"
              />
              <Label htmlFor="editProvider" className="cursor-pointer font-medium">
                Update AI Provider
              </Label>
            </div>
            {editProvider && (
              <div className="ml-6">
                {providers.length > 0 ? (
                  <Select value={aiProviderId} onValueChange={(v) => setAiProviderId(v ?? "")}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select provider…">
                        {providers.find((p) => p.id === aiProviderId)?.name ?? "Select provider…"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="">Use default</SelectItem>
                      {providers.filter((p) => p.isEnabled).map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                          {p.isDefault && <span className="ml-2 text-xs text-muted-foreground">default</span>}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-xs text-muted-foreground">No providers configured.</p>
                )}
              </div>
            )}
          </div>

          {/* Model */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="editModel"
                checked={editModel}
                onChange={(e) => setEditModel(e.target.checked)}
                className="size-4 rounded border-2 border-muted-foreground accent-primary"
              />
              <Label htmlFor="editModel" className="cursor-pointer font-medium">
                Update AI Model
              </Label>
            </div>
            {editModel && (
              <div className="ml-6 flex flex-col gap-2">
                <Select
                  value={modelSelectValue}
                  onValueChange={(v) => {
                    const val = v ?? "";
                    setModelSelectValue(val);
                    if (val !== "custom") setModel(val === "provider-default" ? "" : val);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Provider default" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="provider-default">Provider default</SelectItem>
                    {availableModels.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                        <span className="text-muted-foreground text-xs ml-1">{m.id}</span>
                      </SelectItem>
                    ))}
                    <SelectItem value="custom">Custom…</SelectItem>
                  </SelectContent>
                </Select>
                {modelSelectValue === "custom" && (
                  <Input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="e.g. my-custom-model-id"
                    className="font-mono text-sm"
                    autoFocus
                  />
                )}
                {!editProvider && availableModels.length === 0 && (
                  <p className="text-xs text-muted-foreground">Enable &quot;Update AI Provider&quot; to see model options, or type a custom model ID.</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={saving || (!editCron && !editProvider && !editModel)}
            onClick={() => void handleSave()}
          >
            {saving ? "Saving…" : `Apply to ${selectedIds.length} task${selectedIds.length !== 1 ? "s" : ""}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
