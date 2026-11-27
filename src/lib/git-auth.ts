import { prisma } from "@/lib/db";
import fs from "fs/promises";
import os from "os";
import path from "path";

export interface GitCredentials {
  token?: string;
  sshKeyPath?: string;
  userName?: string;
  userEmail?: string;
}

export async function loadGitCredentials(): Promise<GitCredentials> {
  const settings = await prisma.setting.findMany({
    where: { key: { in: ["git_access_token", "git_ssh_key", "git_user_name", "git_user_email"] } },
  });
  const map = Object.fromEntries(settings.map((s: { key: string; value: string }) => [s.key, s.value]));

  const creds: GitCredentials = {};

  if (map.git_access_token) {
    creds.token = map.git_access_token;
  }

  if (map.git_user_name) creds.userName = map.git_user_name;
  if (map.git_user_email) creds.userEmail = map.git_user_email;

  if (map.git_ssh_key) {
    const keyPath = path.join(os.tmpdir(), `ctm-ssh-${Date.now()}`);
    // Normalize line endings and ensure trailing newline — OpenSSH requires both
    const normalized = map.git_ssh_key.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd() + "\n";
    await fs.writeFile(keyPath, normalized, { mode: 0o600 });
    creds.sshKeyPath = keyPath;
  }

  return creds;
}

// Convert a git@ SSH URL to HTTPS: git@host:org/repo.git → https://host/org/repo.git
export function sshToHttps(url: string): string {
  const match = url.match(/^git@([^:]+):(.+)$/);
  if (!match) return url;
  return `https://${match[1]}/${match[2]}`;
}

// Inject HTTPS token into a git URL.
// x-access-token works for both GitHub (official) and GitLab (accepts any username).
export function injectToken(url: string, token: string): string {
  try {
    const u = new URL(url);
    u.username = "x-access-token";
    u.password = token;
    return u.toString();
  } catch {
    return url;
  }
}

export async function loadGitProviderSettings(): Promise<{ provider: string; baseUrl: string; defaultBaseBranch: string }> {
  const settings = await prisma.setting.findMany({
    where: { key: { in: ["git_provider", "git_base_url", "git_default_base_branch"] } },
  });
  const map = Object.fromEntries(settings.map((s: { key: string; value: string }) => [s.key, s.value]));
  return {
    provider: map.git_provider ?? "github",
    baseUrl: map.git_base_url ?? "",
    defaultBaseBranch: map.git_default_base_branch || "main",
  };
}
