import { eq, like } from "drizzle-orm";
import type { Dbx } from "../db/client";
import { accounts, auditLog, investees, type Investee } from "../db/schema";
import { type Cents, ZERO } from "../lib/cents";

export class InvesteeError extends Error {}

export type NewInvestee = {
  name: string;
  ein?: string;
  /** 's_corporation' is accepted at the type level so forms can submit it —
   *  and rejected with the §4.5 explanation. */
  entityType: "partnership" | "c_corporation" | "s_corporation";
  ownershipPct: string; // numeric as string, e.g. "50" or "50.0000"
  acquiredOn: string; // YYYY-MM-DD
  initialContribution?: Cents;
  counterpartyRegex?: string;
};

/**
 * Creates the investee AND its per-investee 15xx investment account in one
 * transaction (codes 1500, 1510, 1520, …).
 */
export async function createInvestee(
  db: Dbx,
  input: NewInvestee,
): Promise<{ investee: Investee; accountCode: string }> {
  if (input.entityType === "s_corporation") {
    throw new InvesteeError(
      "This LLC cannot hold S-corporation stock: an S-corp shareholder must be an " +
        "individual, estate, or certain trust — an LLC investor would terminate the " +
        "investee's S election the day the investment closes (brief §4.5). " +
        "Partnerships/LLCs taxed as partnerships and C-corp stock are fine.",
    );
  }
  const pct = Number(input.ownershipPct);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
    throw new InvesteeError(`ownership percentage must be in (0, 100], got ${input.ownershipPct}`);
  }
  if (input.counterpartyRegex !== undefined) {
    try {
      new RegExp(input.counterpartyRegex, "i");
    } catch {
      throw new InvesteeError(`invalid counterparty regex: ${input.counterpartyRegex}`);
    }
  }
  const entityType = input.entityType; // narrowed: s_corporation threw above
  return await db.transaction(async (tx) => {
    const [investee] = await tx
      .insert(investees)
      .values({
        name: input.name,
        ein: input.ein ?? null,
        entityType,
        ownershipPct: input.ownershipPct,
        acquiredOn: input.acquiredOn,
        initialContribution: input.initialContribution ?? ZERO,
        counterpartyRegex: input.counterpartyRegex ?? null,
      })
      .returning();
    const existing = await tx
      .select({ code: accounts.code })
      .from(accounts)
      .where(like(accounts.code, "15%"));
    const maxCode = existing
      .map((r) => Number(r.code))
      .filter((n) => Number.isInteger(n) && n >= 1500 && n < 1600)
      .reduce((a, b) => Math.max(a, b), 1490);
    const code = String(maxCode + 10);
    if (Number(code) >= 1600) throw new InvesteeError("15xx account range exhausted");
    await tx.insert(accounts).values({
      code,
      name: `Investment in ${input.name}`,
      type: "asset",
      taxTreatment: "not_tax",
      form1120sLine: "L.8",
      investeeId: investee!.id,
    });
    await tx.insert(auditLog).values({
      actor: "owner",
      action: "create_investee",
      objectType: "investee",
      objectId: String(investee!.id),
      detail: { name: input.name, entityType: input.entityType, accountCode: code },
    });
    return { investee: investee!, accountCode: code };
  });
}

export async function getInvestee(db: Dbx, id: number): Promise<Investee | undefined> {
  const rows = await db.select().from(investees).where(eq(investees.id, id));
  return rows[0];
}

export async function listInvestees(db: Dbx): Promise<Investee[]> {
  return await db.select().from(investees);
}

/** The ledger account holding this investee's carrying value. */
export async function investeeAccountCode(db: Dbx, investeeId: number): Promise<string> {
  const rows = await db
    .select({ code: accounts.code })
    .from(accounts)
    .where(eq(accounts.investeeId, investeeId));
  const code = rows[0]?.code;
  if (code === undefined) throw new InvesteeError(`investee ${investeeId} has no 15xx account`);
  return code;
}
