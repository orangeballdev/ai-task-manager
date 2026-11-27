/**
 * GET a JSON endpoint from client code. Rejects on a non-2xx response so an
 * error body (`{ error: "…" }`) is never stored as if it were the data.
 */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}
