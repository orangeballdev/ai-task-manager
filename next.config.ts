import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["192.168.1.*", "localhost", "127.0.0.1"],
  // OpenTelemetry (src/lib/otel.ts) is loaded from node_modules at runtime rather
  // than bundled, so instrumentation.ts and the route handlers share one copy of
  // the SDK instead of each chunk getting its own.
  serverExternalPackages: [
    "@grpc/grpc-js",
    "@prisma/instrumentation",
    "@opentelemetry/api",
    "@opentelemetry/api-logs",
    "@opentelemetry/context-async-hooks",
    "@opentelemetry/instrumentation",
    "@opentelemetry/instrumentation-http",
    "@opentelemetry/instrumentation-undici",
    "@opentelemetry/resources",
    "@opentelemetry/sdk-trace-base",
    "@opentelemetry/sdk-metrics",
    "@opentelemetry/sdk-logs",
    "@opentelemetry/exporter-trace-otlp-proto",
    "@opentelemetry/exporter-metrics-otlp-proto",
    "@opentelemetry/exporter-logs-otlp-proto",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/exporter-metrics-otlp-http",
    "@opentelemetry/exporter-logs-otlp-http",
    "@opentelemetry/exporter-trace-otlp-grpc",
    "@opentelemetry/exporter-metrics-otlp-grpc",
    "@opentelemetry/exporter-logs-otlp-grpc",
  ],
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
