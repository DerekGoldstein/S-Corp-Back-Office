/**
 * Entity-level state/local tax (§4.6): NYC GCT per the NYC-4S structure —
 * compute EVERY base the form requires and take the highest — plus the
 * CT-3-S fixed-dollar minimum. Rates, percentages, exclusions, caps, and
 * FDM brackets all come from the year's VERIFIED tables (guardrail 1);
 * NYC does not recognize the S election, which is why this exists at all.
 *
 * Deduction circularity is handled the way the forms do: GCT and the NYS
 * FDM are deductible federally but added back on their own returns, so both
 * are computed from ENI *before* entity state/local taxes (5200 activity is
 * added back to page-1 ordinary income here).
 */
import { sql as dsql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import type { Cents } from "../lib/cents";
import { formatCents } from "../lib/cents";
import { applyRate } from "../payroll/engine";
import { postEntry } from "../ledger/posting";
import { getVerifiedTable } from "../tax/tables";
import { buildF1120s, saveWorkpaper, type WpLine } from "./f1120s";

export class GctError extends Error {}

export type FdmBracket = { receipts_over_cents: number; tax_cents: number };

export type GctTable = {
  eni_rate: string; // entire-net-income base rate
  alt_base: {
    pct_of_eni_plus_comp: string; // the income-plus-compensation percentage
    exclusion_cents: number; // statutory exclusion before the percentage
  };
  capital_base: { rate: string; cap_cents: number };
  fdm_brackets: FdmBracket[]; // by NYC receipts
};

export type Ct3sTable = { fdm_brackets: FdmBracket[] };

export type GctInputs = {
  eni: Cents; // entire net income BEFORE entity state/local taxes
  officerComp: Cents; // shareholder compensation added back on the alternative base
  businessCapital: Cents;
  nycReceipts: Cents;
};

export type GctResult = {
  bases: { eniTax: Cents; altTax: Cents; capitalTax: Cents; fdm: Cents };
  tax: Cents;
  winner: "eni" | "alternative" | "capital" | "fdm";
  trace: Array<{ base: string; detail: string; amount: string }>;
};

export function fdmLookup(receipts: Cents, brackets: FdmBracket[], what: string): Cents {
  if (brackets.length === 0) throw new GctError(`${what}: empty FDM bracket table`);
  let chosen = brackets[0]!;
  for (const b of [...brackets].sort((a, z) => a.receipts_over_cents - z.receipts_over_cents)) {
    if (receipts >= BigInt(b.receipts_over_cents)) chosen = b;
  }
  return BigInt(chosen.tax_cents);
}

const max0 = (x: Cents): Cents => (x > 0n ? x : 0n);

export function computeGct(inputs: GctInputs, table: GctTable): GctResult {
  const trace: GctResult["trace"] = [];
  const eniTax = applyRate(max0(inputs.eni), table.eni_rate);
  trace.push({
    base: "eni",
    detail: `ENI ${formatCents(inputs.eni)} × ${table.eni_rate}`,
    amount: formatCents(eniTax),
  });
  const altBase = max0(
    inputs.eni + inputs.officerComp - BigInt(table.alt_base.exclusion_cents),
  );
  const altReduced = applyRate(altBase, table.alt_base.pct_of_eni_plus_comp);
  const altTax = applyRate(altReduced, table.eni_rate);
  trace.push({
    base: "alternative",
    detail:
      `(ENI + shareholder comp ${formatCents(inputs.officerComp)} − exclusion ` +
      `${formatCents(BigInt(table.alt_base.exclusion_cents))}) × ${table.alt_base.pct_of_eni_plus_comp} × ${table.eni_rate}`,
    amount: formatCents(altTax),
  });
  const capitalRaw = applyRate(max0(inputs.businessCapital), table.capital_base.rate);
  const cap = BigInt(table.capital_base.cap_cents);
  const capitalTax = capitalRaw < cap ? capitalRaw : cap;
  trace.push({
    base: "capital",
    detail: `capital ${formatCents(inputs.businessCapital)} × ${table.capital_base.rate}, capped at ${formatCents(cap)}`,
    amount: formatCents(capitalTax),
  });
  const fdm = fdmLookup(inputs.nycReceipts, table.fdm_brackets, "GCT FDM");
  trace.push({
    base: "fdm",
    detail: `NYC receipts ${formatCents(inputs.nycReceipts)} → fixed dollar minimum`,
    amount: formatCents(fdm),
  });
  const entries: Array<[GctResult["winner"], Cents]> = [
    ["eni", eniTax],
    ["alternative", altTax],
    ["capital", capitalTax],
    ["fdm", fdm],
  ];
  let winner = entries[0]!;
  for (const e of entries) if (e[1] > winner[1]) winner = e;
  return {
    bases: { eniTax, altTax, capitalTax, fdm },
    tax: winner[1],
    winner: winner[0],
    trace,
  };
}

export type EntityTaxWorkpaper = {
  taxYear: number;
  inputs: Record<string, string>;
  gct: GctResult;
  ct3sFdm: Cents;
  accrualEntryId: bigint | null;
  lines: WpLine[];
  tieOuts: Array<{ name: string; pass: boolean; detail: string }>;
};

/**
 * Build the GCT/CT-3-S workpaper from the ledger (via the 1120-S queries),
 * accrue Dr 5200 / Cr 2200 + 2210, and persist both workpapers. Refuses to
 * double-accrue — reverse the prior accrual entry first if inputs changed.
 */
export async function buildEntityTaxes(db: Dbx, taxYear: number): Promise<EntityTaxWorkpaper> {
  const gctTable = (await getVerifiedTable<GctTable>(db, taxYear, "gct")).payload;
  const ct3sTable = (await getVerifiedTable<Ct3sTable>(db, taxYear, "ct3s")).payload;

  const existing = await db.execute<{ n: number }>(dsql`
    SELECT count(*)::int AS n FROM journal_entries
    WHERE source_module = 'tax_accrual'
      AND entry_date BETWEEN ${`${taxYear}-01-01`} AND ${`${taxYear}-12-31`}
      AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = journal_entries.id)
  `);
  if ((existing.rows[0]?.n ?? 0) > 0) {
    throw new GctError(
      `${taxYear} already has an un-reversed tax accrual — reverse it before re-computing`,
    );
  }

  const wp = await buildF1120s(db, taxYear);
  const get = (lines: WpLine[], code: string): Cents =>
    lines.find((l) => l.code === code)?.cents ?? 0n;
  const p121 = get(wp.page1, "p1.21");
  const stateTaxActivity = await db.execute<{ v: bigint | null }>(dsql`
    SELECT (COALESCE(sum(l.debit),0)-COALESCE(sum(l.credit),0))::bigint AS v
    FROM journal_lines l JOIN accounts a ON a.id=l.account_id
    JOIN journal_entries e ON e.id=l.entry_id
    WHERE a.code = '5200'
      AND e.entry_date BETWEEN ${`${taxYear}-01-01`} AND ${`${taxYear}-12-31`}
  `);
  const eni = p121 + (stateTaxActivity.rows[0]?.v ?? 0n); // add back 5200 (form addback)
  const officerComp = await db.execute<{ v: bigint | null }>(dsql`
    SELECT (COALESCE(sum(l.debit),0)-COALESCE(sum(l.credit),0))::bigint AS v
    FROM journal_lines l JOIN accounts a ON a.id=l.account_id
    JOIN journal_entries e ON e.id=l.entry_id
    WHERE a.code IN ('5000','5030')
      AND e.entry_date BETWEEN ${`${taxYear}-01-01`} AND ${`${taxYear}-12-31`}
  `);
  const comp = officerComp.rows[0]?.v ?? 0n;
  const capital = wp.scheduleL.ending
    .filter((l) => ["L.1", "L.8", "L.10a", "L.10b"].includes(l.code))
    .reduce((a, l) => a + l.cents, 0n);
  const receipts = get(wp.page1, "p1.1a") + get(wp.page1, "p1.5");

  const gct = computeGct({ eni, officerComp: comp, businessCapital: capital, nycReceipts: receipts }, gctTable);
  const ct3sFdm = fdmLookup(receipts, ct3sTable.fdm_brackets, "CT-3-S FDM");

  let accrualEntryId: bigint | null = null;
  if (gct.tax + ct3sFdm > 0n) {
    const { entryId } = await postEntry(db, {
      entryDate: `${taxYear}-12-31`,
      memo: `accrue ${taxYear} entity taxes: NYC GCT (${gct.winner} base) + NYS fixed dollar minimum`,
      sourceModule: "tax_accrual",
      sourceId: BigInt(taxYear),
      lines: [
        { accountCode: "5200", debit: gct.tax + ct3sFdm },
        ...(gct.tax > 0n ? [{ accountCode: "2200", credit: gct.tax }] : []),
        ...(ct3sFdm > 0n ? [{ accountCode: "2210", credit: ct3sFdm }] : []),
      ],
    });
    accrualEntryId = entryId;
  }

  const balance = async (code: string): Promise<Cents> => {
    const r = await db.execute<{ v: bigint | null }>(dsql`
      SELECT (COALESCE(sum(l.credit),0)-COALESCE(sum(l.debit),0))::bigint AS v
      FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE a.code = ${code}
    `);
    return r.rows[0]?.v ?? 0n;
  };
  const tieOuts = [
    {
      name: "Accrued NYC GCT (2200) equals the computed liability (§4.11)",
      pass: (await balance("2200")) === gct.tax,
      detail: `2200 ${formatCents(await balance("2200"))} vs computed ${formatCents(gct.tax)}`,
    },
    {
      name: "Accrued NYS FDM (2210) equals the computed liability",
      pass: (await balance("2210")) === ct3sFdm,
      detail: `2210 ${formatCents(await balance("2210"))} vs computed ${formatCents(ct3sFdm)}`,
    },
  ];
  const mkLine = (code: string, label: string, cents: Cents): WpLine => ({
    code,
    label,
    cents,
    dollars: Number((cents + 50n) / 100n),
    accounts: [],
  });
  const lines = [
    mkLine("GCT.eni", "Entire net income base tax", gct.bases.eniTax),
    mkLine("GCT.alt", "Income-plus-compensation base tax", gct.bases.altTax),
    mkLine("GCT.capital", "Capital base tax (capped)", gct.bases.capitalTax),
    mkLine("GCT.fdm", "Fixed dollar minimum", gct.bases.fdm),
    mkLine("GCT.tax", `Tax due — HIGHEST base (${gct.winner})`, gct.tax),
    mkLine("CT3S.fdm", "CT-3-S fixed dollar minimum (NY receipts)", ct3sFdm),
  ];
  const result: EntityTaxWorkpaper = {
    taxYear,
    inputs: {
      eni: formatCents(eni),
      officerComp: formatCents(comp),
      businessCapital: formatCents(capital),
      nycReceipts: formatCents(receipts),
    },
    gct,
    ct3sFdm,
    accrualEntryId,
    lines,
    tieOuts,
  };
  await saveWorkpaper(db, "gct_nyc4s", taxYear, result, tieOuts);
  await saveWorkpaper(db, "ct3s", taxYear, { taxYear, fdm: formatCents(ct3sFdm), receipts: formatCents(receipts) }, []);
  return result;
}
