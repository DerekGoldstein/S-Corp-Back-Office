/**
 * Compliance calendar (§5): rules (data) → dated items per calendar year.
 * Every due date rolls forward past weekends and the year's VERIFIED holiday
 * table — the calendar refuses to generate without one, which is guardrail 1
 * applied to dates. Filing confirmations from the vault complete items.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { Dbx } from "../db/client";
import { appConfig, auditLog, calendarItems, calendarRules } from "../db/schema";
import { getVerifiedTable } from "../tax/tables";
import { linkDocument } from "../vault/store";

export class CalendarError extends Error {}

export type DueSpec =
  | { type: "fixed"; month: number; day: number; taxYearOffset?: number }
  | { type: "multi_fixed"; dates: Array<[number, number, string?, number?]> }
  | { type: "anniversary_month"; month: number; everyNYears: number; baseYear: number }
  | { type: "event"; event: string };

type RuleFile = {
  rules: Array<{
    slug: string;
    name: string;
    due: DueSpec;
    channel?: string;
    amount_source?: string;
    condition_key?: string;
    applies_from_year?: number;
    applies_to_year?: number;
    notes?: string;
  }>;
};

/** Upsert rules from data/calendar/rules.json (idempotent; slug-keyed). */
export async function loadCalendarRules(db: Dbx): Promise<number> {
  const raw = JSON.parse(
    readFileSync(resolve(process.cwd(), "data/calendar/rules.json"), "utf8"),
  ) as RuleFile;
  let n = 0;
  for (const r of raw.rules) {
    await db
      .insert(calendarRules)
      .values({
        slug: r.slug,
        name: r.name,
        due: r.due,
        channel: r.channel ?? null,
        amountSource: r.amount_source ?? null,
        conditionKey: r.condition_key ?? null,
        appliesFromYear: r.applies_from_year ?? null,
        appliesToYear: r.applies_to_year ?? null,
        notes: r.notes ?? null,
      })
      .onConflictDoUpdate({
        target: calendarRules.slug,
        set: {
          name: r.name,
          due: r.due,
          channel: r.channel ?? null,
          amountSource: r.amount_source ?? null,
          conditionKey: r.condition_key ?? null,
          appliesFromYear: r.applies_from_year ?? null,
          appliesToYear: r.applies_to_year ?? null,
          notes: r.notes ?? null,
        },
      });
    n++;
  }
  return n;
}

// --- date math (UTC, string in/out — no timezone drift) --------------------

function toUTC(d: string): number {
  return Date.parse(`${d}T00:00:00Z`);
}

function fromUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayOfWeek(d: string): number {
  return new Date(toUTC(d)).getUTCDay(); // 0=Sun..6=Sat
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function rollToBusinessDay(date: string, holidays: ReadonlySet<string>): string {
  let d = date;
  for (let i = 0; i < 15; i++) {
    const dow = dayOfWeek(d);
    if (dow !== 0 && dow !== 6 && !holidays.has(d)) return d;
    d = fromUTC(toUTC(d) + 86_400_000);
  }
  throw new CalendarError(`could not find a business day within 15 days of ${date}`);
}

async function holidaySet(db: Dbx, calendarYear: number): Promise<Set<string>> {
  const { payload } = await getVerifiedTable<{ dates: string[] }>(db, calendarYear, "holidays");
  if (!Array.isArray(payload.dates)) {
    throw new CalendarError(`holidays table for ${calendarYear} has no dates array`);
  }
  return new Set(payload.dates);
}

export type Occurrence = { seq: number; label: string; dueDate: string };

export function occurrences(
  rule: { name: string; due: DueSpec },
  calendarYear: number,
  holidays: ReadonlySet<string>,
): Occurrence[] {
  const due = rule.due;
  switch (due.type) {
    case "fixed": {
      const label =
        due.taxYearOffset !== undefined
          ? `${rule.name} — tax year ${calendarYear + due.taxYearOffset}`
          : rule.name;
      const date = `${calendarYear}-${pad(due.month)}-${pad(due.day)}`;
      return [{ seq: 1, label, dueDate: rollToBusinessDay(date, holidays) }];
    }
    case "multi_fixed": {
      // occurrences DUE in this calendar year: entries with yearOffset land
      // offset years after their nominal year (Q4 1040-ES: Jan 15 of Y+1)
      const out: Occurrence[] = [];
      let seq = 0;
      for (const [m, d, label, yearOffset] of due.dates) {
        seq++;
        const nominalYear = calendarYear; // items generated for the year they fall due
        void yearOffset; // offset entries still fall due at [m,d] of some year;
        // generating per due-year keeps every janitor query simple
        const date = `${nominalYear}-${pad(m)}-${pad(d)}`;
        out.push({
          seq,
          label: label !== undefined ? `${rule.name} — ${label}` : rule.name,
          dueDate: rollToBusinessDay(date, holidays),
        });
      }
      return out;
    }
    case "anniversary_month": {
      const diff = calendarYear - due.baseYear;
      if (diff < 0 || diff % due.everyNYears !== 0) return [];
      const date = `${calendarYear}-${pad(due.month)}-${pad(lastDayOfMonth(calendarYear, due.month))}`;
      return [{ seq: 1, label: rule.name, dueDate: rollToBusinessDay(date, holidays) }];
    }
    case "event":
      return []; // generated when the event exists (posted pay run — Phase 3)
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export type GenerateReport = { created: number; skipped: number; na: number };

/** Generate the year's items (idempotent). Conditional rules gate on app_config. */
export async function generateCalendar(db: Dbx, calendarYear: number): Promise<GenerateReport> {
  const holidays = await holidaySet(db, calendarYear);
  const rules = await db.select().from(calendarRules).where(eq(calendarRules.active, true));
  const config = new Map(
    (await db.select().from(appConfig)).map((c) => [c.key, c.value]),
  );
  const report: GenerateReport = { created: 0, skipped: 0, na: 0 };
  for (const rule of rules) {
    if (rule.appliesFromYear !== null && calendarYear < rule.appliesFromYear) continue;
    if (rule.appliesToYear !== null && calendarYear > rule.appliesToYear) continue;
    const conditionMet =
      rule.conditionKey === null || config.get(rule.conditionKey) === "1";
    const typedRule = rule as unknown as { name: string; due: DueSpec };
    for (const occ of occurrences(typedRule, calendarYear, holidays)) {
      const inserted = await db
        .insert(calendarItems)
        .values({
          ruleId: rule.id,
          calendarYear,
          seq: occ.seq,
          label: occ.label,
          dueDate: occ.dueDate,
          status: conditionMet ? "upcoming" : "na",
          note: conditionMet
            ? null
            : `condition '${rule.conditionKey}' not set — marked n/a (flip it in Settings to activate)`,
        })
        .onConflictDoNothing()
        .returning({ id: calendarItems.id });
      if (inserted.length === 0) report.skipped++;
      else if (conditionMet) report.created++;
      else report.na++;
    }
  }
  return report;
}

/** Filing confirmations attach to the item and mark it complete (§4.10). */
export async function completeCalendarItem(
  db: Dbx,
  itemId: bigint,
  args: { documentId?: bigint; note?: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const [item] = await tx
      .select()
      .from(calendarItems)
      .where(eq(calendarItems.id, itemId))
      .for("update");
    if (!item) throw new CalendarError(`calendar item ${itemId} not found`);
    if (item.status === "done") throw new CalendarError(`item ${itemId} is already done`);
    await tx
      .update(calendarItems)
      .set({
        status: "done",
        completedAt: new Date(),
        documentId: args.documentId ?? null,
        note: args.note ?? item.note,
      })
      .where(eq(calendarItems.id, itemId));
    if (args.documentId !== undefined) {
      await linkDocument(tx, args.documentId, "calendar_item", itemId);
    }
    await tx.insert(auditLog).values({
      actor: "owner",
      action: "complete_calendar_item",
      objectType: "calendar_item",
      objectId: itemId.toString(),
      detail: { label: item.label, documentId: args.documentId?.toString() ?? null },
    });
  });
}

export async function listCalendar(db: Dbx, calendarYear: number) {
  return await db
    .select({
      id: calendarItems.id,
      label: calendarItems.label,
      dueDate: calendarItems.dueDate,
      status: calendarItems.status,
      channel: calendarRules.channel,
      amountSource: calendarRules.amountSource,
      note: calendarItems.note,
      documentId: calendarItems.documentId,
    })
    .from(calendarItems)
    .innerJoin(calendarRules, eq(calendarRules.id, calendarItems.ruleId))
    .where(eq(calendarItems.calendarYear, calendarYear))
    .orderBy(asc(calendarItems.dueDate), asc(calendarItems.id));
}
