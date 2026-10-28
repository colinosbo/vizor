import { resolve } from "node:path";
export function databaseUrl() {
  const value = process.env.DATABASE_URL ?? "file:./data/vizor.db";
  return value.startsWith("file:")
    ? `file:${resolve(value.slice(5)).replaceAll("\\", "/")}`
    : value;
}
