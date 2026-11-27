import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { parseApiKeyProvider, type ApiKeyProviderChoice } from "@/lib/api-key-provider";

export const API_KEY_SELECT = {
  id: true,
  name: true,
  keyPrefix: true,
  aiProviderId: true,
  useSmartProvider: true,
  lastUsedAt: true,
  createdAt: true,
} as const;

/**
 * Validates a `provider` value from the Settings → API form. A pinned id must name an
 * enabled connection — disabled ones are never used, so pinning one would be meaningless.
 */
export async function readProviderChoice(value: unknown): Promise<ApiKeyProviderChoice | NextResponse> {
  const choice = parseApiKeyProvider(value);
  if (!choice) {
    return NextResponse.json({ error: 'provider must be a provider id, "smart" or ""' }, { status: 400 });
  }
  if (choice.aiProviderId) {
    const provider = await prisma.aIProvider.findUnique({
      where: { id: choice.aiProviderId },
      select: { isEnabled: true },
    });
    if (!provider) return NextResponse.json({ error: "Provider not found" }, { status: 400 });
    if (!provider.isEnabled) return NextResponse.json({ error: "Provider is disabled" }, { status: 400 });
  }
  return choice;
}
