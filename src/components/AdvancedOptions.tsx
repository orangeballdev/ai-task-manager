"use client";

/**
 * The "Advanced Options" accordion.
 *
 * Shared by the new-task / edit-task forms (src/components/TaskFormContent.tsx)
 * and the Repositories page (src/app/repositories/RepositoriesClient.tsx),
 * where the exact same controls set *defaults* for every task created against
 * a saved repo. Keeping one component means a field added here shows up in
 * both places, and the two never drift apart.
 *
 * The task form renders extra, task-only controls (title, depends-on,
 * attachments, context files, subtask splitting) that have no meaning as a
 * per-repo default — those are passed in as `slots` so they still appear
 * inside the same accordion, in the same order as before.
 */

import { useEffect, useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronRight, ClipboardCheck, ListTree, Sparkles, X } from "lucide-react";
import type { AIProvider } from "@/lib/types";
import { PRIORITY_LEVELS, PRIORITY_LABELS, DEFAULT_PRIORITY, normalizePriority } from "@/lib/priority";
import { EFFORT_LEVELS, EFFORT_LABELS, normalizeEffort, type TaskEffort } from "@/lib/effort";
import { ANTHROPIC_MODELS, getModelsForProviderType, modelSupportsEffort } from "@/lib/models";

/** Every value the accordion can edit. All optional — unset means "no override". */
export interface AdvancedOptionsValues {
  priority?: string | null;
  effort?: string | null;
  /** Kept as a string so an empty input round-trips as "no budget". */
  costBudget?: string;
  tokenBudget?: string;
  aiProviderId?: string | null;
  useSmartProvider?: boolean;
  model?: string | null;
  labels?: string[];
  context?: string;
  createValidationTask?: boolean;
  /** Let the agent queue follow-up tasks of its own (see src/lib/subtasks.ts). */
  allowSubtasks?: boolean;
}

/**
 * Field identifiers, in the order they're rendered. `aiProviderId` covers the
 * provider select as a whole, including the Smart Provider option (which
 * writes both `aiProviderId` and `useSmartProvider`).
 */
export const ADVANCED_OPTION_FIELDS = [
  "priority",
  "effort",
  "costBudget",
  "tokenBudget",
  "aiProviderId",
  "model",
  "labels",
  "context",
  "createValidationTask",
  "allowSubtasks",
] as const;

export type AdvancedOptionField = (typeof ADVANCED_OPTION_FIELDS)[number];

export interface AdvancedOptionsProps {
  values: AdvancedOptionsValues;
  /** Called with a partial patch whenever the user edits a control. */
  onChange: (patch: Partial<AdvancedOptionsValues>) => void;
  /**
   * Fired alongside `onChange` with the field the user just edited. Lets the
   * new-task form remember which options were set by hand so repo defaults
   * never overwrite them.
   */
  onFieldTouched?: (field: AdvancedOptionField) => void;
  /** Which fields to render. Defaults to all of them, in canonical order. */
  fields?: readonly AdvancedOptionField[];

  // Open state. Uncontrolled (collapsed) unless `open` is passed.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;

  /** Header text. Defaults to "Advanced Options". */
  heading?: string;
  /** Extra "… set" chips for slot content the accordion doesn't own. */
  extraSummary?: string[];
  /** Rendered at the top of the expanded panel (e.g. an explanatory note). */
  intro?: ReactNode;
  /** Per-field replacements for the default helper text under each control. */
  hints?: Partial<Record<AdvancedOptionField, ReactNode>>;
  /** Task-only controls injected at fixed points in the field order. */
  slots?: {
    /** Between Model Override and Labels (depends-on, title). */
    afterModel?: ReactNode;
    /** Between Additional Instructions and the validation checkbox. */
    afterContext?: ReactNode;
    /** Below everything else (subtask splitting). */
    end?: ReactNode;
  };

  /** "Suggest budget" helper — omitted when there's no description to work from. */
  onSuggestBudget?: () => void;
  suggestingBudget?: boolean;
  /** "Suggest" helper for Additional Instructions. */
  onSuggestContext?: () => void;
  suggestingContext?: boolean;

  /**
   * Ask the server which provider would actually run right now and preselect
   * it. Only wanted on the task form — on the Repositories page an unset
   * provider must stay unset, otherwise saving a repo would silently pin it to
   * whichever provider happened to be default that day.
   */
  autoSelectDefaultProvider?: boolean;
  /**
   * Load providers/models as soon as the component mounts instead of waiting
   * for the accordion to be expanded. The Repositories page renders one
   * accordion per repo, so it opts out and only fetches on first open.
   */
  eager?: boolean;

  className?: string;
}

const EMPTY_LABELS: string[] = [];

export function AdvancedOptions({
  values,
  onChange,
  onFieldTouched,
  fields = ADVANCED_OPTION_FIELDS,
  open: controlledOpen,
  onOpenChange,
  heading = "Advanced Options",
  extraSummary = [],
  intro,
  hints = {},
  slots = {},
  onSuggestBudget,
  suggestingBudget = false,
  onSuggestContext,
  suggestingContext = false,
  autoSelectDefaultProvider = false,
  eager = false,
  className,
}: AdvancedOptionsProps) {
  const {
    priority,
    effort,
    costBudget,
    tokenBudget,
    aiProviderId,
    useSmartProvider = false,
    model,
    labels = EMPTY_LABELS,
    context = "",
    createValidationTask = false,
    allowSubtasks = false,
  } = values;

  const autoId = useId();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (next) setEverOpened(true);
    if (controlledOpen === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  const [labelInput, setLabelInput] = useState("");
  const [providers, setProviders] = useState<AIProvider[]>([]);
  // Seeded with the hard-coded model list (see src/lib/models.ts) rather than an
  // empty array, so the Model Override control is never blank on first render —
  // the fetches below only ever refine this, they don't need to succeed for the
  // field to exist.
  const [availableModels, setAvailableModels] = useState<{ id: string; label: string }[]>(ANTHROPIC_MODELS);
  const [providerDefaultModel, setProviderDefaultModel] = useState<string | null>(null);
  const [smartProviderName, setSmartProviderName] = useState<string | null>(null);
  // Set when every provider is rate-limited: the soonest-resetting one is still what the task
  // will run on, it just has to wait for that time first.
  const [smartProviderThrottledUntil, setSmartProviderThrottledUntil] = useState<string | null>(null);
  const [modelSelectValue, setModelSelectValue] = useState<string>(model ?? "");
  // Once expanded we keep fetching provider/model data on change, even if the
  // panel is collapsed again — re-fetching on every toggle would be wasteful.
  const [everOpened, setEverOpened] = useState(eager || controlledOpen === true);

  const shows = (field: AdvancedOptionField) => fields.includes(field);
  const shouldLoad = eager || everOpened;

  function update(patch: Partial<AdvancedOptionsValues>, field: AdvancedOptionField) {
    onChange(patch);
    onFieldTouched?.(field);
  }

  useEffect(() => {
    if (!shouldLoad) return;
    fetch("/api/providers")
      .then((r) => r.json())
      .then((data: AIProvider[]) => setProviders(data))
      .catch(() => {});

    // Ask the server which provider would actually run this task rather than picking the
    // isDefault one from the list — that can be disabled or throttled.
    if (autoSelectDefaultProvider && shows("aiProviderId") && !aiProviderId) {
      fetch("/api/providers/default")
        .then((r) => r.json())
        .then((data: { id: string | null }) => {
          // Not a user edit, so deliberately not routed through update() —
          // preselecting the default must not count as "the user chose this".
          if (data.id) onChange({ aiProviderId: data.id });
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldLoad]);

  // Sync modelSelectValue when the model prop changes (e.g. on edit form load).
  // Adjusted during render rather than in an effect, so there's no stale frame.
  const [syncedModel, setSyncedModel] = useState(model);
  if (syncedModel !== model) {
    setSyncedModel(model);
    if (model && model !== modelSelectValue) {
      setModelSelectValue(model);
    } else if (!model && modelSelectValue && modelSelectValue !== "custom") {
      setModelSelectValue("");
    }
  }

  // Fetch available models when the selected provider changes (or when smart provider is
  // toggled).
  //
  // The model list itself is a hard-coded static list (src/lib/models.ts) — these requests
  // only exist to ask the provider's live API for a possibly-richer list (e.g. custom
  // deployments) and to know the provider's configured default. So a failed/slow fetch
  // (flaky connection, dev server hiccup, etc.) must never blank out the Model Override
  // field — it should just fall back to the static list for the relevant provider type,
  // same as the server route already does internally.
  useEffect(() => {
    if (!shouldLoad || !shows("model")) return;
    if (useSmartProvider) {
      const fallbackModels = getModelsForProviderType("api");
      // Smart Provider: fetch the model list for whichever provider would be picked right now
      fetch("/api/providers/smart/models")
        .then((r) => r.json())
        .then((data: { models: { id: string; label: string }[]; defaultModel: string | null; resolvedProviderName: string | null; throttledUntil: string | null }) => {
          setAvailableModels(data.models && data.models.length > 0 ? data.models : fallbackModels);
          setProviderDefaultModel(data.defaultModel ?? null);
          setSmartProviderName(data.resolvedProviderName ?? null);
          setSmartProviderThrottledUntil(data.throttledUntil ?? null);
          // If the current model is not in the new model list, reset
          if (model && data.models.length > 0 && !data.models.some((m) => m.id === model)) {
            onChange({ model: null });
            setModelSelectValue("");
          }
        })
        .catch(() => { setAvailableModels(fallbackModels); setProviderDefaultModel(null); setSmartProviderName(null); setSmartProviderThrottledUntil(null); });
      return;
    }
    // When no explicit provider is chosen ("Default provider"), fall back to the
    // configured default provider so a model can still be pinned — otherwise the
    // Model Override control would silently disappear and there'd be no way to set
    // a model (this affected scheduled/recurring tasks left on the default provider).
    const resolvedProvider = providers.find((p) => p.id === aiProviderId)
      ?? providers.find((p) => p.isDefault && p.isEnabled)
      ?? providers.find((p) => p.isEnabled);
    const resolvedProviderId = aiProviderId ?? resolvedProvider?.id;
    const fallbackModels = getModelsForProviderType(resolvedProvider?.type ?? "api");
    // With no provider at all there's nothing to ask; an empty answer lands on the
    // same fallback path as a failed fetch.
    const modelsRequest: Promise<{ models: { id: string; label: string }[]; defaultModel: string | null }> = resolvedProviderId
      ? fetch(`/api/providers/${resolvedProviderId}/models`).then((r) => r.json())
      : Promise.resolve({ models: [], defaultModel: null });
    modelsRequest
      .then((data) => {
        setAvailableModels(data.models && data.models.length > 0 ? data.models : fallbackModels);
        setProviderDefaultModel(data.defaultModel ?? null);
        setSmartProviderName(null);
        // If the current model is not in the new model list, reset
        if (model && data.models.length > 0 && !data.models.some((m) => m.id === model)) {
          onChange({ model: null });
          setModelSelectValue("");
        }
      })
      .catch(() => { setAvailableModels(fallbackModels); setProviderDefaultModel(null); setSmartProviderName(null); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiProviderId, useSmartProvider, providers, shouldLoad]);

  function addLabel(raw: string) {
    const newLabel = raw.trim().toLowerCase();
    if (!newLabel) return;
    if (!labels.includes(newLabel)) update({ labels: [...labels, newLabel] }, "labels");
    setLabelInput("");
  }

  // Compact "title, labels, budget set" hint shown on the collapsed header, so
  // options buried inside the accordion aren't invisible.
  const summary = [
    ...extraSummary,
    shows("labels") && labels.length > 0 && "labels",
    shows("context") && context.trim() && "instructions",
    ((shows("costBudget") && costBudget) || (shows("tokenBudget") && tokenBudget)) && "budget",
    shows("aiProviderId") && (useSmartProvider ? "smart provider" : aiProviderId) && "provider",
    shows("model") && model && "model",
    shows("priority") && normalizePriority(priority) !== DEFAULT_PRIORITY &&
      `priority: ${PRIORITY_LABELS[normalizePriority(priority)].toLowerCase()}`,
    shows("effort") && normalizeEffort(effort) &&
      `effort: ${EFFORT_LABELS[normalizeEffort(effort) as TaskEffort].toLowerCase()}`,
    shows("createValidationTask") && createValidationTask && "validation task",
    shows("allowSubtasks") && allowSubtasks && "subtasks",
  ].filter(Boolean) as string[];

  const id = (suffix: string) => `${autoId}-${suffix}`;

  return (
    <div className={`border border-border/50 rounded-lg overflow-hidden ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center gap-2 w-full text-left px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors group"
      >
        <ChevronRight
          size={14}
          className={`text-muted-foreground transition-transform shrink-0 ${open ? "rotate-90" : ""}`}
        />
        <span className="text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors">
          {heading}
        </span>
        {!open && summary.length > 0 && (
          <span className="ml-2 text-xs text-primary/70 font-normal truncate">
            {summary.join(", ")} set
          </span>
        )}
      </button>

      {open && (
        <div className="px-4 py-4 flex flex-col gap-4 border-t border-border/50">
          {intro}

          {/* Priority */}
          {shows("priority") && (
            <div>
              <Label htmlFor={id("priority")}>Priority</Label>
              <Select
                value={normalizePriority(priority)}
                onValueChange={(v) => update({ priority: v }, "priority")}
              >
                <SelectTrigger id={id("priority")} className="mt-1">
                  <SelectValue>{PRIORITY_LABELS[normalizePriority(priority)]}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {PRIORITY_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {PRIORITY_LABELS[level]}
                      {level === DEFAULT_PRIORITY && <span className="ml-2 text-xs text-muted-foreground">default</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                {hints.priority ?? "Higher-priority tasks are picked up before lower-priority ones when the worker has more eligible tasks than open slots. Tasks at the same priority run in queue order."}
              </p>
            </div>
          )}

          {/* Effort */}
          {shows("effort") && (
            <div>
              <Label htmlFor={id("effort")}>Effort <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Select
                value={normalizeEffort(effort) ?? "__default__"}
                onValueChange={(v) => update({ effort: v === "__default__" ? null : v }, "effort")}
              >
                <SelectTrigger id={id("effort")} className="mt-1">
                  <SelectValue>{normalizeEffort(effort) ? EFFORT_LABELS[normalizeEffort(effort) as TaskEffort] : "Provider default"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__default__">
                    Provider default
                  </SelectItem>
                  {EFFORT_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {EFFORT_LABELS[level]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                {hints.effort ?? <>How much the model thinks before and while acting: higher effort trades latency and cost for more thorough reasoning. Passed as <code>--effort</code> on the Claude CLI or <code>output_config.effort</code> on the Anthropic API; ignored by providers that don&apos;t support it.</>}
              </p>
              {normalizeEffort(effort) && model && !modelSupportsEffort(model) && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                  {model} doesn&apos;t support an effort setting, so this is ignored and the model runs at its default.
                </p>
              )}
              {!normalizeEffort(effort) && model?.startsWith("claude-opus-5-5") && (
                <p className="text-xs text-muted-foreground mt-1">
                  Claude Opus 5.5 defaults to <strong>Medium</strong> effort (one step below Opus 5). For large coding tasks, consider High or Extra High.
                </p>
              )}
            </div>
          )}

          {/* Cost Budget */}
          {shows("costBudget") && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label htmlFor={id("costBudget")}>Cost Budget <span className="text-muted-foreground font-normal">(optional)</span></Label>
                {onSuggestBudget && (
                  <button
                    type="button"
                    disabled={suggestingBudget}
                    onClick={onSuggestBudget}
                    className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Use AI to estimate a cost budget based on your task description"
                  >
                    <Sparkles size={13} />
                    {suggestingBudget ? "Estimating…" : "Suggest budget"}
                  </button>
                )}
              </div>
              <div className="relative mt-1">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm pointer-events-none">$</span>
                <Input
                  id={id("costBudget")}
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={costBudget ?? ""}
                  onChange={(e) => update({ costBudget: e.target.value }, "costBudget")}
                  className="pl-7"
                  placeholder="e.g. 1.00"
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {hints.costBudget ?? "Max spend in USD. When reached, commits work and stops gracefully. Leave blank for no limit."}
              </p>
            </div>
          )}

          {/* Token Budget */}
          {shows("tokenBudget") && (
            <div>
              <Label htmlFor={id("tokenBudget")}>Token Budget (optional)</Label>
              <Input
                id={id("tokenBudget")}
                type="number"
                min="1000"
                step="1000"
                value={tokenBudget ?? ""}
                onChange={(e) => update({ tokenBudget: e.target.value }, "tokenBudget")}
                className="mt-1"
                placeholder="e.g. 50000"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {hints.tokenBudget ?? "Max total tokens (input + output). When reached, commits work to the branch and stops gracefully. Leave blank for no limit."}
              </p>
            </div>
          )}

          {/* AI Provider */}
          {shows("aiProviderId") && providers.length > 0 && (
            <div>
              <Label htmlFor={id("aiProvider")}>AI Provider</Label>
              <Select
                value={useSmartProvider ? "__smart__" : (aiProviderId ?? "")}
                onValueChange={(v) => {
                  if (v === "__smart__") {
                    update({ useSmartProvider: true, aiProviderId: null }, "aiProviderId");
                  } else {
                    update({ useSmartProvider: false, aiProviderId: v || null }, "aiProviderId");
                  }
                }}
              >
                <SelectTrigger id={id("aiProvider")} className="mt-1">
                  <SelectValue>
                    {useSmartProvider
                      ? "Smart Provider"
                      : providers.find((p) => p.id === aiProviderId)?.name ?? "Default provider"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">
                    Default provider
                  </SelectItem>
                  <SelectItem value="__smart__">
                    Smart Provider
                    <span className="ml-2 text-xs text-muted-foreground">auto-pick best available</span>
                  </SelectItem>
                  {providers.filter((p) => p.isEnabled).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                      {p.isDefault && <span className="ml-2 text-xs text-muted-foreground">default</span>}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                {hints.aiProviderId ?? <>Which AI provider runs this task. <strong>Smart Provider</strong> picks the best available provider when the task starts running (not now), prioritising CLI accounts whose credentials expire soonest.</>}
              </p>
            </div>
          )}

          {/* Model Override */}
          {shows("model") && availableModels.length > 0 && (
            <div>
              <Label htmlFor={id("model")}>
                {useSmartProvider ? "Model" : "Model Override"}{" "}
                <span className="text-muted-foreground font-normal">(optional)</span>
              </Label>
              {useSmartProvider && smartProviderName && (
                <p className="text-xs text-muted-foreground mt-0.5 mb-1">
                  {smartProviderThrottledUntil ? (
                    <>
                      Every provider is currently rate-limited. This task will wait for <strong>{smartProviderName}</strong>,
                      which resets at <strong>{new Date(smartProviderThrottledUntil).toLocaleString()}</strong>.
                    </>
                  ) : (
                    <>Smart Provider would currently pick <strong>{smartProviderName}</strong>, but the actual pick is made
                    fresh when the task starts running, so it may differ by then.</>
                  )} Its default model
                  {providerDefaultModel ? <> (<strong>{providerDefaultModel}</strong>)</> : null} will be used unless you pin one below.
                </p>
              )}
              {useSmartProvider && !smartProviderName && (
                <p className="text-xs text-muted-foreground mt-0.5 mb-1">
                  Smart Provider picks the best available provider at runtime. You can optionally pin a model.
                </p>
              )}
              <Select
                value={modelSelectValue}
                onValueChange={(v) => {
                  if (!v || v === "provider-default") {
                    setModelSelectValue("");
                    update({ model: null }, "model");
                  } else if (v === "custom") {
                    setModelSelectValue("custom");
                    update({ model: "" }, "model");
                  } else {
                    setModelSelectValue(v);
                    update({ model: v }, "model");
                  }
                }}
              >
                <SelectTrigger id={id("model")} className="mt-1">
                  <SelectValue placeholder={providerDefaultModel ? `Provider default (${providerDefaultModel})` : "Provider default"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="provider-default">
                    {providerDefaultModel ? `Provider default (${providerDefaultModel})` : "Provider default"}
                  </SelectItem>
                  {availableModels.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label} <span className="text-muted-foreground text-xs ml-1">{m.id}</span>
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">Custom…</SelectItem>
                </SelectContent>
              </Select>
              {modelSelectValue === "custom" && (
                <Input
                  value={model ?? ""}
                  onChange={(e) => update({ model: e.target.value }, "model")}
                  placeholder="e.g. my-custom-model-id"
                  className="mt-2 font-mono text-sm"
                  autoFocus
                />
              )}
              {!useSmartProvider && (
                <p className="text-xs text-muted-foreground mt-1">
                  {hints.model ?? "Use a different model for this task only."}
                </p>
              )}
            </div>
          )}

          {slots.afterModel}

          {/* Labels */}
          {shows("labels") && (
            <div>
              <Label>Labels <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <p className="text-xs text-muted-foreground mt-0.5 mb-2">
                {hints.labels ?? "Tag tasks by project, feature area, or priority for easy filtering."}
              </p>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {labels.map((label) => (
                  <span
                    key={label}
                    className="inline-flex items-center gap-1 bg-primary/10 text-primary text-xs px-2 py-0.5 rounded-full border border-primary/20"
                  >
                    {label}
                    <button
                      type="button"
                      onClick={() => update({ labels: labels.filter((l) => l !== label) }, "labels")}
                      className="hover:text-primary/60 transition-colors ml-0.5"
                      aria-label={`Remove label ${label}`}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={labelInput}
                  onChange={(e) => setLabelInput(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === ",") && labelInput.trim()) {
                      e.preventDefault();
                      addLabel(labelInput);
                    }
                    if (e.key === "Backspace" && !labelInput && labels.length > 0) {
                      update({ labels: labels.slice(0, -1) }, "labels");
                    }
                  }}
                  placeholder="Type a label and press Enter or comma…"
                  className="flex-1 text-sm"
                />
                {labelInput.trim() && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => addLabel(labelInput)}
                  >
                    Add
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Additional Instructions / Context */}
          {shows("context") && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label htmlFor={id("context")}>
                  Additional Instructions <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                {onSuggestContext && (
                  <button
                    type="button"
                    disabled={suggestingContext}
                    onClick={onSuggestContext}
                    className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Use AI to generate context suggestions from your description"
                  >
                    <Sparkles size={13} />
                    {suggestingContext ? "Generating…" : "Suggest"}
                  </button>
                )}
              </div>
              <Textarea
                id={id("context")}
                value={context}
                onChange={(e) => update({ context: e.target.value }, "context")}
                rows={3}
                className="mt-1"
                placeholder="Additional constraints, notes, or per-task instructions appended to the agent prompt..."
              />
              {hints.context && <p className="text-xs text-muted-foreground mt-1">{hints.context}</p>}
            </div>
          )}

          {slots.afterContext}

          {/* Follow-up validation task */}
          {shows("createValidationTask") && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <input
                  id={id("createValidationTask")}
                  type="checkbox"
                  checked={createValidationTask}
                  onChange={(e) => update({ createValidationTask: e.target.checked }, "createValidationTask")}
                  className="size-4 rounded border-2 border-muted-foreground accent-primary"
                />
                <Label htmlFor={id("createValidationTask")} className="cursor-pointer flex items-center gap-1.5">
                  <ClipboardCheck size={13} />
                  Create follow-up validation task
                </Label>
              </div>
              <p className="text-xs text-muted-foreground pl-7">
                {hints.createValidationTask ?? "When this task completes, automatically spawn a new AI task to verify the work was done correctly. The validation agent will review the output, check for errors, and flag any issues that need to be fixed."}
              </p>
            </div>
          )}

          {/* Agent-created subtasks */}
          {shows("allowSubtasks") && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <input
                  id={id("allowSubtasks")}
                  type="checkbox"
                  checked={allowSubtasks}
                  onChange={(e) => update({ allowSubtasks: e.target.checked }, "allowSubtasks")}
                  className="size-4 rounded border-2 border-muted-foreground accent-primary"
                />
                <Label htmlFor={id("allowSubtasks")} className="cursor-pointer flex items-center gap-1.5">
                  <ListTree size={13} />
                  Allow agent to create subtasks
                </Label>
              </div>
              <p className="text-xs text-muted-foreground pl-7">
                {hints.allowSubtasks ?? "Lets the agent split the work into separate tasks that are queued when it finishes, e.g. \"go through each exam and create a task to clean up its questions\". Subtasks reuse this task's repos and settings, and can't create further subtasks."}
              </p>
            </div>
          )}

          {slots.end}
        </div>
      )}
    </div>
  );
}
