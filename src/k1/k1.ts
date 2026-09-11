/**
 * K-1 ingestion (§4.5): fields (extracted or hand-entered) → owner review
 * with the low-confidence gate (guardrail 5) → confirmation → a single
 * character-preserving journal entry. Box 19 distributions are NOT posted
 * here — the wires already credited the 15xx asset in §4.2; this module
 * reconciles them. Income is recognized only from confirmed K-1s.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, asc, eq, sql as dsql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import {
  auditLog,
  basisRollforwards,
  investees as investeesTable,
  k1Fields,
  k1s,
} from "../db/schema";
import type { Cents } from "../lib/cents";
import { formatCents } from "../lib/cents";
import { investeeAccountCode } from "../ledger/investees";
import { postEntry, type DraftLine } from "../ledger/posting";

export class K1Error extends Error {}

export type BoxMapEntry = {
  box: string;
  label: string;
  account: string | null;
  direction: "income" | "deduction" | "distribution" | "info";
  basis: "income" | "loss" | "tax_exempt" | "nondeductible" | "distribution" | "none";
};

let boxCache: Map<string, BoxMapEntry> | undefined;

export function boxMap(): Map<string, BoxMapEntry> {
  if (!boxCache) {
    const raw = JSON.parse(
      readFileSync(resolve(process.cwd(), "data/k1-map/1065-boxes.json"), "utf8"),
    ) as { boxes: BoxMapEntry[] };
    boxCache = new Map(raw.boxes.map((b) => [b.box, b]));
  }
  return boxCache;
}

export async function createK1(
  db: Dbx,
  args: { investeeId: number; taxYear: number; documentId: bigint },
): Promise<bigint> {
  const [investee] = await db
    .select()
    .from(investeesTable)
    .where(eq(investeesTable.id, args.investeeId));
  if (!investee) throw new K1Error(`investee ${args.investeeId} not found`);
  if (investee.entityType !== "partnership") {
    throw new K1Error(
      `${investee.name} is a ${investee.entityType}: only partnerships issue Schedule K-1 (Form 1065). ` +
        `C-corp holdings report on 1099-DIV/B instead (§4.5 optional-later).`,
    );
  }
  const [row] = await db
    .insert(k1s)
    .values({
      investeeId: args.investeeId,
      taxYear: args.taxYear,
      documentId: args.documentId,
    })
    .returning({ id: k1s.id });
  return row!.id;
}

export type FieldInput = {
  boxCode: string;
  valueCents?: Cents;
  valueText?: string;
  confidence?: "high" | "low";
};

/** Upsert fields. Extraction writes confidence per field; owner edits mark touched. */
export async function setK1Fields(
  db: Dbx,
  k1Id: bigint,
  fields: FieldInput[],
  source: "owner" | "extraction",
): Promise<void> {
  await db.transaction(async (tx) => {
    const [k1] = await tx.select().from(k1s).where(eq(k1s.id, k1Id)).for("update");
    if (!k1) throw new K1Error(`K-1 ${k1Id} not found`);
    if (k1.status !== "in_review") {
      throw new K1Error(`K-1 ${k1Id} is ${k1.status}; fields are frozen after confirmation`);
    }
    const map = boxMap();
    for (const f of fields) {
      const known = map.get(f.boxCode);
      if (!known && !/^\d+[A-Z]?$|^[A-Z]+\./.test(f.boxCode)) {
        throw new K1Error(`implausible box code ${JSON.stringify(f.boxCode)}`);
      }
      await tx
        .insert(k1Fields)
        .values({
          k1Id,
          boxCode: f.boxCode,
          label: known?.label ?? null,
          valueCents: f.valueCents ?? null,
          valueText: f.valueText ?? null,
          confidence: source === "extraction" ? (f.confidence ?? "low") : "high",
          ownerTouched: source === "owner",
        })
        .onConflictDoUpdate({
          target: [k1Fields.k1Id, k1Fields.boxCode],
          set: {
            valueCents: f.valueCents ?? null,
            valueText: f.valueText ?? null,
            ...(source === "extraction"
              ? { confidence: f.confidence ?? "low", ownerTouched: false }
              : { ownerTouched: true }),
          },
        });
    }
  });
}

/** Guardrail 5: confirmation is blocked while any low-confidence field is untouched. */
export async function confirmK1(db: Dbx, k1Id: bigint): Promise<void> {
  await db.transaction(async (tx) => {
    const [k1] = await tx.select().from(k1s).where(eq(k1s.id, k1Id)).for("update");
    if (!k1) throw new K1Error(`K-1 ${k1Id} not found`);
    if (k1.status !== "in_review") throw new K1Error(`K-1 ${k1Id} is already ${k1.status}`);
    const fields = await tx.select().from(k1Fields).where(eq(k1Fields.k1Id, k1Id));
    if (fields.length === 0) throw new K1Error("no fields entered yet");
    const blocked = fields.filter((f) => f.confidence === "low" && !f.ownerTouched);
    if (blocked.length > 0) {
      throw new K1Error(
        `cannot confirm: ${blocked.length} low-confidence field(s) not yet reviewed — ` +
          blocked.map((b) => `box ${b.boxCode}`).join(", ") +
          " (open each against the PDF and confirm or correct it)",
      );
    }
    await tx.update(k1s).set({ status: "confirmed", confirmedAt: new Date() }).where(eq(k1s.id, k1Id));
    await tx.insert(auditLog).values({
      actor: "owner",
      action: "confirm_k1",
      objectType: "k1",
      objectId: k1Id.toString(),
      detail: { fields: fields.length, taxYear: k1.taxYear },
    });
  });
}

/** Post the confirmed K-1: one entry, character preserved, dimensions on every line. */
export async function postK1(db: Dbx, k1Id: bigint): Promise<{ entryId: bigint }> {
  return await db.transaction(async (tx) => {
    const [k1] = await tx.select().from(k1s).where(eq(k1s.id, k1Id)).for("update");
    if (!k1) throw new K1Error(`K-1 ${k1Id} not found`);
    if (k1.status !== "confirmed") {
      throw new K1Error(`K-1 ${k1Id} is ${k1.status}; only confirmed K-1s post (§4.5)`);
    }
    const assetCode = await investeeAccountCode(tx, k1.investeeId);
    const fields = await tx
      .select()
      .from(k1Fields)
      .where(eq(k1Fields.k1Id, k1Id))
      .orderBy(asc(k1Fields.boxCode));
    const map = boxMap();
    const lines: DraftLine[] = [];
    let assetNet = 0n; // debit-positive movement of the 15xx account
    const unmapped: string[] = [];
    for (const f of fields) {
      if (f.valueCents === null || f.valueCents === 0n) continue;
      const m = map.get(f.boxCode);
      if (!m) {
        unmapped.push(f.boxCode);
        continue;
      }
      if (m.direction === "info" || m.direction === "distribution") continue;
      if (m.account === null) continue;
      const v = f.valueCents;
      const dim = { investeeId: k1.investeeId, k1Id, taxYear: k1.taxYear };
      if (m.direction === "income") {
        // positive income: Dr asset / Cr account; negative flips
        if (v > 0n) {
          lines.push({ accountCode: m.account, credit: v, ...dim, memo: `box ${f.boxCode}` });
          assetNet += v;
        } else {
          lines.push({ accountCode: m.account, debit: -v, ...dim, memo: `box ${f.boxCode}` });
          assetNet -= -v;
        }
      } else {
        // deduction: Dr account / Cr asset; negative flips
        if (v > 0n) {
          lines.push({ accountCode: m.account, debit: v, ...dim, memo: `box ${f.boxCode}` });
          assetNet -= v;
        } else {
          lines.push({ accountCode: m.account, credit: -v, ...dim, memo: `box ${f.boxCode}` });
          assetNet += -v;
        }
      }
    }
    if (unmapped.length > 0) {
      throw new K1Error(
        `unrecognized box code(s) ${unmapped.join(", ")} — add them to data/k1-map/1065-boxes.json ` +
          `after checking the year's instructions; never guess character (CPA open item)`,
      );
    }
    if (lines.length === 0) {
      throw new K1Error("no postable amounts on this K-1 (only info/distribution boxes)");
    }
    lines.unshift(
      assetNet >= 0n
        ? {
            accountCode: assetCode,
            debit: assetNet,
            investeeId: k1.investeeId,
            k1Id,
            taxYear: k1.taxYear,
          }
        : {
            accountCode: assetCode,
            credit: -assetNet,
            investeeId: k1.investeeId,
            k1Id,
            taxYear: k1.taxYear,
          },
    );
    const { entryId } = await postEntry(tx, {
      entryDate: `${k1.taxYear}-12-31`,
      memo: `K-1 ${k1.taxYear} — investee ${k1.investeeId} (pass-through, character preserved)`,
      sourceModule: "k1",
      sourceId: k1Id,
      lines: lines.filter((l) => (l.debit ?? 0n) !== 0n || (l.credit ?? 0n) !== 0n),
    });
    await tx.update(k1s).set({ status: "posted", journalEntryId: entryId }).where(eq(k1s.id, k1Id));
    await tx.insert(auditLog).values({
      actor: "owner",
      action: "post_k1",
      objectType: "k1",
      objectId: k1Id.toString(),
      detail: { entryId: entryId.toString(), taxYear: k1.taxYear },
    });
    return { entryId };
  });
}

export type Box19Reconciliation = {
  k1Distributions: Cents;
  bankClassifiedWires: Cents;
  difference: Cents;
  explanationNeeded: boolean;
};

/** §4.5: K-1 box 19 vs the investee wires already classified in §4.2. */
export async function box19Reconciliation(db: Dbx, k1Id: bigint): Promise<Box19Reconciliation> {
  const [k1] = await db.select().from(k1s).where(eq(k1s.id, k1Id));
  if (!k1) throw new K1Error(`K-1 ${k1Id} not found`);
  const fields = await db
    .select()
    .from(k1Fields)
    .where(and(eq(k1Fields.k1Id, k1Id), eq(k1Fields.boxCode, "19A")));
  const k1Distributions = fields[0]?.valueCents ?? 0n;
  const wires = await db.execute<{ total: bigint | null }>(dsql`
    SELECT COALESCE(sum(l.credit - l.debit), 0)::bigint AS total
    FROM journal_lines l
    JOIN accounts a ON a.id = l.account_id
    JOIN journal_entries e ON e.id = l.entry_id
    WHERE a.investee_id = ${k1.investeeId}
      AND e.source_module = 'bank'
      AND e.entry_date BETWEEN ${`${k1.taxYear}-01-01`} AND ${`${k1.taxYear}-12-31`}
  `);
  const bankClassifiedWires = wires.rows[0]?.total ?? 0n;
  const difference = k1Distributions - bankClassifiedWires;
  return {
    k1Distributions,
    bankClassifiedWires,
    difference,
    explanationNeeded: difference !== 0n,
  };
}

/**
 * Outside-basis roll-forward (§4.5), §705/§704(d) ordering:
 * beginning + contributions + income + tax-exempt, then distributions
 * (excess over basis = flagged gain, basis floors at zero), then
 * nondeductibles (limited to remaining), then losses (limited to remaining;
 * the rest joins the suspended-loss carryforward). Item L is stored
 * separately and never conflated with basis.
 */
export async function rollForwardBasis(
  db: Dbx,
  investeeId: number,
  taxYear: number,
  opts: { contributions?: Cents } = {},
): Promise<typeof basisRollforwards.$inferSelect> {
  return await db.transaction(async (tx) => {
    const [k1] = await tx
      .select()
      .from(k1s)
      .where(and(eq(k1s.investeeId, investeeId), eq(k1s.taxYear, taxYear)));
    if (!k1 || (k1.status !== "confirmed" && k1.status !== "posted")) {
      throw new K1Error(
        `no confirmed K-1 for investee ${investeeId} year ${taxYear} — basis rolls only from confirmed extractions`,
      );
    }
    const [prior] = await tx
      .select()
      .from(basisRollforwards)
      .where(
        and(
          eq(basisRollforwards.investeeId, investeeId),
          eq(basisRollforwards.taxYear, taxYear - 1),
        ),
      );
    const [investee] = await tx
      .select()
      .from(investeesTable)
      .where(eq(investeesTable.id, investeeId));
    const firstYear = Number(investee!.acquiredOn.slice(0, 4));
    if (!prior && taxYear > firstYear) {
      throw new K1Error(
        `no ${taxYear - 1} basis row for investee ${investeeId}: roll years in order starting ${firstYear}`,
      );
    }
    const beginning = prior?.endingBasis ?? 0n;
    const priorSuspended = prior?.suspendedLosses ?? 0n;
    const contributions =
      opts.contributions ?? (prior ? 0n : investee!.initialContribution);

    const fields = await tx.select().from(k1Fields).where(eq(k1Fields.k1Id, k1.id));
    const map = boxMap();
    let income = 0n;
    let taxExempt = 0n;
    let losses = 0n;
    let nondeductibles = 0n;
    let distributions = 0n;
    for (const f of fields) {
      if (f.valueCents === null || f.valueCents === 0n) continue;
      const m = map.get(f.boxCode);
      if (!m) continue; // postK1 already rejects unmapped money boxes
      const v = f.valueCents;
      switch (m.basis) {
        case "income":
          if (v > 0n) income += v;
          else losses += -v; // loss character flows to the loss limitation
          break;
        case "tax_exempt":
          taxExempt += v;
          break;
        case "loss":
          losses += v > 0n ? v : -v;
          break;
        case "nondeductible":
          nondeductibles += v > 0n ? v : -v;
          break;
        case "distribution":
          distributions += v;
          break;
        case "none":
          break;
      }
    }
    const lossesWithCarry = losses + priorSuspended;

    let remaining = beginning + contributions + income + taxExempt;
    const distributionsApplied = distributions <= remaining ? distributions : remaining;
    const excessDistributions = distributions - distributionsApplied;
    remaining -= distributionsApplied;
    const nondeductiblesApplied = nondeductibles <= remaining ? nondeductibles : remaining;
    remaining -= nondeductiblesApplied;
    const lossAllowed = lossesWithCarry <= remaining ? lossesWithCarry : remaining;
    const suspended = lossesWithCarry - lossAllowed;
    const ending = remaining - lossAllowed;

    const reported = fields.find((f) => f.boxCode === "L.ending")?.valueCents ?? null;
    const [row] = await tx
      .insert(basisRollforwards)
      .values({
        investeeId,
        taxYear,
        beginningBasis: beginning,
        contributions,
        incomeItems: income,
        taxExemptIncome: taxExempt,
        distributionsApplied,
        excessDistributions,
        nondeductiblesApplied,
        lossDeductionItems: lossAllowed,
        suspendedLosses: suspended,
        endingBasis: ending,
        reportedCapitalAccount: reported,
        trace: {
          ordering: "705: +contributions +income +tax-exempt, -distributions (excess=gain), -nondeductibles, -losses (excess suspended)",
          beginning: formatCents(beginning),
          priorSuspendedLosses: formatCents(priorSuspended),
          income: formatCents(income),
          taxExempt: formatCents(taxExempt),
          distributions: formatCents(distributions),
          excessDistributions: formatCents(excessDistributions),
          nondeductibles: formatCents(nondeductibles),
          lossesIncludingCarry: formatCents(lossesWithCarry),
          lossAllowed: formatCents(lossAllowed),
          suspended: formatCents(suspended),
          ending: formatCents(ending),
          k1Id: k1.id.toString(),
        },
      })
      .returning();
    await tx.insert(auditLog).values({
      actor: "owner",
      action: "roll_forward_basis",
      objectType: "basis_rollforward",
      objectId: String(row!.id),
      detail: {
        investeeId,
        taxYear,
        ending: ending.toString(),
        suspended: suspended.toString(),
        excessDistributions: excessDistributions.toString(),
      },
    });
    return row!;
  });
}
