/**
 * Records a person's verdict on a task's work (`human_review` evaluation) from the app
 * process — approve / merge / request changes. Fire-and-forget: telemetry never affects
 * the action that triggered it. The run's trace has long ended by then, so the event is
 * parented on the ids the worker saved when the run started (Task.telemetryTraceId/SpanId),
 * which puts the score in that run's trace.
 */
import { TraceFlags, trace } from "@opentelemetry/api";
import { prisma } from "./db";
import { recordEvaluation } from "./gen-ai-otel";
import { humanReviewEvaluation, savedSpanContext, type ReviewVerdict } from "./gen-ai-telemetry";

interface ReviewedTask {
  model: string | null;
  provider: string | null;
  aiProvider: { type: string } | null;
  telemetryTraceId: string | null;
  telemetrySpanId: string | null;
}

export function recordTaskReview(taskId: string, verdict: ReviewVerdict): void {
  void prisma.task
    .findUnique({ where: { id: taskId }, select: { model: true, provider: true, aiProvider: { select: { type: true } }, telemetryTraceId: true, telemetrySpanId: true } })
    .then((t: ReviewedTask | null) => {
      const saved = savedSpanContext(t?.telemetryTraceId, t?.telemetrySpanId);
      const parent = saved ? trace.wrapSpanContext({ ...saved, traceFlags: TraceFlags.SAMPLED, isRemote: true }) : undefined;
      recordEvaluation(humanReviewEvaluation(verdict), {
        taskId,
        providerType: t?.aiProvider?.type ?? t?.provider,
        model: t?.model,
      }, parent);
    })
    .catch(() => {});
}
