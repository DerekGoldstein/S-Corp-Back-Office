/**
 * The database alone enforces the ledger invariants (I1–I13): every case here
 * uses RAW SQL, bypassing the app layer entirely, and asserts Postgres itself
 * accepts/rejects. Ported from docs/proposal/03-ledger-invariants.probe.sh.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInvestee } from "../../src/ledger/investees";
import { expectDbReject, makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;
let cashId: number;
let softwareId: number;
let investeeAcctId: number;
let investeeId: number;
let bankAcctId: number;

async function acctId(code: string): Promise<number> {
  const r = await t.pool.query("SELECT id FROM accounts WHERE code = $1", [code]);
  return r.rows[0].id as number;
}

/** Post a balanced 2-line entry via raw SQL; returns the entry id. */
async function rawEntry(date: string, debitAcct: number, creditAcct: number, amount: bigint) {
  const r = await t.pool.query(
    `WITH e AS (
       INSERT INTO journal_entries (entry_date, memo, source_module)
       VALUES ($1, 'test entry', 'manual') RETURNING id
     ), l1 AS (
       INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit)
       SELECT id, 1, $2, $4, 0 FROM e
     ), l2 AS (
       INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit)
       SELECT id, 2, $3, 0, $4 FROM e
     ) SELECT id FROM e`,
    [date, debitAcct, creditAcct, amount.toString()],
  );
  return BigInt(r.rows[0].id);
}

beforeAll(async () => {
  t = await makeTestDb();
  cashId = await acctId("1000");
  softwareId = await acctId("5100");
  const created = await createInvestee(t.db, {
    name: "Factoring LLC",
    entityType: "partnership",
    ownershipPct: "50",
    acquiredOn: "2024-08-01",
  });
  investeeId = created.investee.id;
  investeeAcctId = await acctId(created.accountCode);
  const ba = await t.pool.query(
    "INSERT INTO bank_accounts (name, ledger_account_id) VALUES ('Chase operating', $1) RETURNING id",
    [cashId],
  );
  bankAcctId = ba.rows[0].id as number;
});

afterAll(async () => {
  await t.drop();
});

describe("journal invariants (DB-enforced)", () => {
  it("I1: accepts a balanced two-line entry", async () => {
    const id = await rawEntry("2026-10-05", softwareId, cashId, 4900n);
    expect(id).toBeGreaterThan(0n);
  });

  it("I1: rejects an unbalanced entry at commit", async () => {
    await expectDbReject(
      t.pool,
      `WITH e AS (INSERT INTO journal_entries (entry_date, memo, source_module)
                  VALUES ('2026-10-06','oops','manual') RETURNING id),
        l1 AS (INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit)
               SELECT id, 1, ${softwareId}, 100, 0 FROM e)
        INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit)
        SELECT id, 2, ${cashId}, 0, 99 FROM e`,
      /unbalanced/,
    );
  });

  it("I2: rejects a single-line entry", async () => {
    await expectDbReject(
      t.pool,
      `WITH e AS (INSERT INTO journal_entries (entry_date, memo, source_module)
                  VALUES ('2026-10-06','half','manual') RETURNING id)
       INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit)
       SELECT id, 1, ${softwareId}, 100, 0 FROM e`,
      /at least two lines/,
    );
  });

  it("I2: rejects a header with zero lines", async () => {
    await expectDbReject(
      t.pool,
      `INSERT INTO journal_entries (entry_date, memo, source_module)
       VALUES ('2026-10-06','empty','manual')`,
      /at least two lines/,
    );
  });

  it("I3: rejects a line with both sides positive", async () => {
    await expectDbReject(
      t.pool,
      `WITH e AS (INSERT INTO journal_entries (entry_date, memo, source_module)
                  VALUES ('2026-10-06','both','manual') RETURNING id),
        l1 AS (INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit)
               SELECT id, 1, ${softwareId}, 100, 100 FROM e)
        INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit)
        SELECT id, 2, ${cashId}, 100, 100 FROM e`,
      /check constraint/,
    );
  });

  it("I4: rejects UPDATE and DELETE on posted entries", async () => {
    const id = await rawEntry("2026-10-07", softwareId, cashId, 1000n);
    await expectDbReject(
      t.pool,
      `UPDATE journal_entries SET memo = 'edited' WHERE id = ${id}`,
      /append-only/,
    );
    await expectDbReject(
      t.pool,
      `DELETE FROM journal_lines WHERE entry_id = ${id}`,
      /append-only/,
    );
  });

  it("I6: rejects entries dated into a locked period; reversals too", async () => {
    await t.pool.query(`
      INSERT INTO periods (tax_year, month, locked, locked_at) VALUES (2026, 9, true, now())
      ON CONFLICT (tax_year, month) DO UPDATE SET locked = true, locked_at = now()`);
    await expect(rawEntry("2026-09-15", softwareId, cashId, 100n)).rejects.toThrow(/locked/);
    const id = await rawEntry("2026-10-08", softwareId, cashId, 100n);
    await expectDbReject(
      t.pool,
      `SELECT post_reversal(${id}, '2026-09-20', 'into locked')`,
      /locked/,
    );
  });

  it("I5: post_reversal mirrors the entry once, and only once", async () => {
    const id = await rawEntry("2026-10-09", softwareId, cashId, 2500n);
    const rev = await t.pool.query(`SELECT post_reversal(${id}, '2026-10-31', 'undo') AS id`);
    const revId = BigInt(rev.rows[0].id);
    const lines = await t.pool.query(
      "SELECT account_id, debit::text, credit::text FROM journal_lines WHERE entry_id = $1 ORDER BY line_no",
      [revId.toString()],
    );
    expect(lines.rows).toEqual([
      { account_id: softwareId, debit: "0", credit: "2500" },
      { account_id: cashId, debit: "2500", credit: "0" },
    ]);
    await expectDbReject(
      t.pool,
      `SELECT post_reversal(${id}, '2026-10-31', 'again')`,
      /duplicate key|reversed/,
    );
  });

  it("I9: per-investee accounts require the matching dimension", async () => {
    await expectDbReject(
      t.pool,
      `WITH e AS (INSERT INTO journal_entries (entry_date, memo, source_module)
                  VALUES ('2026-10-10','wire','manual') RETURNING id),
        l1 AS (INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit)
               SELECT id, 1, ${cashId}, 50000, 0 FROM e)
        INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit)
        SELECT id, 2, ${investeeAcctId}, 0, 50000 FROM e`,
      /must carry that investee/,
    );
    // with the dimension it commits
    await t.pool.query(
      `WITH e AS (INSERT INTO journal_entries (entry_date, memo, source_module, source_id)
                  VALUES ('2026-10-10','investee wire','bank', 1) RETURNING id),
        l1 AS (INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit)
               SELECT id, 1, ${cashId}, 50000, 0 FROM e)
        INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, investee_id)
        SELECT id, 2, ${investeeAcctId}, 0, 50000, ${investeeId} FROM e`,
    );
  });

  it("I10: source discipline — bank needs source_id, reversal flag needs reference", async () => {
    await expectDbReject(
      t.pool,
      `INSERT INTO journal_entries (entry_date, memo, source_module)
       VALUES ('2026-10-11','no source','bank')`,
      /check constraint/,
    );
    await expectDbReject(
      t.pool,
      `INSERT INTO journal_entries (entry_date, memo, source_module)
       VALUES ('2026-10-11','fake reversal','reversal')`,
      /check constraint/,
    );
  });

  it("I11: accounts with posted lines cannot be re-typed (rename is fine)", async () => {
    await expectDbReject(
      t.pool,
      `UPDATE accounts SET tax_treatment = 'nondeductible' WHERE id = ${softwareId}`,
      /has posted lines/,
    );
    await t.pool.query(`UPDATE accounts SET name = 'Software and subscriptions' WHERE id = ${softwareId}`);
  });

  it("I13: every posted entry produced an audit row", async () => {
    const id = await rawEntry("2026-10-12", softwareId, cashId, 700n);
    const r = await t.pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE object_type = 'journal_entry' AND object_id = $1",
      [id.toString()],
    );
    expect(r.rows[0].n).toBe(1);
  });
});

describe("investee + bank transaction invariants (DB-enforced)", () => {
  it("rejects an S-corporation investee at the enum level", async () => {
    await expectDbReject(
      t.pool,
      `INSERT INTO investees (name, entity_type, ownership_pct, acquired_on)
       VALUES ('Bad Sub', 's_corporation', 10, '2027-01-01')`,
      /invalid input value for enum/,
    );
  });

  it("I12: raw bank fields are frozen; deletes rejected; dedupe enforced", async () => {
    const ins = await t.pool.query(
      `INSERT INTO bank_transactions (bank_account_id, source, import_hash, txn_date, amount, description_raw, description_norm)
       VALUES ($1,'csv','hash-001','2026-10-09',-4900,'ACME SOFTWARE INC','ACME SOFTWARE INC') RETURNING id`,
      [bankAcctId],
    );
    const txnId = ins.rows[0].id as string;
    await expectDbReject(
      t.pool,
      `UPDATE bank_transactions SET amount = -5000 WHERE id = ${txnId}`,
      /immutable/,
    );
    await expectDbReject(t.pool, `DELETE FROM bank_transactions WHERE id = ${txnId}`, /append-only/);
    await expectDbReject(
      t.pool,
      `INSERT INTO bank_transactions (bank_account_id, source, import_hash, txn_date, amount, description_raw, description_norm)
       VALUES (${bankAcctId},'csv','hash-001','2026-10-09',-4900,'ACME SOFTWARE INC','ACME SOFTWARE INC')`,
      /duplicate key/,
    );
  });

  it("posted status requires a journal entry; owner outflows require a tag", async () => {
    await expectDbReject(
      t.pool,
      `UPDATE bank_transactions SET status = 'posted' WHERE import_hash = 'hash-001'`,
      /check constraint/,
    );
    const entryId = await rawEntry("2026-10-13", softwareId, cashId, 4900n);
    await expectDbReject(
      t.pool,
      `INSERT INTO bank_transactions (bank_account_id, source, import_hash, txn_date, amount,
         description_raw, description_norm, is_owner_payee, status, journal_entry_id)
       VALUES (${bankAcctId},'csv','hash-owner-1','2026-10-13',-100000,'ZELLE TO OWNER','ZELLE TO OWNER', true, 'posted', ${entryId})`,
      /check constraint/,
    );
    // with a tag it posts
    await t.pool.query(
      `INSERT INTO bank_transactions (bank_account_id, source, import_hash, txn_date, amount,
         description_raw, description_norm, is_owner_payee, status, journal_entry_id, owner_payment_tag)
       VALUES (${bankAcctId},'csv','hash-owner-2','2026-10-13',-100000,'ZELLE TO OWNER','ZELLE TO OWNER', true, 'posted', ${entryId}, 'distribution')`,
    );
  });

  it("plaid transactions require external_id", async () => {
    await expectDbReject(
      t.pool,
      `INSERT INTO bank_transactions (bank_account_id, source, txn_date, amount, description_raw, description_norm)
       VALUES (${bankAcctId},'plaid','2026-10-14',-500,'FEE','FEE')`,
      /check constraint/,
    );
  });
});
