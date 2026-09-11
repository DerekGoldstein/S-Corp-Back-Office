import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { loadEnv } from "../lib/env";
import * as schema from "./schema";

loadEnv();

const setTypeParser = pg.types.setTypeParser as (
  oid: number,
  parser: (v: string) => unknown,
) => void;
// Money discipline: int8 comes back as bigint, never number.
setTypeParser(20, (v: string) => BigInt(v));
// int8[] (e.g. rule_suggestions.sample_txn_ids)
setTypeParser(1016, parseBigintArray);
// Calendar dates stay 'YYYY-MM-DD' strings — no timezone drift.
setTypeParser(1082, (v: string) => v);

export function parseBigintArray(v: string): bigint[] {
  const inner = v.replace(/^\{|\}$/g, "").trim();
  if (inner === "") return [];
  return inner.split(",").map((x) => BigInt(x));
}

export type AppDb = NodePgDatabase<typeof schema>;
/** Either the root db or a drizzle transaction — services accept both. */
export type Dbx = Pick<
  AppDb,
  "select" | "insert" | "update" | "delete" | "execute" | "query" | "transaction"
>;

export function defaultDatabaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgresql://postgres@localhost/scorp?host=/tmp/scorp-pg";
}

export function defaultAdminUrl(): string {
  return (
    process.env.DATABASE_ADMIN_URL ?? "postgresql://postgres@localhost/postgres?host=/tmp/scorp-pg"
  );
}

export function makeDb(connectionString: string): { pool: pg.Pool; db: AppDb } {
  const pool = new pg.Pool({ connectionString, max: 5 });
  return { pool, db: drizzle(pool, { schema }) };
}

let _default: { pool: pg.Pool; db: AppDb } | undefined;

/** Lazy singleton used by the app; tests use makeDb() against their own DBs. */
export function getDb(): AppDb {
  _default ??= makeDb(defaultDatabaseUrl());
  return _default.db;
}
