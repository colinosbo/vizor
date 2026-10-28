import "dotenv/config";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { databaseUrl } from "../database-url";
const globalDb = globalThis as unknown as { vizorDb?: PrismaClient };
export const db =
  globalDb.vizorDb ??
  new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: databaseUrl() }),
    log: [],
  });
globalDb.vizorDb = db;
