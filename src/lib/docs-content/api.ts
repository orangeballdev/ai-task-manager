// Content of the /docs/api page, shared with the MCP get_docs tool. The endpoints themselves
// come from API_ENDPOINTS (src/lib/api-endpoints.ts), which also drives the page's "Try it" console.
import { API_BASE_PATH, API_ENDPOINTS, type ApiParam } from "@/lib/api-endpoints";
import { absoluteLinks, mdCode, mdDoc, mdTable } from "./markdown";

export const API_DOC = {
  title: "API Reference",
  intro:
    "A small REST API for driving the Task Manager from your own code: create a task, start it, and pull back its " +
    "status and results. Every endpoint below has a live console you can send real requests from right on this page.",
  auth:
    "Every request needs an API key sent as a Bearer token. Create one under [Settings → API](/settings/api), then " +
    "include it on every request:",
  authHeader: "Authorization: Bearer tm_live_...",
  authNote:
    "Keys aren't scoped yet — anyone with a key can create, start, and read any task. Treat it like a password and " +
    "store it server-side, not in a public client.",
  baseUrl: (origin: string) =>
    `All endpoints are relative to your own deployment's origin, e.g. \`${origin.replace(/\/+$/, "")}${API_BASE_PATH}\`.`,
  errors: "Errors return a non-2xx status with a JSON body shaped like:",
  errorExample: JSON.stringify({ error: { message: "No task found with id '...'.", code: "not_found" } }, null, 2),
};

function paramsTable(title: string, params: ApiParam[] | undefined): string | null {
  if (!params?.length) return null;
  return `**${title}**\n\n${mdTable(
    ["Name", "Type", "Required", "Description"],
    params.map((p) => [`\`${p.name}\``, p.type, p.required ? "yes" : "", p.description]),
  )}`;
}

export function apiDocsMarkdown(origin: string): string {
  const d = API_DOC;
  return absoluteLinks(
    mdDoc(
      `# ${d.title}`,
      d.intro.replace(" Every endpoint below has a live console you can send real requests from right on this page.", ""),
      "## Authentication",
      d.auth,
      mdCode(d.authHeader),
      d.authNote,
      "## Base URL",
      d.baseUrl(origin),
      "## Errors",
      d.errors,
      mdCode(d.errorExample, "json"),
      ...API_ENDPOINTS.map((e) =>
        mdDoc(
          `## ${e.summary}`,
          `\`${e.method} ${e.path}\``,
          e.description,
          paramsTable("Path parameters", e.pathParams),
          paramsTable("Query parameters", e.queryParams),
          paramsTable("Body parameters", e.bodyParams),
          e.bodyExample && `**Example request body**\n\n${mdCode(e.bodyExample, "json")}`,
          `**Example response (${e.successStatus})**\n\n${mdCode(e.responseExample, "json")}`,
        ),
      ),
    ),
    origin,
  );
}
