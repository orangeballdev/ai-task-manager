import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client";
import path from "path";
import fs from "fs";
import { ensureSqliteWalMode } from "./sqlite-pragmas";
import { withDbTelemetry } from "./db-telemetry";

/** Resolves the on-disk path of the SQLite database file, honoring DATABASE_URL. */
export function getDbPath(): string {
  const rawUrl = process.env.DATABASE_URL ?? "file:./data/dev.db";
  const filePath = rawUrl.startsWith("file:") ? rawUrl.slice(5) : rawUrl;
  return path.resolve(filePath);
}

function createClient() {
  const resolvedPath = getDbPath();
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  ensureSqliteWalMode(resolvedPath);
  const adapter = new PrismaBetterSqlite3({ url: resolvedPath });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return withDbTelemetry(new (PrismaClient as any)({ adapter }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const globalForPrisma = globalThis as unknown as { prisma: any };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const prisma: any = globalForPrisma.prisma || createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
