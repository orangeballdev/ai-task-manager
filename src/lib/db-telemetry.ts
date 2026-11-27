/**
 * Database metrics for every Prisma client in the app (lib/db.ts, the worker's
 * and the integrations' own clients). Unlike the optional query *spans* — see
 * `syncPrismaInstrumentation()` in otel.ts — these cover every query, including
 * the background polling the sampler drops, and cost almost nothing: they are
 * aggregated in-process and only exported on the metric interval.
 *
 * Also emits a warning log for any query slower than SLOW_QUERY_MS, which is
 * the quickest way to spot SQLite lock contention.
 */
import fs from "fs";
import type { Histogram, Meter } from "@opentelemetry/api";
import { emitLog, getMeter, onMeterReady } from "./otel";

const SLOW_QUERY_MS = 500;
// Seconds; the OTel semantic-convention advice for db.client.operation.duration.
const DURATION_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10];

const histograms = new WeakMap<Meter, Histogram>();

function durationHistogram(): Histogram {
  const meter = getMeter();
  let h = histograms.get(meter);
  if (!h) {
    h = meter.createHistogram("db.client.operation.duration", {
      description: "Duration of database operations",
      unit: "s",
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    });
    histograms.set(meter, h);
  }
  return h;
}

/** Wraps a Prisma client so every operation is timed. Returns the extended client. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withDbTelemetry<T extends { $extends: (...args: any[]) => any }>(client: T): T {
  return client.$extends({
    query: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async $allOperations({ model, operation, args, query }: any) {
        const start = performance.now();
        let errorType: string | undefined;
        try {
          return await query(args);
        } catch (err) {
          errorType = (err as { code?: string })?.code ?? (err instanceof Error ? err.name : "error");
          throw err;
        } finally {
          const ms = performance.now() - start;
          const attributes = {
            "db.system.name": "sqlite",
            "db.operation.name": operation as string,
            ...(model ? { "db.collection.name": model as string } : {}),
            ...(errorType ? { "error.type": errorType } : {}),
          };
          try {
            durationHistogram().record(ms / 1000, attributes);
            if (ms >= SLOW_QUERY_MS) {
              emitLog(`Slow query: ${model ? `${model}.` : ""}${operation} took ${Math.round(ms)}ms`, "warn", {
                ...attributes,
                "ctm.log.source": "db",
                "ctm.db.duration_ms": Math.round(ms),
              });
            }
          } catch {
            /* telemetry must never affect the query */
          }
        }
      },
    },
  }) as T;
}

/** SQLite file-size gauges (main DB and its WAL). Registered by one process — the worker. */
export function registerDbSizeGauges(dbPath: string): void {
  onMeterReady((meter) => {
    meter.createObservableGauge("ctm.db.size", { description: "Size of the SQLite database files", unit: "By" })
      .addCallback((result) => {
        for (const [file, suffix] of [["main", ""], ["wal", "-wal"]] as const) {
          try {
            result.observe(fs.statSync(dbPath + suffix).size, { "db.file": file });
          } catch {
            /* file may not exist (e.g. no WAL yet) */
          }
        }
      });
  });
}
