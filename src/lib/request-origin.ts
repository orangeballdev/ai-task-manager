// Public origin of this deployment as the client sees it, honouring a reverse proxy's
// forwarded headers. Used wherever a route has to hand out absolute URLs (the MCP
// endpoint, OAuth metadata and redirects).
interface HeaderBag {
  get(name: string): string | null;
}

export function requestOrigin(req: { headers: HeaderBag; nextUrl?: { origin: string; protocol: string }; url?: string }): string {
  const fallback = req.nextUrl ?? (req.url ? new URL(req.url) : null);
  const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim() || req.headers.get("host");
  if (!host) return fallback?.origin ?? "http://localhost:3000";
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ||
    (fallback ? fallback.protocol.replace(/:$/, "") : "http");
  return `${proto}://${host}`;
}
