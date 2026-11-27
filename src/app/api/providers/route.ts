import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseMaxUsagePercentInput as parseMaxUsagePercent } from "@/lib/usage-cap";
import { homedir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

const PROVIDER_TYPES = ["cli", "api", "openai", "claude-pki", "codex-cli"];

// Masks the API key and strips the raw PKI certificate/passphrase (binary + secret)
// from anything sent to the client — only a boolean "is one configured" is exposed.
function sanitizeProvider(provider: { apiKey: string | null; pkiCertData?: unknown; pkiCertPassphrase?: string | null; [key: string]: unknown }) {
  const rest = { ...provider };
  delete rest.pkiCertData;
  delete rest.pkiCertPassphrase;
  return {
    ...rest,
    apiKey: provider.apiKey ? "***" : null,
    pkiCertConfigured: !!provider.pkiCertData,
  };
}

export async function GET() {
  const providers = await prisma.aIProvider.findMany({ orderBy: { createdAt: "asc" } });
  return NextResponse.json(providers.map(sanitizeProvider));
}

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    name: string;
    type: string;
    isEnabled?: boolean;
    excludeFromSmartPicker?: boolean;
    maxUsagePercent?: number;
    configDir?: string;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    proxyUrl?: string;
  };

  const { name, type, isEnabled = true, excludeFromSmartPicker = false, configDir, apiKey, baseUrl, model, proxyUrl } = body;

  if (!name?.trim()) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!PROVIDER_TYPES.includes(type)) return NextResponse.json({ error: `type must be one of: ${PROVIDER_TYPES.join(", ")}` }, { status: 400 });
  const maxUsagePercent = parseMaxUsagePercent(body.maxUsagePercent);
  if (maxUsagePercent === null) return NextResponse.json({ error: "maxUsagePercent must be a whole number from 1 to 100" }, { status: 400 });

  const existingCount = await prisma.aIProvider.count();

  // First provider is always the default; subsequent providers never override it on creation
  const makeDefault = existingCount === 0;

  // Each CLI provider gets its own isolated config dir so credentials don't overwrite each other
  let resolvedConfigDir: string | null = configDir?.trim() || null;
  if (type === "cli" && !resolvedConfigDir) {
    const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const suffix = randomBytes(4).toString("hex");
    resolvedConfigDir = join(homedir(), ".claude-task-manager", `${slug}-${suffix}`);
  }

  const provider = await prisma.aIProvider.create({
    data: {
      name: name.trim(),
      type,
      isDefault: makeDefault,
      isEnabled,
      excludeFromSmartPicker,
      maxUsagePercent: maxUsagePercent ?? 100,
      configDir: resolvedConfigDir,
      apiKey: apiKey?.trim() || null,
      baseUrl: baseUrl?.trim() || null,
      model: model?.trim() || null,
      proxyUrl: type === "claude-pki" ? (proxyUrl?.trim() || null) : null,
    },
  });

  return NextResponse.json(sanitizeProvider(provider), { status: 201 });
}
