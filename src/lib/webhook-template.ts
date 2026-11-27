type TemplateContext = {
  body: unknown;
  headers: Record<string, string>;
};

function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else if (Array.isArray(current)) {
      const idx = Number(part);
      current = (current as unknown[])[idx];
    } else {
      return undefined;
    }
  }
  return current;
}

export function resolveTemplate(template: string, context: TemplateContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, rawPath: string) => {
    const path = rawPath.trim();
    let value: unknown;
    if (path.startsWith("headers.")) {
      value = getByPath(context.headers, path.slice("headers.".length));
    } else if (path.startsWith("body.")) {
      value = getByPath(context.body, path.slice("body.".length));
    } else {
      value = getByPath(context.body, path);
    }
    return value !== undefined && value !== null ? String(value) : "";
  });
}
