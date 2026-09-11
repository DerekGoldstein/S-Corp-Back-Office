/**
 * Reports are pure queries over the journal — no report stores a total
 * (brief §2). Amounts are bigint cents; presentation formatting is the UI's
 * job. "As of" filters compare entry_date, so every statement is exactly
 * reproducible for any historical date.
 */
import { sql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import type { Cents } from "../lib/cents";

export type TrialBalanceRow = {
  code: string;
  name: string;
  type: string;
  debit: Cents; // presentation side: net debit balances here
  credit: Cents; // net credit balances here
};

export type TrialBalance = {
  asOf: string;
  rows: TrialBalanceRow[];
  totalDebits: Cents;
  totalCredits: Cents;
};

export async function trialBalance(
  db: Dbx,
  asOf: string,
  opts: { includeZero?: boolean } = {},
): Promise<TrialBalance> {
  const result = await db.execute<{
    code: string;
    name: string;
    type: string;
    debits: bigint | null;
    credits: bigint | null;
  }>(sql`
    SELECT a.code, a.name, a.type::text AS type, t.debits, t.credits
    FROM accounts a
    LEFT JOIN (
      SELECT l.account_id, sum(l.debit)::bigint AS debits, sum(l.credit)::bigint AS credits
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      WHERE e.entry_date <= ${asOf}
      GROUP BY l.account_id
    ) t ON t.account_id = a.id
    ORDER BY a.code
  `);
  const rows: TrialBalanceRow[] = [];
  let totalDebits = 0n;
  let totalCredits = 0n;
  for (const r of result.rows) {
    const balance = (r.debits ?? 0n) - (r.credits ?? 0n);
    if (balance === 0n && !opts.includeZero) continue;
    const row: TrialBalanceRow = {
      code: r.code,
      name: r.name,
      type: r.type,
      debit: balance > 0n ? balance : 0n,
      credit: balance < 0n ? -balance : 0n,
    };
    totalDebits += row.debit;
    totalCredits += row.credit;
    rows.push(row);
  }
  return { asOf, rows, totalDebits, totalCredits };
}

export type PnlRow = { code: string; name: string; amount: Cents };
export type ProfitAndLoss = {
  from: string;
  to: string;
  revenue: PnlRow[];
  expenses: PnlRow[];
  totalRevenue: Cents;
  totalExpenses: Cents;
  netIncome: Cents;
};

export async function profitAndLoss(db: Dbx, from: string, to: string): Promise<ProfitAndLoss> {
  const result = await db.execute<{
    code: string;
    name: string;
    type: string;
    debits: bigint | null;
    credits: bigint | null;
  }>(sql`
    SELECT a.code, a.name, a.type::text AS type,
           sum(l.debit)::bigint AS debits, sum(l.credit)::bigint AS credits
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id
    WHERE e.entry_date BETWEEN ${from} AND ${to}
      AND a.type IN ('revenue','expense')
    GROUP BY a.code, a.name, a.type
    ORDER BY a.code
  `);
  const revenue: PnlRow[] = [];
  const expenses: PnlRow[] = [];
  let totalRevenue = 0n;
  let totalExpenses = 0n;
  for (const r of result.rows) {
    const debits = r.debits ?? 0n;
    const credits = r.credits ?? 0n;
    if (r.type === "revenue") {
      const amount = credits - debits;
      if (amount === 0n) continue;
      revenue.push({ code: r.code, name: r.name, amount });
      totalRevenue += amount;
    } else {
      const amount = debits - credits;
      if (amount === 0n) continue;
      expenses.push({ code: r.code, name: r.name, amount });
      totalExpenses += amount;
    }
  }
  return {
    from,
    to,
    revenue,
    expenses,
    totalRevenue,
    totalExpenses,
    netIncome: totalRevenue - totalExpenses,
  };
}

export type BalanceSheetRow = { code: string; name: string; amount: Cents };
export type BalanceSheet = {
  asOf: string;
  assets: BalanceSheetRow[];
  liabilities: BalanceSheetRow[];
  equity: BalanceSheetRow[];
  /** Revenue − expense not yet closed to 3900/AAA as of the date. */
  unclosedNetIncome: Cents;
  totalAssets: Cents;
  totalLiabilities: Cents;
  totalEquity: Cents;
  balanced: boolean;
};

export async function balanceSheet(db: Dbx, asOf: string): Promise<BalanceSheet> {
  const result = await db.execute<{
    code: string;
    name: string;
    type: string;
    debits: bigint | null;
    credits: bigint | null;
  }>(sql`
    SELECT a.code, a.name, a.type::text AS type,
           sum(l.debit)::bigint AS debits, sum(l.credit)::bigint AS credits
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id
    WHERE e.entry_date <= ${asOf}
    GROUP BY a.code, a.name, a.type
    ORDER BY a.code
  `);
  const assets: BalanceSheetRow[] = [];
  const liabilities: BalanceSheetRow[] = [];
  const equity: BalanceSheetRow[] = [];
  let totalAssets = 0n;
  let totalLiabilities = 0n;
  let equitySubtotal = 0n;
  let unclosedNetIncome = 0n;
  for (const r of result.rows) {
    const debits = r.debits ?? 0n;
    const credits = r.credits ?? 0n;
    switch (r.type) {
      case "asset":
      case "contra_asset": {
        const amount = debits - credits; // contra shows negative naturally
        if (amount !== 0n) assets.push({ code: r.code, name: r.name, amount });
        totalAssets += amount;
        break;
      }
      case "liability": {
        const amount = credits - debits;
        if (amount !== 0n) liabilities.push({ code: r.code, name: r.name, amount });
        totalLiabilities += amount;
        break;
      }
      case "equity":
      case "contra_equity": {
        const amount = credits - debits;
        if (amount !== 0n) equity.push({ code: r.code, name: r.name, amount });
        equitySubtotal += amount;
        break;
      }
      case "revenue":
        unclosedNetIncome += credits - debits;
        break;
      case "expense":
        unclosedNetIncome -= debits - credits;
        break;
    }
  }
  const totalEquity = equitySubtotal + unclosedNetIncome;
  return {
    asOf,
    assets,
    liabilities,
    equity,
    unclosedNetIncome,
    totalAssets,
    totalLiabilities,
    totalEquity,
    balanced: totalAssets === totalLiabilities + totalEquity,
  };
}

export type LedgerDetailLine = {
  entryId: bigint;
  entryDate: string;
  memo: string;
  sourceModule: string;
  lineNo: number;
  accountCode: string;
  accountName: string;
  debit: Cents;
  credit: Cents;
  lineMemo: string | null;
  investeeId: number | null;
  bankTransactionId: bigint | null;
};

export async function generalLedgerDetail(
  db: Dbx,
  opts: { from: string; to: string; accountCode?: string },
): Promise<LedgerDetailLine[]> {
  const filter = opts.accountCode !== undefined ? sql` AND a.code = ${opts.accountCode}` : sql``;
  const result = await db.execute<{
    entry_id: bigint;
    entry_date: string;
    memo: string;
    source_module: string;
    line_no: number;
    code: string;
    name: string;
    debit: bigint;
    credit: bigint;
    line_memo: string | null;
    investee_id: number | null;
    bank_transaction_id: bigint | null;
  }>(sql`
    SELECT e.id AS entry_id, e.entry_date, e.memo, e.source_module::text AS source_module,
           l.line_no, a.code, a.name, l.debit, l.credit, l.memo AS line_memo,
           l.investee_id, l.bank_transaction_id
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id
    WHERE e.entry_date BETWEEN ${opts.from} AND ${opts.to}${filter}
    ORDER BY e.entry_date, e.id, l.line_no
  `);
  return result.rows.map((r) => ({
    entryId: r.entry_id,
    entryDate: r.entry_date,
    memo: r.memo,
    sourceModule: r.source_module,
    lineNo: r.line_no,
    accountCode: r.code,
    accountName: r.name,
    debit: r.debit,
    credit: r.credit,
    lineMemo: r.line_memo,
    investeeId: r.investee_id,
    bankTransactionId: r.bank_transaction_id,
  }));
}

export type RegisterLine = LedgerDetailLine & { runningBalance: Cents };
export type AccountRegister = {
  accountCode: string;
  from: string;
  to: string;
  openingBalance: Cents;
  closingBalance: Cents;
  lines: RegisterLine[];
};

/** Running-balance register; balance sign follows debit-minus-credit. */
export async function accountRegister(
  db: Dbx,
  accountCode: string,
  from: string,
  to: string,
): Promise<AccountRegister> {
  const opening = await db.execute<{ debits: bigint | null; credits: bigint | null }>(sql`
    SELECT sum(l.debit)::bigint AS debits, sum(l.credit)::bigint AS credits
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id
    JOIN accounts a ON a.id = l.account_id
    WHERE a.code = ${accountCode} AND e.entry_date < ${from}
  `);
  const o = opening.rows[0];
  const openingBalance = (o?.debits ?? 0n) - (o?.credits ?? 0n);
  const detail = await generalLedgerDetail(db, { from, to, accountCode });
  let running = openingBalance;
  const lines: RegisterLine[] = detail.map((l) => {
    running += l.debit - l.credit;
    return { ...l, runningBalance: running };
  });
  return { accountCode, from, to, openingBalance, closingBalance: running, lines };
}
