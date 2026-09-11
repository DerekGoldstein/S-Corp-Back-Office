/**
 * Vitest global setup: ensure Postgres is up (local socket cluster unless CI
 * provides one), then build the template database — migrations + COA seed —
 * that every test file clones. Runs once per test invocation.
 */
import { execSync } from "node:child_process";
import pg from "pg";
import { defaultAdminUrl } from "../../src/db/client";
import { migrate } from "../../src/db/migrate";
import { seedChartOfAccounts } from "../../src/db/seed";
import { makeDb } from "../../src/db/client";

export const TEMPLATE_DB = "scorp_test_template";

export function urlForDb(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export default async function setup(): Promise<void> {
  if (!process.env.CI) {
    execSync("bash scripts/db.sh ensure", { stdio: "inherit" });
  }
  const adminUrl = defaultAdminUrl();
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
  const templateUrl = urlForDb(adminUrl, TEMPLATE_DB);
  await migrate(templateUrl, adminUrl);
  const { pool, db } = makeDb(templateUrl);
  try {
    await seedChartOfAccounts(db);
  } finally {
    await pool.end();
  }
}
