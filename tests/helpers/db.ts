import pg from "pg";
import { expect } from "vitest";
import { defaultAdminUrl, makeDb, type AppDb } from "../../src/db/client";
import { TEMPLATE_DB, urlForDb } from "./global-setup";

let counter = 0;

export type TestDb = {
  db: AppDb;
  pool: pg.Pool;
  url: string;
  name: string;
  drop: () => Promise<void>;
};

/** Clone the migrated+seeded template into a fresh database for this file. */
export async function makeTestDb(): Promise<TestDb> {
  const adminUrl = defaultAdminUrl();
  const name = `scorp_test_${process.pid}_${++counter}_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }
  const url = urlForDb(adminUrl, name);
  const { pool, db } = makeDb(url);
  return {
    db,
    pool,
    url,
    name,
    drop: async () => {
      await pool.end();
      const admin2 = new pg.Client({ connectionString: adminUrl });
      await admin2.connect();
      try {
        await admin2.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await admin2.end();
      }
    },
  };
}

/** Assert a raw-SQL statement is rejected by the DATABASE with a message. */
export async function expectDbReject(
  pool: pg.Pool,
  sqlText: string,
  pattern: RegExp,
): Promise<void> {
  let error: unknown;
  try {
    await pool.query(sqlText);
  } catch (e) {
    error = e;
  }
  expect(error, `expected the database to reject: ${sqlText.slice(0, 120)}`).toBeDefined();
  expect(String((error as Error).message)).toMatch(pattern);
}
