// Who's on the other end of a request, for the audit log and rate limiting.
interface HeaderBag {
  get(name: string): string | null;
}

export function clientIp(headers: HeaderBag): string | null {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0].trim();
    if (first) return first.slice(0, 100);
  }
  return headers.get("x-real-ip")?.trim().slice(0, 100) || null;
}

export function clientUserAgent(headers: HeaderBag): string | null {
  return headers.get("user-agent")?.slice(0, 500) || null;
}
