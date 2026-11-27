// Generates cURL/JavaScript/Python request samples for a documented endpoint. Shared by
// the static code blocks on /docs/api and (with real values substituted in) by the
// "Try it" console, so the snippet a visitor copies always matches what their test
// request actually sent.
import type { ApiEndpoint } from "./api-endpoints";

export function resolvePath(endpoint: ApiEndpoint, pathValues: Record<string, string>): string {
  let path = endpoint.path;
  for (const p of endpoint.pathParams ?? []) {
    path = path.replace(`{${p.name}}`, pathValues[p.name]?.trim() || `{${p.name}}`);
  }
  return path;
}

export function withQuery(path: string, query: Record<string, string>): string {
  const entries = Object.entries(query).filter(([, v]) => v.trim() !== "");
  if (entries.length === 0) return path;
  const qs = new URLSearchParams(entries).toString();
  return `${path}?${qs}`;
}

export interface SampleOptions {
  origin: string;
  apiKey: string;
  pathValues: Record<string, string>;
  queryValues: Record<string, string>;
  body?: string;
}

function fullUrl(endpoint: ApiEndpoint, opts: SampleOptions): string {
  return `${opts.origin}${withQuery(resolvePath(endpoint, opts.pathValues), opts.queryValues)}`;
}

export function buildCurl(endpoint: ApiEndpoint, opts: SampleOptions): string {
  const url = fullUrl(endpoint, opts);
  const key = opts.apiKey || "tm_live_...";
  const lines = [`curl ${endpoint.method !== "GET" ? `-X ${endpoint.method} ` : ""}"${url}" \\`, `  -H "Authorization: Bearer ${key}"`];
  if (opts.body) {
    lines[lines.length - 1] += " \\";
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push(`  -d '${opts.body.replace(/'/g, "'\\''")}'`);
  }
  return lines.join("\n");
}

export function buildJavaScript(endpoint: ApiEndpoint, opts: SampleOptions): string {
  const url = fullUrl(endpoint, opts);
  const key = opts.apiKey || "tm_live_...";
  const bodyLine = opts.body ? `\n  body: JSON.stringify(${indentJson(opts.body)}),` : "";
  return [
    `const res = await fetch("${url}", {`,
    `  method: "${endpoint.method}",`,
    `  headers: {`,
    `    "Authorization": "Bearer ${key}",${opts.body ? `\n    "Content-Type": "application/json",` : ""}`,
    `  },${bodyLine}`,
    `});`,
    `const { data } = await res.json();`,
  ].join("\n");
}

export function buildPython(endpoint: ApiEndpoint, opts: SampleOptions): string {
  const url = fullUrl(endpoint, opts);
  const key = opts.apiKey || "tm_live_...";
  const lines = [
    `import requests`,
    ``,
    `res = requests.request(`,
    `    "${endpoint.method}",`,
    `    "${url}",`,
    `    headers={"Authorization": "Bearer ${key}"},`,
  ];
  if (opts.body) {
    lines.push(`    json=${pythonize(opts.body)},`);
  }
  lines.push(`)`, `data = res.json()["data"]`);
  return lines.join("\n");
}

function indentJson(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2).split("\n").join("\n  ");
  } catch {
    return json;
  }
}

function pythonize(json: string): string {
  // Good enough for our example payloads: JSON and Python dict literals agree except
  // for true/false/null, which is all we need to swap for a readable sample.
  try {
    const obj = JSON.parse(json);
    return JSON.stringify(obj, null, 4)
      .replace(/: true/g, ": True")
      .replace(/: false/g, ": False")
      .replace(/: null/g, ": None")
      .split("\n")
      .join("\n    ");
  } catch {
    return json;
  }
}
