/** The single posting path: guard pipeline + happy paths (service level). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postEntry, postReversal, PostingError } from "../../src/ledger/posting";
import { lockPeriod, unlockPeriod } from "../../src/ledger/periods";
import { makeTestDb, type TestDb } from "../helpers/db";

let t: TestDb;

async function expectPostingError(p: Promise<unknown>, code: string, pattern?: RegExp) {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(PostingError);
  expect((err as PostingError).code).toBe(code);
  if (pattern) expect((err as PostingError).message).toMatch(pattern);
}

beforeAll(async () => {
  t = await makeTestDb();
});

afterAll(async () => {
  await t.drop();
});

describe("postEntry", () => {
  it("posts a balanced entry and defaults the tax_year dimension", async () => {
    const { entryId } = await postEntry(t.db, {
      entryDate: "2026-10-05",
      memo: "software subscription",
      sourceModule: "manual",
      lines: [
        { accountCode: "5100", debit: 4900n },
        { accountCode: "1000", credit: 4900n },
      ],
    });
    const r = await t.pool.query(
      "SELECT tax_year FROM journal_lines WHERE entry_id = $1",
      [entryId.toString()],
    );
    expect(r.rows.map((x: { tax_year: number }) => x.tax_year)).toEqual([2026, 2026]);
  });

  it("rejects unbalanced/one-sided/short drafts before touching the DB", async () => {
    await expectPostingError(
      postEntry(t.db, {
        entryDate: "2026-10-05",
        memo: "bad",
        sourceModule: "manual",
        lines: [
          { accountCode: "5100", debit: 100n },
          { accountCode: "1000", credit: 99n },
        ],
      }),
      "structure",
      /unbalanced/,
    );
    await expectPostingError(
      postEntry(t.db, {
        entryDate: "2026-10-05",
        memo: "bad",
        sourceModule: "manual",
        lines: [
          { accountCode: "5100", debit: 100n, credit: 100n },
          { accountCode: "1000", credit: 0n },
        ],
      }),
      "structure",
    );
    await expectPostingError(
      postEntry(t.db, {
        entryDate: "2026-10-05",
        memo: "bad",
        sourceModule: "manual",
        lines: [{ accountCode: "5100", debit: 100n }],
      }),
      "structure",
    );
  });

  it("blocks bank postings into pass-through income accounts (guardrail 3)", async () => {
    await expectPostingError(
      postEntry(t.db, {
        entryDate: "2026-10-06",
        memo: "investee wire misclassified as income",
        sourceModule: "bank",
        sourceId: 1n,
        lines: [
          { accountCode: "1000", debit: 50000n },
          { accountCode: "4500", credit: 50000n },
        ],
      }),
      "restricted_target",
      /never revenue/,
    );
  });

  it("blocks bank postings into AAA/OAA/close and officer comp accounts", async () => {
    await expectPostingError(
      postEntry(t.db, {
        entryDate: "2026-10-06",
        memo: "bad target",
        sourceModule: "bank",
        sourceId: 1n,
        lines: [
          { accountCode: "3100", debit: 100n },
          { accountCode: "1000", credit: 100n },
        ],
      }),
      "restricted_target",
    );
    await expectPostingError(
      postEntry(t.db, {
        entryDate: "2026-10-06",
        memo: "wages not via payroll",
        sourceModule: "bank",
        sourceId: 1n,
        lines: [
          { accountCode: "5000", debit: 100n },
          { accountCode: "1000", credit: 100n },
        ],
      }),
      "restricted_target",
      /payroll/,
    );
  });

  it("requires a document on requires_document accounts, honoring thresholds", async () => {
    // meals: always requires a document
    await expectPostingError(
      postEntry(t.db, {
        entryDate: "2026-10-07",
        memo: "client lunch",
        sourceModule: "manual",
        lines: [
          { accountCode: "5130", debit: 8000n },
          { accountCode: "1000", credit: 8000n },
        ],
      }),
      "document_required",
    );
    // professional fees: threshold is $500 — $300 posts without a document
    await postEntry(t.db, {
      entryDate: "2026-10-07",
      memo: "registered agent fee",
      sourceModule: "manual",
      lines: [
        { accountCode: "5110", debit: 30000n },
        { accountCode: "1000", credit: 30000n },
      ],
    });
    // ...but $900 does not
    await expectPostingError(
      postEntry(t.db, {
        entryDate: "2026-10-07",
        memo: "CPA invoice",
        sourceModule: "manual",
        lines: [
          { accountCode: "5110", debit: 90000n },
          { accountCode: "1000", credit: 90000n },
        ],
      }),
      "document_required",
    );
  });

  it("rejects unknown accounts and locked periods with typed errors", async () => {
    await expectPostingError(
      postEntry(t.db, {
        entryDate: "2026-10-08",
        memo: "typo",
        sourceModule: "manual",
        lines: [
          { accountCode: "9999", debit: 100n },
          { accountCode: "1000", credit: 100n },
        ],
      }),
      "unknown_account",
    );
    await lockPeriod(t.db, 2026, 8);
    await expectPostingError(
      postEntry(t.db, {
        entryDate: "2026-08-15",
        memo: "backdated",
        sourceModule: "manual",
        lines: [
          { accountCode: "5100", debit: 100n },
          { accountCode: "1000", credit: 100n },
        ],
      }),
      "period_locked",
    );
    await unlockPeriod(t.db, 2026, 8, "test cleanup");
    const audit = await t.pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'unlock_period'",
    );
    expect(audit.rows[0].n).toBe(1);
  });
});

describe("postReversal", () => {
  it("reverses via the DB function and refuses a second reversal", async () => {
    const { entryId } = await postEntry(t.db, {
      entryDate: "2026-10-09",
      memo: "to be reversed",
      sourceModule: "manual",
      lines: [
        { accountCode: "5100", debit: 1234n },
        { accountCode: "1000", credit: 1234n },
      ],
    });
    const rev = await postReversal(t.db, entryId, "2026-10-31", "undo");
    expect(rev.entryId).toBeGreaterThan(entryId);
    await expectPostingError(
      postReversal(t.db, entryId, "2026-10-31", "again"),
      "structure",
      /already been reversed/,
    );
  });
});
