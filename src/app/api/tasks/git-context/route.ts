import { NextRequest, NextResponse } from "next/server";
import { simpleGit } from "simple-git";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { loadGitCredentials, injectToken } from "@/lib/git-auth";
import { safeEnv } from "@/lib/git";

const MAX_README_CHARS = 3000;
const MAX_FILE_CHARS = 2000;
const MAX_SOURCE_FILES = 8;
const MAX_TOTAL_SOURCE_CHARS = 12000;

const IGNORED_DIRS = new Set(["node_modules", "__pycache__", ".git", "dist", "build", ".next", "target", "vendor", ".venv", "venv", "coverage", ".cache", "out", ".turbo"]);
const IGNORED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mp3", ".pdf", ".zip", ".tar", ".gz", ".lock", ".map"]);

async function readFileSafe(filePath: string, maxChars = MAX_FILE_CHARS): Promise<string | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content.length > maxChars ? content.slice(0, maxChars) + "\n...(truncated)" : content;
  } catch {
    return null;
  }
}

async function getDirectoryStructure(dirPath: string, depth = 3, prefix = ""): Promise<string> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const filtered = entries
      .filter((e) => !e.name.startsWith(".") && !IGNORED_DIRS.has(e.name))
      .slice(0, 30);

    let result = "";
    for (const entry of filtered) {
      result += `${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}\n`;
      if (entry.isDirectory() && depth > 1) {
        result += await getDirectoryStructure(path.join(dirPath, entry.name), depth - 1, prefix + "  ");
      }
    }
    return result;
  } catch {
    return "";
  }
}

/** Recursively collect source file paths, sorted by priority */
async function collectSourceFiles(dirPath: string, repoRoot: string, depth = 4): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || depth <= 1) continue;
        const sub = await collectSourceFiles(fullPath, repoRoot, depth - 1);
        files.push(...sub);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (IGNORED_EXTENSIONS.has(ext)) continue;
        files.push(fullPath);
      }
    }
  } catch {
    // ignore
  }
  return files;
}

/** Score a file path for relevance — higher = more interesting to read */
function scoreFile(filePath: string, repoRoot: string): number {
  const rel = path.relative(repoRoot, filePath);
  const parts = rel.split(path.sep);
  const name = path.basename(filePath);
  const ext = path.extname(name).toLowerCase();
  const stem = name.slice(0, -ext.length).toLowerCase();

  let score = 0;

  // Source code extensions
  const sourceExts: Record<string, number> = {
    ".ts": 10, ".tsx": 10, ".js": 8, ".jsx": 8, ".py": 10,
    ".go": 10, ".rs": 10, ".rb": 8, ".java": 8, ".kt": 8,
    ".cs": 8, ".cpp": 6, ".c": 6, ".swift": 8, ".php": 6,
    ".ex": 8, ".exs": 8, ".zig": 8, ".vue": 8, ".svelte": 8,
  };
  score += sourceExts[ext] ?? 0;

  // Penalize deep nesting
  score -= (parts.length - 1) * 2;

  // Boost entry point / main files
  const entryNames = ["index", "main", "app", "server", "cli", "mod", "lib"];
  if (entryNames.includes(stem)) score += 15;

  // Boost files in src/, lib/, app/ directories
  const topDir = parts[0]?.toLowerCase() ?? "";
  if (["src", "lib", "app", "core", "pkg"].includes(topDir)) score += 8;

  // Boost routes, api, handlers, controllers
  const secondDir = parts[1]?.toLowerCase() ?? "";
  if (["routes", "api", "handlers", "controllers", "services", "models"].includes(secondDir)) score += 6;
  if (["routes", "api", "handlers", "controllers", "services", "models"].includes(topDir)) score += 6;

  // Boost config/setup files
  if (["config", "setup", "settings"].includes(stem)) score += 5;

  // Penalize test files (useful but less priority)
  if (rel.includes("test") || rel.includes("spec") || stem.endsWith(".test") || stem.endsWith(".spec")) score -= 8;

  // Penalize generated/migration files
  if (rel.includes("migration") || rel.includes("generated") || rel.includes("__generated__")) score -= 10;

  return score;
}

/** Detect project type hints from config files */
function detectProjectType(packageJson: string | null, pyproject: string | null, cargoToml: string | null, goMod: string | null): string[] {
  const hints: string[] = [];
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson) as Record<string, unknown>;
      const deps = { ...(pkg.dependencies as Record<string, string> ?? {}), ...(pkg.devDependencies as Record<string, string> ?? {}) };
      if (deps.next) hints.push("nextjs");
      if (deps.react) hints.push("react");
      if (deps.express) hints.push("express");
      if (deps.fastify) hints.push("fastify");
      if (deps.vue) hints.push("vue");
      if (deps.svelte) hints.push("svelte");
      if (deps["@nestjs/core"]) hints.push("nestjs");
    } catch { /* ignore */ }
    hints.push("nodejs");
  }
  if (pyproject) hints.push("python");
  if (cargoToml) hints.push("rust");
  if (goMod) hints.push("go");
  return hints;
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { url: string };
  const { url } = body;

  if (!url?.trim()) {
    return NextResponse.json({ error: "url is required" }, { status: 400 });
  }

  const trimmedUrl = url.trim();
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-ctx-"));
  const repoDir = path.join(baseDir, "repo");

  try {
    const creds = await loadGitCredentials();

    try {
      if (trimmedUrl.startsWith("https://") && creds.token) {
        await simpleGit().env(safeEnv()).clone(injectToken(trimmedUrl, creds.token), repoDir, ["--depth", "1"]);
      } else if (trimmedUrl.startsWith("git@")) {
        const sshCommand = creds.sshKeyPath
          ? `ssh -i ${creds.sshKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`
          : `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
        const sshGit = simpleGit({ config: [`core.sshCommand=${sshCommand}`], unsafe: { allowUnsafeSshCommand: true } });
        await sshGit.env(safeEnv()).clone(trimmedUrl, repoDir, ["--depth", "1"]);
      } else {
        await simpleGit().env(safeEnv()).clone(trimmedUrl, repoDir, ["--depth", "1"]);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: `Failed to clone repository: ${msg}` }, { status: 400 });
    }

    let context = `Repository: ${trimmedUrl}\n\n`;

    // Directory structure (depth 3 for better coverage)
    const structure = await getDirectoryStructure(repoDir, 3);
    if (structure) {
      context += `## Directory Structure\n${structure}\n`;
    }

    // README
    const readmeNames = ["README.md", "README.rst", "README.txt", "README", "readme.md"];
    for (const name of readmeNames) {
      const content = await readFileSafe(path.join(repoDir, name), MAX_README_CHARS);
      if (content) {
        context += `## ${name}\n${content}\n\n`;
        break;
      }
    }

    // Config/manifest files
    const configFiles = ["CLAUDE.md", "AGENTS.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "requirements.txt", "Makefile", "docker-compose.yml"];
    const configContents: Record<string, string> = {};
    for (const name of configFiles) {
      const content = await readFileSafe(path.join(repoDir, name));
      if (content) {
        configContents[name] = content;
        context += `## ${name}\n${content}\n\n`;
      }
    }

    // Detect project type for smarter source file selection
    const projectHints = detectProjectType(
      configContents["package.json"] ?? null,
      configContents["pyproject.toml"] ?? null,
      configContents["Cargo.toml"] ?? null,
      configContents["go.mod"] ?? null,
    );

    // Collect and score all source files
    const allFiles = await collectSourceFiles(repoDir, repoDir);
    const scored = allFiles
      .map((f) => ({ path: f, score: scoreFile(f, repoDir) }))
      .filter((f) => f.score > 0)
      .sort((a, b) => b.score - a.score);

    // Read top source files up to combined char limit
    let totalSourceChars = 0;
    const readFiles: string[] = [];

    for (const { path: filePath } of scored) {
      if (readFiles.length >= MAX_SOURCE_FILES) break;
      if (totalSourceChars >= MAX_TOTAL_SOURCE_CHARS) break;

      const remaining = MAX_TOTAL_SOURCE_CHARS - totalSourceChars;
      const content = await readFileSafe(filePath, Math.min(MAX_FILE_CHARS, remaining));
      if (!content) continue;

      const rel = path.relative(repoDir, filePath);
      context += `## ${rel}\n\`\`\`${path.extname(filePath).slice(1)}\n${content}\n\`\`\`\n\n`;
      totalSourceChars += content.length;
      readFiles.push(rel);
    }

    if (projectHints.length > 0) {
      context = `Project type: ${projectHints.join(", ")}\n\n${context}`;
    }

    return NextResponse.json({ context });
  } finally {
    await fs.rm(baseDir, { recursive: true, force: true }).catch(() => {});
  }
}
