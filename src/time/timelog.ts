import { and, eq, gte, lte } from "drizzle-orm";
import type { Dbx } from "../db/client";
import { rateSources, taskTypes, timeEntries } from "../db/schema";
import type { Cents } from "../lib/cents";

export class TimeLogError extends Error {}

export async function addTimeEntry(
  db: Dbx,
  input: {
    entryDate: string;
    hours: string; // "2.50"
    taskTypeName: string;
    investeeId?: number;
    client?: string;
    note?: string;
    source?: "manual" | "ics";
  },
): Promise<bigint> {
  const h = Number(input.hours);
  if (!Number.isFinite(h) || h <= 0 || h > 24) {
    throw new TimeLogError(`hours must be in (0, 24], got ${input.hours}`);
  }
  const [tt] = await db.select().from(taskTypes).where(eq(taskTypes.name, input.taskTypeName));
  if (!tt) throw new TimeLogError(`unknown task type ${JSON.stringify(input.taskTypeName)}`);
  const [row] = await db
    .insert(timeEntries)
    .values({
      entryDate: input.entryDate,
      hours: input.hours,
      taskTypeId: tt.id,
      investeeId: input.investeeId ?? null,
      client: input.client ?? null,
      note: input.note ?? null,
      source: input.source ?? "manual",
    })
    .returning({ id: timeEntries.id });
  return row!.id;
}

export async function addRateSource(
  db: Dbx,
  input: {
    taskTypeName: string;
    hourlyRate: Cents;
    sourceKind: "job_posting" | "survey" | "other";
    citation: string;
    conversionNote?: string;
    capturedOn: string;
  },
): Promise<number> {
  if (input.citation.trim() === "") {
    throw new TimeLogError("a rate source requires a citation (§4.3)");
  }
  const [tt] = await db.select().from(taskTypes).where(eq(taskTypes.name, input.taskTypeName));
  if (!tt) throw new TimeLogError(`unknown task type ${JSON.stringify(input.taskTypeName)}`);
  const [row] = await db
    .insert(rateSources)
    .values({
      taskTypeId: tt.id,
      hourlyRate: input.hourlyRate,
      sourceKind: input.sourceKind,
      citation: input.citation,
      conversionNote: input.conversionNote ?? null,
      capturedOn: input.capturedOn,
    })
    .returning({ id: rateSources.id });
  return row!.id;
}

export async function listTimeEntries(db: Dbx, taxYear: number) {
  return await db
    .select({
      id: timeEntries.id,
      entryDate: timeEntries.entryDate,
      hours: timeEntries.hours,
      taskType: taskTypes.name,
      client: timeEntries.client,
      note: timeEntries.note,
      source: timeEntries.source,
    })
    .from(timeEntries)
    .innerJoin(taskTypes, eq(taskTypes.id, timeEntries.taskTypeId))
    .where(
      and(
        gte(timeEntries.entryDate, `${taxYear}-01-01`),
        lte(timeEntries.entryDate, `${taxYear}-12-31`),
      ),
    )
    .orderBy(timeEntries.entryDate, timeEntries.id);
}

export type IcsEvent = { date: string; hours: string; summary: string };

/**
 * Minimal ICS reader for calendar corroboration (§4.3): VEVENTs with
 * DTSTART/DTEND on the same day become {date, hours, summary} suggestions.
 * The owner still reviews before anything becomes a time entry.
 */
export function parseIcs(text: string): IcsEvent[] {
  // unfold RFC 5545 continuation lines
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const events: IcsEvent[] = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0]!;
    const dtstart = /DTSTART[^:]*:(\d{8}T\d{6})/.exec(body)?.[1];
    const dtend = /DTEND[^:]*:(\d{8}T\d{6})/.exec(body)?.[1];
    const summary = /SUMMARY:(.*)/.exec(body)?.[1]?.trim() ?? "";
    if (!dtstart || !dtend) continue;
    const date = `${dtstart.slice(0, 4)}-${dtstart.slice(4, 6)}-${dtstart.slice(6, 8)}`;
    if (dtend.slice(0, 8) !== dtstart.slice(0, 8)) continue; // multi-day: skip
    const toMinutes = (s: string) =>
      Number(s.slice(9, 11)) * 60 + Number(s.slice(11, 13));
    const minutes = toMinutes(dtend) - toMinutes(dtstart);
    if (minutes <= 0) continue;
    const hours = (Math.round((minutes / 60) * 100) / 100).toFixed(2);
    events.push({ date, hours, summary });
  }
  return events;
}
