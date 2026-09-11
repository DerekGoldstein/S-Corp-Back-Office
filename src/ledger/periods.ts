import { and, eq, sql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import { auditLog, periods } from "../db/schema";

/** Lock a month: no new entries may be dated inside it (DB-enforced). */
export async function lockPeriod(db: Dbx, taxYear: number, month: number): Promise<void> {
  await db
    .insert(periods)
    .values({ taxYear, month, locked: true, lockedAt: new Date() })
    .onConflictDoUpdate({
      target: [periods.taxYear, periods.month],
      set: { locked: true, lockedAt: new Date() },
    });
  await db.insert(auditLog).values({
    actor: "owner",
    action: "lock_period",
    objectType: "period",
    objectId: `${taxYear}-${month}`,
    detail: null,
  });
}

/** Unlocking goes through the SQL function so the reason is always audited. */
export async function unlockPeriod(
  db: Dbx,
  taxYear: number,
  month: number,
  reason: string,
): Promise<void> {
  await db.execute(
    sql`SELECT unlock_period(${taxYear}::smallint, ${month}::smallint, ${reason})`,
  );
}

export async function isPeriodLocked(db: Dbx, taxYear: number, month: number): Promise<boolean> {
  const rows = await db
    .select({ locked: periods.locked })
    .from(periods)
    .where(and(eq(periods.taxYear, taxYear), eq(periods.month, month)));
  return rows[0]?.locked ?? false;
}

export async function listPeriods(db: Dbx, taxYear?: number) {
  const q = db.select().from(periods);
  const rows = taxYear === undefined ? await q : await q.where(eq(periods.taxYear, taxYear));
  return rows.sort((a, b) => a.taxYear - b.taxYear || a.month - b.month);
}
