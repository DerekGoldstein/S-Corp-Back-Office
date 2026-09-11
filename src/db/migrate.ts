/**
 * Migration runner. Hand-written SQL files in drizzle/ are the schema source
 * of truth (CLAUDE.md); they are applied in filename order, each inside a
 * transaction, and recorded with a content hash. An applied file that later
 * changes on disk is a hard error — migrations are immutable once pushed.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import pg from "pg";
import { loadEnv } from "../lib/env";
import { defaultAdminUrl, defaultDatabaseUrl } from "./client";

const MIGRATIONS_DIR = resolve(process.cwd(), "drizzle");

function targetDbName(databaseUrl: string): string {
  const name = new URL(databaseUrl).pathname.replace(/^\//, "");
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`suspicious database name ${JSON.stringify(name)}`);
  }
  return name;
}

export async function ensureDatabase(databaseUrl: string, adminUrl: string): Promise<void> {
  const name = targetDbName(databaseUrl);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const r = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (r.rowCount === 0) {
      await admin.query(`CREATE DATABASE ${name}`);
    }
  } finally {
    await admin.end();
  }
}

export async function migrate(databaseUrl: string, adminUrl: string): Promise<string[]> {
  await ensureDatabase(databaseUrl, adminUrl);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const appliedNow: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        sha256     text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const { rows } = await client.query<{ filename: string; sha256: string }>(
      "SELECT filename, sha256 FROM schema_migrations",
    );
    const applied = new Map(rows.map((r) => [r.filename, r.sha256]));
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const sha = createHash("sha256").update(sql).digest("hex");
      const prior = applied.get(file);
      if (prior !== undefined) {
        if (prior !== sha) {
          throw new Error(
            `migration ${file} changed after being applied (was ${prior.slice(0, 12)}, ` +
              `now ${sha.slice(0, 12)}); migrations are immutable — add a new file instead`,
          );
        }
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)",
          [file, sha],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : err}`);
      }
      appliedNow.push(file);
    }
  } finally {
    await client.end();
  }
  return appliedNow;
}

// Run directly: `npm run db:migrate`
if (process.argv[1] && resolve(process.argv[1]).endsWith("migrate.ts")) {
  loadEnv();
  migrate(defaultDatabaseUrl(), defaultAdminUrl())
    .then((applied) => {
      console.log(
        applied.length === 0 ? "migrations: up to date" : `applied: ${applied.join(", ")}`,
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
