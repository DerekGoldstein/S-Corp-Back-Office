/**
 * Fixed-asset register (brief §7): S-corp-era assets (>= 2027) with their
 * invoices, §179/bonus elections gated on the verified per-year
 * `depreciation` table, and ONE annual posting Dr 5050 / Cr 1610 backed by
 * per-asset detail rows. Ordering is enforced (a year posts only after every
 * older asset's prior year is posted) so stored conventions and bonus
 * amounts are always the ones actually deducted. Disposal accounting is
 * deferred: a disposed_on date stops future depreciation, and posting a year
 * in which an asset was disposed refuses loudly instead of guessing at
 * §1245 recapture.
 */
import { asc, eq, isNull, sql as dsql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import {
  auditLog,
  depreciationPostings,
  fixedAssets,
  type FixedAsset,
} from "../db/schema";
import type { Cents } from "../lib/cents";
import { formatCents } from "../lib/cents";
import { getVerifiedTable } from "../tax/tables";
import { postEntry } from "../ledger/posting";
import {
  type Convention,
  type MacrsMethod,
  type RecoveryYears,
  macrsSchedule,
  midQuarterTest,
  quarterOf,
} from "./macrs";

export class AssetError extends Error {}

/** "40%" / "12.5%" → exact rational fraction of one. */
export function parsePct(pct: string): { num: bigint; den: bigint } {
  const m = /^(\d+)(?:\.(\d+))?%$/.exec(pct.trim());
  if (!m) throw new AssetError(`unparseable percentage ${JSON.stringify(pct)} — use e.g. "40%"`);
  const frac = m[2] ?? "";
  return { num: BigInt(m[1]! + frac), den: 100n * 10n ** BigInt(frac.length) };
}

/** amount × pct, half-up to the cent. */
export function applyPct(amount: Cents, pct: string): Cents {
  const { num, den } = parsePct(pct);
  return (amount * num * 2n + den) / (den * 2n);
}

export type DepreciationTable = {
  section179_limit_cents: number | string;
  section179_phaseout_start_cents: number | string;
  bonus_pct: string; // e.g. "40%" as enacted for the year under §168(k)
};

const RECOVERY_YEARS: readonly number[] = [3, 5, 7, 10, 15, 20];

export async function addAsset(
  db: Dbx,
  input: {
    description: string;
    placedInService: string;
    cost: Cents;
    businessUsePct?: string;
    method: MacrsMethod;
    recoveryYears: number;
    section179?: Cents;
    takeBonus?: boolean;
    documentId: bigint; // purchase invoice (guardrail 6)
    note?: string;
  },
): Promise<bigint> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.placedInService)) {
    throw new AssetError("placed-in-service must be YYYY-MM-DD");
  }
  if (input.placedInService < "2027-01-01") {
    throw new AssetError(
      "pre-election assets (before 2027-01-01) enter via manual opening balances with the CPA's schedule, not the register",
    );
  }
  if (input.cost <= 0n) throw new AssetError("cost must be positive");
  if (!RECOVERY_YEARS.includes(input.recoveryYears)) {
    throw new AssetError(
      `recovery period ${input.recoveryYears} not supported — GDS personal property only (3/5/7/10/15/20); real property is out of scope`,
    );
  }
  const pct = input.businessUsePct ?? "100%";
  const { num, den } = parsePct(pct); // throws on malformed rates
  if (num <= 0n || num > den) {
    throw new AssetError("business use must be within (0%, 100%]");
  }
  const base = applyPct(input.cost, pct);
  const s179 = input.section179 ?? 0n;
  if (s179 < 0n || s179 > base) {
    throw new AssetError(`§179 election must be within the depreciable basis ${formatCents(base)}`);
  }
  if ((s179 > 0n || input.takeBonus) && num * 2n <= den) {
    throw new AssetError("§179/bonus elections require more-than-50% business use");
  }
  const [row] = await db
    .insert(fixedAssets)
    .values({
      description: input.description,
      placedInService: input.placedInService,
      cost: input.cost,
      businessUsePct: pct,
      method: input.method,
      recoveryYears: input.recoveryYears,
      section179: s179,
      takeBonus: input.takeBonus ?? false,
      documentId: input.documentId,
      note: input.note ?? null,
    })
    .returning({ id: fixedAssets.id });
  return row!.id;
}

function placedYear(a: FixedAsset): number {
  return Number(a.placedInService.slice(0, 4));
}

function basisAfter179(a: FixedAsset): Cents {
  return applyPct(a.cost, a.businessUsePct) - a.section179;
}

export type AssetYearLine = {
  assetId: bigint;
  description: string;
  recoveryYears: number;
  method: string;
  convention: Convention;
  quarter: 1 | 2 | 3 | 4;
  macrsBasis: Cents;
  section179: Cents; // this year (placement year only)
  bonus: Cents; // this year (placement year only)
  macrsDeduction: Cents;
  total: Cents;
};

export type YearComputation = {
  taxYear: number;
  lines: AssetYearLine[];
  total: Cents;
  section179Total: Cents;
  bonusTotal: Cents;
  macrsTotal: Cents;
  cohortConvention: Convention | null; // this year's placements (null if none)
  tableId: number | null; // verified depreciation table used, if elections
  limits: { limit: Cents; phaseoutStart: Cents; reduced: Cents; bonusPct: string } | null;
};

/**
 * Deterministic recomputation of the year's deduction for every non-disposed
 * asset. For already-posted placement years the STORED convention and
 * bonus_applied are authoritative; for the current cohort they come from the
 * mid-quarter test and the verified table.
 */
export async function computeYearDepreciation(db: Dbx, taxYear: number): Promise<YearComputation> {
  const assets = await db
    .select()
    .from(fixedAssets)
    .where(isNull(fixedAssets.disposedOn))
    .orderBy(asc(fixedAssets.id));
  const disposed = await db.select().from(fixedAssets).where(dsql`disposed_on IS NOT NULL`);
  for (const d of disposed) {
    if (Number(d.disposedOn!.slice(0, 4)) === taxYear) {
      throw new AssetError(
        `asset #${d.id} (${d.description}) was disposed in ${taxYear}: disposal-year depreciation and §1245 recapture are CPA-manual for now — post it as a manual entry`,
      );
    }
  }
  const inScope = assets.filter((a) => placedYear(a) <= taxYear);
  const cohort = inScope.filter((a) => placedYear(a) === taxYear);

  // Elections in the current cohort need this year's verified limits.
  let limits: YearComputation["limits"] = null;
  let tableId: number | null = null;
  const hasElections = cohort.some((a) => a.section179 > 0n || a.takeBonus);
  if (hasElections) {
    const t = await getVerifiedTable<DepreciationTable>(db, taxYear, "depreciation");
    tableId = t.id;
    const limit = BigInt(t.payload.section179_limit_cents);
    const phaseoutStart = BigInt(t.payload.section179_phaseout_start_cents);
    const totalPlaced = cohort.reduce((s, a) => s + applyPct(a.cost, a.businessUsePct), 0n);
    const over = totalPlaced > phaseoutStart ? totalPlaced - phaseoutStart : 0n;
    const reduced = limit > over ? limit - over : 0n;
    limits = { limit, phaseoutStart, reduced, bonusPct: t.payload.bonus_pct };
    const s179Total = cohort.reduce((s, a) => s + a.section179, 0n);
    if (s179Total > reduced) {
      throw new AssetError(
        `§179 elections total ${formatCents(s179Total)} exceed the ${taxYear} dollar limit ` +
          `${formatCents(reduced)} (limit ${formatCents(limit)}, phase-out over ${formatCents(phaseoutStart)})`,
      );
    }
  }

  // Mid-quarter test for this year's cohort (after §179, before bonus).
  const cohortConvention: Convention | null =
    cohort.length === 0
      ? null
      : midQuarterTest(
          cohort.map((a) => ({
            basisAfter179: basisAfter179(a),
            quarter: quarterOf(a.placedInService),
          })),
        );

  const lines: AssetYearLine[] = [];
  for (const a of inScope) {
    const py = placedYear(a);
    const isPlacementYear = py === taxYear;
    const convention: Convention =
      (a.convention as Convention | null) ?? (isPlacementYear ? cohortConvention! : "half_year");
    if (!a.convention && !isPlacementYear) {
      throw new AssetError(
        `asset #${a.id} (${a.description}) has no posted placement year ${py} — post years in order`,
      );
    }
    const after179 = basisAfter179(a);
    const bonus = isPlacementYear
      ? a.takeBonus
        ? applyPct(after179, limits!.bonusPct)
        : 0n
      : a.bonusApplied;
    const macrsBasis = after179 - bonus;
    const schedule = macrsSchedule({
      basis: macrsBasis,
      method: a.method as MacrsMethod,
      recoveryYears: a.recoveryYears as RecoveryYears,
      convention,
      quarter: quarterOf(a.placedInService),
    });
    const idx = taxYear - py;
    const macrsDeduction = schedule[idx] ?? 0n;
    const s179ThisYear = isPlacementYear ? a.section179 : 0n;
    const bonusThisYear = isPlacementYear ? bonus : 0n;
    lines.push({
      assetId: a.id,
      description: a.description,
      recoveryYears: a.recoveryYears,
      method: a.method,
      convention,
      quarter: quarterOf(a.placedInService),
      macrsBasis,
      section179: s179ThisYear,
      bonus: bonusThisYear,
      macrsDeduction,
      total: s179ThisYear + bonusThisYear + macrsDeduction,
    });
  }
  return {
    taxYear,
    lines,
    total: lines.reduce((s, l) => s + l.total, 0n),
    section179Total: lines.reduce((s, l) => s + l.section179, 0n),
    bonusTotal: lines.reduce((s, l) => s + l.bonus, 0n),
    macrsTotal: lines.reduce((s, l) => s + l.macrsDeduction, 0n),
    cohortConvention,
    tableId,
    limits,
  };
}

/** Unreversed depreciation postings for a year (reversed entries excluded). */
export async function postedForYear(db: Dbx, taxYear: number) {
  const r = await db.execute<{ asset_id: bigint; amount: bigint; journal_entry_id: bigint }>(dsql`
    SELECT p.asset_id, p.amount::bigint AS amount, p.journal_entry_id
    FROM depreciation_postings p
    WHERE p.tax_year = ${taxYear}
      AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = p.journal_entry_id)
    ORDER BY p.asset_id
  `);
  return r.rows;
}

/**
 * Posts the year's single depreciation entry (Dr 5050 / Cr 1610) and the
 * per-asset detail, freezing each cohort asset's convention and bonus.
 */
export async function postAnnualDepreciation(
  db: Dbx,
  taxYear: number,
  entryDate = `${taxYear}-12-31`,
): Promise<{ entryId: bigint; total: Cents; assets: number }> {
  return await db.transaction(async (tx) => {
    const existing = await postedForYear(tx, taxYear);
    if (existing.length > 0) {
      throw new AssetError(
        `depreciation for ${taxYear} is already posted (entry #${existing[0]!.journal_entry_id}) — reverse it first to re-post`,
      );
    }
    const comp = await computeYearDepreciation(tx, taxYear);
    if (comp.lines.length === 0 || comp.total === 0n) {
      throw new AssetError(`nothing to depreciate in ${taxYear}`);
    }
    const { entryId } = await postEntry(tx, {
      entryDate,
      memo: `annual depreciation ${taxYear}: ${comp.lines.length} asset(s), MACRS computed (§179 ${formatCents(comp.section179Total)}, bonus ${formatCents(comp.bonusTotal)})`,
      sourceModule: "fixed_asset",
      sourceId: BigInt(taxYear), // the subledger key is the year itself
      lines: [
        { accountCode: "5050", debit: comp.total, taxYear },
        { accountCode: "1610", credit: comp.total, taxYear },
      ],
    });
    for (const l of comp.lines) {
      await tx.insert(depreciationPostings).values({
        assetId: l.assetId,
        taxYear,
        amount: l.total,
        journalEntryId: entryId,
        detail: {
          method: l.method,
          convention: l.convention,
          recoveryYears: l.recoveryYears,
          macrsBasis: l.macrsBasis.toString(),
          section179: l.section179.toString(),
          bonus: l.bonus.toString(),
          macrsDeduction: l.macrsDeduction.toString(),
          tableId: comp.tableId,
        },
      });
    }
    // Freeze cohort assets: convention from this year's test, bonus as taken.
    for (const l of comp.lines) {
      const [asset] = await tx.select().from(fixedAssets).where(eq(fixedAssets.id, l.assetId));
      if (asset && !asset.convention && Number(asset.placedInService.slice(0, 4)) === taxYear) {
        await tx
          .update(fixedAssets)
          .set({ convention: l.convention, bonusApplied: l.bonus })
          .where(eq(fixedAssets.id, l.assetId));
      }
    }
    await tx.insert(auditLog).values({
      actor: "owner",
      action: "post_depreciation",
      objectType: "journal_entry",
      objectId: entryId.toString(),
      detail: {
        taxYear,
        total: comp.total.toString(),
        assets: comp.lines.length,
        convention: comp.cohortConvention,
        tableId: comp.tableId,
      },
    });
    return { entryId, total: comp.total, assets: comp.lines.length };
  });
}

/** Record a disposal date (stops future depreciation; accounting is manual). */
export async function recordDisposal(db: Dbx, assetId: bigint, disposedOn: string): Promise<void> {
  const [a] = await db.select().from(fixedAssets).where(eq(fixedAssets.id, assetId));
  if (!a) throw new AssetError(`asset ${assetId} not found`);
  if (a.disposedOn) throw new AssetError(`asset ${assetId} already disposed ${a.disposedOn}`);
  await db.update(fixedAssets).set({ disposedOn }).where(eq(fixedAssets.id, assetId));
  await db.insert(auditLog).values({
    actor: "owner",
    action: "record_disposal",
    objectType: "fixed_asset",
    objectId: assetId.toString(),
    detail: { disposedOn },
  });
}

/** Cumulative unreversed depreciation per asset (for the register view). */
export async function accumulatedByAsset(db: Dbx): Promise<Map<string, Cents>> {
  const r = await db.execute<{ asset_id: bigint; total: bigint }>(dsql`
    SELECT p.asset_id, COALESCE(sum(p.amount),0)::bigint AS total
    FROM depreciation_postings p
    WHERE NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_entry_id = p.journal_entry_id)
    GROUP BY p.asset_id
  `);
  return new Map(r.rows.map((row) => [row.asset_id.toString(), BigInt(row.total)]));
}

export async function listAssets(db: Dbx): Promise<FixedAsset[]> {
  return db.select().from(fixedAssets).orderBy(asc(fixedAssets.id));
}
