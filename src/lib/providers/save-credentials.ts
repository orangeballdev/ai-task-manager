import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { prisma } from "@/lib/db";
import { claimCredentialOwner } from "./cli-credentials";

export function resolveCliConfigDir(configDir: string | null, type: string): string {
  return configDir?.trim() || join(homedir(), type === "codex-cli" ? ".codex" : ".claude");
}

export function cliCredentialsFileName(type: string): string {
  return type === "codex-cli" ? "auth.json" : ".credentials.json";
}

/**
 * Store a subscription CLI provider's login: in the DB (so it survives container rebuilds) and
 * in its config dir (so the CLI can use it straight away), claiming the dir for this provider.
 * Also clears the auth-failure notification cooldown, so a later failure of the new login
 * is reported rather than swallowed. Returns a warning when only the disk write failed.
 */
export async function saveProviderCredentials(
  provider: { id: string; type: string; configDir: string | null },
  credentialsJson: string,
): Promise<{ warning?: string }> {
  await prisma.aIProvider.update({
    where: { id: provider.id },
    data: { credentialsJson, authFailureNotifiedAt: null },
  });

  const dir = resolveCliConfigDir(provider.configDir, provider.type);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, cliCredentialsFileName(provider.type)), credentialsJson, { encoding: "utf8", mode: 0o600 });
    claimCredentialOwner(dir, provider.id);
    return {};
  } catch (err) {
    // DB save succeeded; the worker writes the DB copy to disk before every run anyway.
    return { warning: `Disk write failed: ${String(err)}` };
  }
}
