/**
 * Reasonable compensation (§4.3): annual comp = Σ (hours by task type ×
 * market rate by task type), under a versioned methodology that is FROZEN
 * before the year begins. Every computation stores a full trace; the export
 * pack is the evidence bundle behind the December W-2 number.
 */
import { and, eq, gte, lte, sql as dsql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import {
  auditLog,
  compComputationLines,
  compComputations,
  compMethodologies,
  corroborationMetrics,
  rateSources,
  taskTypes,
  timeEntries,
  type CompMethodologyParams,
} from "../db/schema";
import type { Cents } from "../lib/cents";
import { formatCents } from "../lib/cents";

export class CompError extends Error {}

/** Brief §4.3's starting task types; idempotent. */
export async function ensureDefaultTaskTypes(db: Dbx): Promise<void> {
  const defaults = [
    "credit underwriting",
    "deal review",
    "deal sourcing",
    "consulting delivery",
    "admin/compliance",
  ];
  for (const name of defaults) {
    await db.insert(taskTypes).values({ name }).onConflictDoNothing();
  }
}

export async function createMethodology(
  db: Dbx,
  input: { version: number; description: string; parameters: CompMethodologyParams },
) {
  const [row] = await db
    .insert(compMethodologies)
    .values({
      version: input.version,
      description: input.description,
      parameters: input.parameters,
    })
    .returning();
  return row!;
}

/** Freezing is one-way; the DB trigger then makes the row immutable. */
export async function freezeMethodology(db: Dbx, id: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [m] = await tx.select().from(compMethodologies).where(eq(compMethodologies.id, id));
    if (!m) throw new CompError(`methodology ${id} not found`);
    if (m.frozen) throw new CompError(`methodology v${m.version} is already frozen`);
    await tx
      .update(compMethodologies)
      .set({ frozen: true, frozenAt: new Date() })
      .where(eq(compMethodologies.id, id));
    await tx.insert(auditLog).values({
      actor: "owner",
      action: "freeze_comp_methodology",
      objectType: "comp_methodology",
      objectId: String(id),
      detail: { version: m.version },
    });
  });
}

/** hundredths of an hour, exact (hours column is numeric(_,2) as string) */
function hoursToHundredths(hours: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(hours);
  if (!m) throw new CompError(`unparseable hours value ${hours}`);
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0") || "0");
}

function aggregateRate(rates: Cents[], how: CompMethodologyParams["rateAggregation"]): Cents {
  if (rates.length === 0) throw new CompError("no rates to aggregate");
  const sorted = [...rates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  switch (how) {
    case "min":
      return sorted[0]!;
    case "mean": {
      const sum = sorted.reduce((a, b) => a + b, 0n);
      const n = BigInt(sorted.length);
      return (sum + n / 2n) / n; // half-up
    }
    case "median": {
      const mid = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 1) return sorted[mid]!;
      return (sorted[mid - 1]! + sorted[mid]! + 1n) / 2n; // half-up
    }
  }
}

export type CompLineTrace = {
  taskType: string;
  hours: string;
  rateSourceIds: number[];
  rates: string[];
  aggregatedRate: string;
  amount: string;
};

export type CompResult = {
  computationId: bigint;
  taxYear: number;
  total: Cents;
  methodologyVersion: number;
  methodologyFrozen: boolean;
  lines: CompLineTrace[];
  warnings: string[];
};

export async function computeCompensation(
  db: Dbx,
  args: { taxYear: number; methodologyId: number },
): Promise<CompResult> {
  return await db.transaction(async (tx) => {
    const [methodology] = await tx
      .select()
      .from(compMethodologies)
      .where(eq(compMethodologies.id, args.methodologyId));
    if (!methodology) throw new CompError(`methodology ${args.methodologyId} not found`);
    const warnings: string[] = [];
    if (!methodology.frozen) {
      warnings.push(
        `methodology v${methodology.version} is NOT frozen — freeze it before 1/1 of the comp year (§4.3)`,
      );
    }
    const from = `${args.taxYear}-01-01`;
    const to = `${args.taxYear}-12-31`;
    const hoursRows = await tx
      .select({
        taskTypeId: timeEntries.taskTypeId,
        name: taskTypes.name,
        hundredths: dsql<bigint>`(sum(${timeEntries.hours}) * 100)::bigint`,
      })
      .from(timeEntries)
      .innerJoin(taskTypes, eq(taskTypes.id, timeEntries.taskTypeId))
      .where(and(gte(timeEntries.entryDate, from), lte(timeEntries.entryDate, to)))
      .groupBy(timeEntries.taskTypeId, taskTypes.name);
    if (hoursRows.length === 0) {
      throw new CompError(`no time entries logged for ${args.taxYear}`);
    }
    const allRates = await tx.select().from(rateSources).where(eq(rateSources.active, true));
    const lines: CompLineTrace[] = [];
    let total = 0n;
    const dbLines: (typeof compComputationLines.$inferInsert)[] = [];
    for (const h of hoursRows.sort((a, b) => a.name.localeCompare(b.name))) {
      const sources = allRates.filter((r) => r.taskTypeId === h.taskTypeId);
      if (sources.length === 0) {
        throw new CompError(
          `task type "${h.name}" has ${Number(h.hundredths) / 100} hours logged but no active ` +
            `rate source — add a market rate with its citation before computing (§4.3)`,
        );
      }
      const rate = aggregateRate(
        sources.map((s) => s.hourlyRate),
        methodology.parameters.rateAggregation,
      );
      // amount = rate × hours, half-up to the cent
      const amount = (rate * h.hundredths + 50n) / 100n;
      total += amount;
      lines.push({
        taskType: h.name,
        hours: (Number(h.hundredths) / 100).toFixed(2),
        rateSourceIds: sources.map((s) => s.id),
        rates: sources.map((s) => formatCents(s.hourlyRate)),
        aggregatedRate: formatCents(rate),
        amount: formatCents(amount),
      });
      dbLines.push({
        computationId: 0n, // filled below
        taskTypeId: h.taskTypeId,
        hours: (Number(h.hundredths) / 100).toFixed(2),
        rate,
        amount,
        rateSourceIds: sources.map((s) => s.id),
      });
    }
    const corro = await tx
      .select()
      .from(corroborationMetrics)
      .where(dsql`${corroborationMetrics.period} LIKE ${args.taxYear + "%"}`);
    const [computation] = await tx
      .insert(compComputations)
      .values({
        methodologyId: methodology.id,
        taxYear: args.taxYear,
        total,
        corroboration: corro.map((c) => ({
          period: c.period,
          metric: c.metric,
          value: c.value,
          sourceNote: c.sourceNote,
        })),
        trace: {
          methodology: {
            version: methodology.version,
            frozen: methodology.frozen,
            frozenAt: methodology.frozenAt,
            parameters: methodology.parameters,
          },
          lines,
          rounding: "rate aggregation and line amounts round half-up to the cent",
          total: formatCents(total),
          warnings,
        },
      })
      .returning({ id: compComputations.id });
    const computationId = computation!.id;
    for (const l of dbLines) {
      await tx.insert(compComputationLines).values({ ...l, computationId });
    }
    await tx.insert(auditLog).values({
      actor: "owner",
      action: "compute_compensation",
      objectType: "comp_computation",
      objectId: computationId.toString(),
      detail: { taxYear: args.taxYear, total: total.toString(), version: methodology.version },
    });
    return {
      computationId,
      taxYear: args.taxYear,
      total,
      methodologyVersion: methodology.version,
      methodologyFrozen: methodology.frozen,
      lines,
      warnings,
    };
  });
}

/** The comp-memo data pack (§4.3) as markdown — vaulted by the caller. */
export async function renderCompMemoPack(db: Dbx, computationId: bigint): Promise<string> {
  const [c] = await db
    .select()
    .from(compComputations)
    .where(eq(compComputations.id, computationId));
  if (!c) throw new CompError(`computation ${computationId} not found`);
  const [m] = await db
    .select()
    .from(compMethodologies)
    .where(eq(compMethodologies.id, c.methodologyId));
  const trace = c.trace as {
    lines: CompLineTrace[];
    warnings: string[];
  };
  const sources = await db.select().from(rateSources);
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const md: string[] = [];
  md.push(`# Reasonable-compensation memo data pack — tax year ${c.taxYear}`);
  md.push("");
  md.push(
    `Methodology v${m!.version} (${m!.frozen ? `frozen ${m!.frozenAt?.toISOString().slice(0, 10)}` : "NOT FROZEN"})` +
      ` — rate aggregation: ${m!.parameters.rateAggregation}. ${m!.description}`,
  );
  md.push("");
  md.push("## Computation");
  md.push("");
  md.push("| Task type | Hours | Rates considered | Rate used | Amount |");
  md.push("|---|---:|---|---:|---:|");
  for (const l of trace.lines) {
    md.push(
      `| ${l.taskType} | ${l.hours} | ${l.rates.join(", ")} | ${l.aggregatedRate} | $${l.amount} |`,
    );
  }
  md.push(`| **Total** | | | | **$${formatCents(c.total)}** |`);
  md.push("");
  md.push("## Rate sources");
  md.push("");
  md.push("| Task type | Rate | Kind | Citation | Conversion | Captured |");
  md.push("|---|---:|---|---|---|---|");
  for (const l of trace.lines) {
    for (const id of l.rateSourceIds) {
      const s = sourceById.get(id);
      if (!s) continue;
      md.push(
        `| ${l.taskType} | $${formatCents(s.hourlyRate)}/hr | ${s.sourceKind} | ${s.citation} | ${s.conversionNote ?? ""} | ${s.capturedOn} |`,
      );
    }
  }
  md.push("");
  md.push("## Corroboration");
  md.push("");
  const corro = (c.corroboration ?? []) as Array<{
    period: string;
    metric: string;
    value: string;
    sourceNote: string | null;
  }>;
  if (corro.length === 0) {
    md.push("_No corroboration metrics recorded for the year._");
  } else {
    md.push("| Period | Metric | Value | Source |");
    md.push("|---|---|---:|---|");
    for (const x of corro) md.push(`| ${x.period} | ${x.metric} | ${x.value} | ${x.sourceNote ?? ""} |`);
  }
  if (trace.warnings.length > 0) {
    md.push("");
    md.push("## Warnings");
    for (const w of trace.warnings) md.push(`- ${w}`);
  }
  md.push("");
  md.push(
    `_Computed ${c.computedAt.toISOString()}; computation id ${c.id}; every figure traces to ` +
      `stored time entries, rate sources, and the versioned methodology._`,
  );
  return md.join("\n");
}
