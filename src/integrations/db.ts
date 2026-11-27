import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client";
import path from "path";
import fs from "fs";
import { ensureSqliteWalMode } from "../lib/sqlite-pragmas";
import { withDbTelemetry } from "../lib/db-telemetry";

function createPrisma() {
  const rawUrl = process.env.DATABASE_URL ?? "file:./data/dev.db";
  const filePath = rawUrl.startsWith("file:") ? rawUrl.slice(5) : rawUrl;
  const resolvedPath = path.resolve(filePath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  ensureSqliteWalMode(resolvedPath);
  const adapter = new PrismaBetterSqlite3({ url: resolvedPath });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return withDbTelemetry(new (PrismaClient as any)({ adapter }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const prisma: any = createPrisma();
