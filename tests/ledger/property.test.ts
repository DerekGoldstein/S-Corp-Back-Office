/**
 * Brief §6: a random-entry generator must never get an unbalanced or
 * locked-period entry past the DATABASE. Seeded PRNG so failures reproduce.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectDbReject, makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let acctIds: number[] = [];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 20260911;
const rand = mulberry32(SEED);
const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: T[]): T => xs[randInt(0, xs.length - 1)]!;

type GenLine = { accountId: number; debit: bigint; credit: bigint };

/** Balanced-by-construction random entry: 2–8 lines, amounts 1¢–$5,000. */
function genEntry(): { date: string; lines: GenLine[] } {
  const month = randInt(1, 7); // months 8/9 get locked in the tests below
  const day = randInt(1, 28);
  const date = `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const nDebits = randInt(1, 4);
  const nCredits = randInt(1, 4);
  const debits: bigint[] = Array.from({ length: nDebits }, () => BigInt(randInt(1, 500_000)));
  const total = debits.reduce((a, b) => a + b, 0n);
  // split total into nCredits positive parts
  const credits: bigint[] = [];
  let remaining = total;
  for (let i = 0; i < nCredits - 1; i++) {
    const maxPart = remaining - BigInt(nCredits - 1 - i);
    const part = maxPart <= 1n ? 1n : 1n + (BigInt(randInt(0, 1_000_000_000)) % maxPart);
    credits.push(part);
    remaining -= part;
  }
  credits.push(remaining);
  const lines: GenLine[] = [
    ...debits.map((d) => ({ accountId: pick(acctIds), debit: d, credit: 0n })),
    ...credits.map((c) => ({ accountId: pick(acctIds), debit: 0n, credit: c })),
  ];
  return { date, lines };
}

async function insertRaw(date: string, lines: GenLine[]): Promise<bigint> {
  const client = await t.pool.connect();
  try {
    await client.query("BEGIN");
    const e = await client.query(
      "INSERT INTO journal_entries (entry_date, memo, source_module) VALUES ($1,'property test','manual') RETURNING id",
      [date],
    );
    const id = e.rows[0].id as string;
    for (const [i, l] of lines.entries()) {
      await client.query(
        "INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit) VALUES ($1,$2,$3,$4,$5)",
        [id, i + 1, l.accountId, l.debit.toString(), l.credit.toString()],
      );
    }
    await client.query("COMMIT");
    return BigInt(id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  t = await makeTestDb();
  // dimension-free accounts only (per-investee accounts need the dimension)
  const r = await t.pool.query(
    "SELECT id FROM accounts WHERE investee_id IS NULL ORDER BY code",
  );
  acctIds = r.rows.map((x: { id: number }) => x.id);
});

afterAll(async () => {
  await t.drop();
});

describe(`property tests (seed ${SEED})`, () => {
  it("accepts 150 random balanced entries; the trial balance still balances", async () => {
    for (let i = 0; i < 150; i++) {
      const { date, lines } = genEntry();
      await insertRaw(date, lines);
    }
    const r = await t.pool.query(
      "SELECT sum(debit)::text AS d, sum(credit)::text AS c FROM journal_lines",
    );
    expect(r.rows[0].d).toBe(r.rows[0].c);
  });

  it("rejects every off-by-one-cent mutation of a random entry", async () => {
    for (let i = 0; i < 40; i++) {
      const { date, lines } = genEntry();
      const mutated = lines.map((l) => ({ ...l }));
      const j = randInt(0, mutated.length - 1);
      const m = mutated[j]!;
      if (m.debit > 0n) m.debit += rand() < 0.5 && m.debit > 1n ? -1n : 1n;
      else m.credit += rand() < 0.5 && m.credit > 1n ? -1n : 1n;
      await expect(insertRaw(date, mutated)).rejects.toThrow(/unbalanced/);
    }
  });

  it("rejects every entry dated into a locked period", async () => {
    await t.pool.query(`
      INSERT INTO periods (tax_year, month, locked, locked_at)
      VALUES (2026, 8, true, now()), (2026, 9, true, now())
      ON CONFLICT (tax_year, month) DO UPDATE SET locked = true, locked_at = now()`);
    for (let i = 0; i < 25; i++) {
      const { lines } = genEntry();
      const day = String(randInt(1, 28)).padStart(2, "0");
      const month = pick(["08", "09"]);
      await expect(insertRaw(`2026-${month}-${day}`, lines)).rejects.toThrow(/locked/);
    }
  });

  it("rejects random UPDATE/DELETE attempts against posted history", async () => {
    const r = await t.pool.query("SELECT id FROM journal_lines ORDER BY random() LIMIT 10");
    for (const row of r.rows as Array<{ id: string }>) {
      await expectDbReject(
        t.pool,
        `UPDATE journal_lines SET debit = debit + 1 WHERE id = ${row.id}`,
        /append-only/,
      );
      await expectDbReject(t.pool, `DELETE FROM journal_lines WHERE id = ${row.id}`, /append-only/);
    }
  });
});
