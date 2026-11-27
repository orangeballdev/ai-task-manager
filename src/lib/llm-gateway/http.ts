/**
 * HTTP plumbing for the LLM gateway routes (`/api/llm/v1/*`): authentication, provider
 * resolution, error envelopes in each API's own shape, and SSE responses.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { findApiKey, type AuthedApiKey } from "@/lib/api-auth";
import { getProvider, providerUnavailableMessage } from "@/lib/smart-provider";
import { GatewayRequestError } from "./convert";
import { GatewayUpstreamError, type GatewayProvider } from "./backends";
import { gatewayPausedMessage, gatewayRetryAfterSeconds } from "./pause";
import { getGatewayPause } from "./pause-store";

export type GatewayFormat = "openai" | "anthropic";

const ANTHROPIC_ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  503: "overloaded_error",
  529: "overloaded_error",
};

const OPENAI_ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "invalid_request_error",
  404: "invalid_request_error",
  429: "rate_limit_exceeded",
};

export function errorBody(format: GatewayFormat, status: number, message: string): Record<string, unknown> {
  if (format === "anthropic") {
    return { type: "error", error: { type: ANTHROPIC_ERROR_TYPES[status] ?? "api_error", message } };
  }
  return { error: { message, type: OPENAI_ERROR_TYPES[status] ?? "server_error", param: null, code: null } };
}

export function errorResponse(format: GatewayFormat, status: number, message: string): Response {
  return Response.json(errorBody(format, status, message), { status });
}

/** Status + message for anything a backend can throw, keeping upstream API statuses intact. */
export function describeError(err: unknown): { status: number; message: string } {
  if (err instanceof GatewayRequestError) return { status: 400, message: err.message };
  if (err instanceof GatewayUpstreamError) return { status: err.status, message: err.message };
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) {
    const body = err.error as { error?: { message?: string }; message?: string } | undefined;
    const message = body?.error?.message ?? body?.message ?? err.message;
    return { status: err.status ?? 502, message };
  }
  return { status: 500, message: err instanceof Error ? err.message : "Gateway request failed" };
}

/**
 * Accepts the key the way either SDK sends it: OpenAI clients use `Authorization: Bearer`,
 * Anthropic clients use `x-api-key` (or Bearer when configured with an auth token).
 */
export async function authenticateGateway(req: Request, format: GatewayFormat): Promise<Response | AuthedApiKey> {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization")?.trim() ?? "")?.[1]?.trim();
  const token = bearer || req.headers.get("x-api-key")?.trim() || "";
  if (!token) {
    return errorResponse(format, 401, "No API key provided. Send a task manager API key (Settings → API) as the provider API key.");
  }
  const apiKey = await findApiKey(token);
  if (!apiKey) return errorResponse(format, 401, "Invalid API key.");
  // Temporarily disabled from /analytics/gateway or Settings → API. Checked after the key so
  // an unauthenticated caller learns nothing; a 503 is what SDKs treat as "try later".
  const pause = await getGatewayPause();
  if (pause.paused) {
    const res = errorResponse(format, 503, gatewayPausedMessage(pause));
    const retryAfter = gatewayRetryAfterSeconds(pause);
    if (retryAfter != null) res.headers.set("retry-after", String(retryAfter));
    return res;
  }
  return apiKey;
}

/**
 * The provider this request runs on: the same resolution the worker uses, starting from the
 * API key's choice (Settings → API) — a pinned connection, smart pick, or neither (default
 * chain). A pin that's since been disabled, deleted or rate-limited falls through to smart
 * pick → default → any enabled rather than failing the request.
 */
export async function resolveGatewayProvider(
  format: GatewayFormat,
  apiKey: Pick<AuthedApiKey, "aiProviderId" | "useSmartProvider">,
): Promise<GatewayProvider | Response> {
  const { provider, throttledFallback } = await getProvider({
    explicitProviderId: apiKey.aiProviderId,
    useSmartProvider: apiKey.useSmartProvider,
  });
  if (!provider) {
    return errorResponse(format, throttledFallback ? 429 : 503, providerUnavailableMessage(throttledFallback));
  }
  return provider as GatewayProvider;
}

export async function readJson<T>(req: Request, format: GatewayFormat): Promise<T | Response> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as T;
  } catch {
    return errorResponse(format, 400, "Request body must be a JSON object.");
  }
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

/**
 * Streams `items` as SSE. Anthropic events carry an `event:` line named after their type;
 * OpenAI chunks are bare `data:` lines ending with `data: [DONE]`. An error after the stream
 * has started can't change the status any more, so it's sent as an error event instead.
 */
export function sseResponse(
  format: GatewayFormat,
  items: AsyncIterable<{ type?: string } | object>,
  abort: AbortController,
): Response {
  const encoder = new TextEncoder();
  const iterator = items[Symbol.asyncIterator]();

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          if (format === "openai") controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        const type = (value as { type?: string }).type;
        const prefix = format === "anthropic" && type ? `event: ${type}\n` : "";
        controller.enqueue(encoder.encode(`${prefix}data: ${JSON.stringify(value)}\n\n`));
      } catch (err) {
        if (abort.signal.aborted) {
          controller.close();
          return;
        }
        const { status, message } = describeError(err);
        const prefix = format === "anthropic" ? "event: error\n" : "";
        controller.enqueue(encoder.encode(`${prefix}data: ${JSON.stringify(errorBody(format, status, message))}\n\n`));
        controller.close();
      }
    },
    async cancel() {
      abort.abort();
      await iterator.return?.();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

/** Ties the upstream call to the client connection, so a dropped client stops the CLI/API call. */
export function linkAbort(req: Request): AbortController {
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  return abort;
}
