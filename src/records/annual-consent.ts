/**
 * Annual written consent of the sole member (§4.9) — generated FROM LEDGER
 * DATA: the year's distributions (3200), the reasonable-comp computation
 * and its frozen methodology, the employer 401(k) contribution, the
 * accountable plan in force, the de minimis election, and the PTET
 * decision. Formalities are cheap to generate and expensive to reconstruct.
 */
import { desc, eq, sql as dsql } from "drizzle-orm";
import type { Dbx } from "../db/client";
import {
  accountablePlans,
  appConfig,
  compComputations,
  compMethodologies,
} from "../db/schema";
import type { Cents } from "../lib/cents";
import { formatCents } from "../lib/cents";
import { generateRecord, type GeneratedRecord } from "./templates";

export class AnnualConsentError extends Error {}

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export type AnnualConsentData = {
  taxYear: number;
  wage: Cents;
  methodologyVersion: number;
  methodologyFrozenAt: string | null;
  distributions: Cents;
  employer401k: Cents;
  planAdoptedOn: string;
  deMinimis: boolean;
  ptetElected: boolean;
};

export function renderAnnualConsent(
  args: { entityName: string; memberName: string; signedOn: string } & AnnualConsentData,
): string {
  const d = args;
  const body = `
<h1>Annual Written Consent of the Sole Member in Lieu of a Meeting</h1>
<p>The undersigned, being the sole member of <strong>${esc(d.entityName)}</strong> (the
“Company”), adopts the following resolutions for tax year ${d.taxYear}:</p>
<div class="recitals">
<h2>Reasonable compensation</h2>
<p><strong>RESOLVED</strong>, that officer compensation of <strong>$${formatCents(d.wage)}</strong>
for ${d.taxYear}, computed under methodology v${d.methodologyVersion}${
    d.methodologyFrozenAt !== null ? ` (frozen ${d.methodologyFrozenAt})` : ""
  } from contemporaneous time records and documented market rates, is adopted and ratified.</p>
<h2>Distributions</h2>
<p><strong>RESOLVED</strong>, that the distributions to the member during ${d.taxYear},
totaling <strong>$${formatCents(d.distributions)}</strong> per the Company's ledger (account
3200), are approved and ratified.</p>
<h2>Employer 401(k) contribution</h2>
<p><strong>RESOLVED</strong>, that the employer contribution of
<strong>$${formatCents(d.employer401k)}</strong> to the Company's solo 401(k) plan for
${d.taxYear}, within the computed statutory limits, is ratified; it shall be deposited no later
than the Company's return due date including extensions.</p>
<h2>Accountable plan</h2>
<p><strong>RESOLVED</strong>, that the accountable plan adopted ${d.planAdoptedOn} remained in
force throughout ${d.taxYear}, and the reimbursements made under it, each substantiated and
documented, are ratified.</p>
${
  d.deMinimis
    ? `<h2>De minimis safe harbor</h2><p><strong>RESOLVED</strong>, that the Company's application
of the de minimis safe harbor of Treas. Reg. §1.263(a)-1(f) for ${d.taxYear} is ratified, with
the election statement to be attached to its timely filed return.</p>`
    : ""
}
<h2>Pass-through entity tax</h2>
<p><strong>RESOLVED</strong>, that the Company's decision ${
    d.ptetElected ? "TO MAKE" : "NOT to make"
  } the New York State pass-through entity tax election for ${d.taxYear} is ratified.</p>
</div>
<div class="sig">
  <div class="line">${esc(d.memberName)}, Sole Member — ${d.signedOn}</div>
</div>`;
  // reuse the standard page chrome via generateRecord's caller (templates.ts CSS)
  return body;
}

export async function collectAnnualConsentData(db: Dbx, taxYear: number): Promise<AnnualConsentData> {
  const [comp] = await db
    .select()
    .from(compComputations)
    .where(eq(compComputations.taxYear, taxYear))
    .orderBy(desc(compComputations.id))
    .limit(1);
  if (!comp) {
    throw new AnnualConsentError(
      `no reasonable-comp computation for ${taxYear} — compute it (Time & comp) before the annual consent`,
    );
  }
  const [methodology] = await db
    .select()
    .from(compMethodologies)
    .where(eq(compMethodologies.id, comp.methodologyId));
  const dist = await db.execute<{ v: bigint | null }>(dsql`
    SELECT (COALESCE(sum(l.debit),0)-COALESCE(sum(l.credit),0))::bigint AS v
    FROM journal_lines l JOIN accounts a ON a.id=l.account_id
    JOIN journal_entries e ON e.id=l.entry_id
    WHERE a.code='3200' AND e.source_module <> 'close'
      AND e.entry_date BETWEEN ${`${taxYear}-01-01`} AND ${`${taxYear}-12-31`}
  `);
  const er401k = await db.execute<{ v: bigint | null }>(dsql`
    SELECT (COALESCE(sum(l.debit),0)-COALESCE(sum(l.credit),0))::bigint AS v
    FROM journal_lines l JOIN accounts a ON a.id=l.account_id
    JOIN journal_entries e ON e.id=l.entry_id
    WHERE a.code='5020'
      AND e.entry_date BETWEEN ${`${taxYear}-01-01`} AND ${`${taxYear}-12-31`}
  `);
  const [plan] = await db
    .select()
    .from(accountablePlans)
    .where(eq(accountablePlans.active, true))
    .orderBy(desc(accountablePlans.id))
    .limit(1);
  if (!plan) {
    throw new AnnualConsentError(
      "no active accountable plan on file — generate and adopt the policy (Corporate records) first",
    );
  }
  const config = new Map((await db.select().from(appConfig)).map((c) => [c.key, c.value]));
  return {
    taxYear,
    wage: comp.total,
    methodologyVersion: methodology!.version,
    methodologyFrozenAt: methodology!.frozenAt?.toISOString().slice(0, 10) ?? null,
    distributions: dist.rows[0]?.v ?? 0n,
    employer401k: er401k.rows[0]?.v ?? 0n,
    planAdoptedOn: plan.adoptedOn,
    deMinimis: config.get("de_minimis_election") !== "0",
    ptetElected: config.get("ptet_elected") === "1",
  };
}

export async function generateAnnualConsent(
  db: Dbx,
  args: { taxYear: number; entityName: string; memberName: string; signedOn: string },
): Promise<GeneratedRecord & { data: AnnualConsentData }> {
  const data = await collectAnnualConsentData(db, args.taxYear);
  const body = renderAnnualConsent({ ...args, ...data });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Annual consent ${args.taxYear}</title>
<style>body{font:13px/1.55 Georgia,serif;max-width:46rem;margin:3rem auto;padding:0 1.5rem}
h1{font-size:19px;text-transform:uppercase;text-align:center}h2{font-size:14px;margin-top:1.6em}
.sig .line{border-top:1px solid #111;width:20rem;margin-top:3rem;padding-top:.3rem}
.note{font-size:11px;color:#555;margin-top:2.5rem;border-top:1px solid #ccc;padding-top:.6rem}</style>
</head><body>${body}
<p class="note">Generated from the Company's ledger and records. Internal corporate record —
review with counsel/CPA; not an official government form; not legal or tax advice.</p>
</body></html>`;
  const record = await generateRecord(db, {
    kind: "annual_consent",
    taxYear: args.taxYear,
    title: `Annual consent ${args.taxYear}`,
    html,
    data: { ...data, wage: data.wage.toString(), distributions: data.distributions.toString(), employer401k: data.employer401k.toString() },
  });
  return { ...record, data };
}
