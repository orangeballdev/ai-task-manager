import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseMaxUsagePercentInput as parseMaxUsagePercent } from "@/lib/usage-cap";
import { revalidateProviderThrottle } from "@/lib/provider-throttle";

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

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json() as {
    name?: string;
    type?: string;
    isDefault?: boolean;
    isEnabled?: boolean;
    excludeFromSmartPicker?: boolean;
    maxUsagePercent?: number;
    configDir?: string | null;
    apiKey?: string | null;
    baseUrl?: string | null;
    model?: string | null;
    proxyUrl?: string | null;
  };

  const existing = await prisma.aIProvider.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (body.type !== undefined && !PROVIDER_TYPES.includes(body.type)) {
    return NextResponse.json({ error: `type must be one of: ${PROVIDER_TYPES.join(", ")}` }, { status: 400 });
  }

  const maxUsagePercent = parseMaxUsagePercent(body.maxUsagePercent);
  if (maxUsagePercent === null) {
    return NextResponse.json({ error: "maxUsagePercent must be a whole number from 1 to 100" }, { status: 400 });
  }

  // When setting a new default, unset the old one
  if (body.isDefault === true && !existing.isDefault) {
    await prisma.aIProvider.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  }

  // Can't un-default the only default (must set another first)
  if (body.isDefault === false && existing.isDefault) {
    const otherDefault = await prisma.aIProvider.count({ where: { isDefault: true, id: { not: id } } });
    if (otherDefault === 0) {
      return NextResponse.json({ error: "Cannot remove default, set another provider as default first" }, { status: 400 });
    }
  }

  const apiKeyUpdate = body.apiKey === null ? null
    : body.apiKey === "***" ? existing.apiKey  // unchanged masked value
    : body.apiKey?.trim() || null;

  const provider = await prisma.aIProvider.update({
    where: { id },
    data: {
      ...(body.name !== undefined && { name: body.name.trim() }),
      ...(body.type !== undefined && { type: body.type }),
      ...(body.isDefault !== undefined && { isDefault: body.isDefault }),
      ...(body.isEnabled !== undefined && { isEnabled: body.isEnabled }),
      ...(body.excludeFromSmartPicker !== undefined && { excludeFromSmartPicker: body.excludeFromSmartPicker }),
      ...(maxUsagePercent !== undefined && { maxUsagePercent }),
      ...(body.configDir !== undefined && { configDir: body.configDir?.trim() || null }),
      ...("apiKey" in body && { apiKey: apiKeyUpdate }),
      ...(body.baseUrl !== undefined && { baseUrl: body.baseUrl?.trim() || null }),
      ...(body.model !== undefined && { model: body.model?.trim() || null }),
      ...(body.proxyUrl !== undefined && { proxyUrl: body.proxyUrl?.trim() || null }),
    },
  });

  // A changed usage cap can change whether a recorded throttle still holds (raising it can free a
  // provider that was only held back by the old cap). Re-check against live usage now rather
  // than leaving it parked until the window resets.
  if (maxUsagePercent !== undefined && maxUsagePercent !== existing.maxUsagePercent && provider.throttledUntil) {
    await revalidateProviderThrottle(provider).catch(() => {});
  }

  return NextResponse.json(sanitizeProvider(provider));
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const existing = await prisma.aIProvider.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (existing.isDefault) {
    const total = await prisma.aIProvider.count();
    if (total === 1) {
      // Deleting the last provider — allow it
    } else {
      return NextResponse.json({ error: "Cannot delete the default provider, set another as default first" }, { status: 400 });
    }
  }

  // Nullify aiProviderId on tasks that used this provider
  await prisma.task.updateMany({ where: { aiProviderId: id }, data: { aiProviderId: null } });
  await prisma.aIProvider.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
