/**
 * Pay stub for the one annual §4.4 run: rebuilt entirely from the persisted
 * payroll_runs row (the same numbers the ledger entry and the 941/W-2
 * worksheets carry), with the net-pay identity RE-PROVED before anything
 * renders — a stub that doesn't tie to its own run refuses to exist.
 * Stored via the records pipeline (PDF when Chromium is available, HTML
 * otherwise) and linked to the run in the vault. A worksheet, not a form
 * (guardrail 2): W-2 Box 1/14 treatment of the 2% health premium is stated
 * on the stub itself.
 */
import { eq } from "drizzle-orm";
import type { Dbx } from "../db/client";
import { appConfig, auditLog, payrollRuns, type PayrollRun } from "../db/schema";
import type { Cents } from "../lib/cents";
import { formatCents } from "../lib/cents";
import { htmlToPdf } from "../records/pdf";
import { linkDocument, storeDocument } from "../vault/store";

export class PayStubError extends Error {}

export type PayStub = {
  runId: bigint;
  taxYear: number;
  payDate: string;
  employer: string;
  employee: string;
  earnings: Array<{ label: string; amount: Cents }>;
  preTax: Array<{ label: string; amount: Cents }>;
  taxes: Array<{ label: string; amount: Cents }>;
  netPay: Cents;
  employerSide: Array<{ label: string; amount: Cents }>;
  memo: string[];
  tableVersionIds: Record<string, number>;
};

/** gross − 401(k) deferral − employee taxes/withholding = net, to the cent. */
export function netPayIdentity(r: PayrollRun): { computed: Cents; stored: Cents; holds: boolean } {
  const employeeSide =
    r.eeDeferral401k +
    r.eeSocialSecurity +
    r.eeMedicare +
    r.eeAddlMedicare +
    r.fitWithheld +
    r.nysWithheld +
    r.nycWithheld;
  const computed = r.grossWages - employeeSide;
  return { computed, stored: r.netPay, holds: computed === r.netPay };
}

export async function buildPayStub(db: Dbx, runId: bigint): Promise<PayStub> {
  const [run] = await db.select().from(payrollRuns).where(eq(payrollRuns.id, runId));
  if (!run) throw new PayStubError(`payroll run ${runId} not found`);
  if (run.status !== "posted") {
    throw new PayStubError(`payroll run ${runId} is ${run.status} — stubs come only from posted runs`);
  }
  const identity = netPayIdentity(run);
  if (!identity.holds) {
    throw new PayStubError(
      `run ${runId} does not tie: gross − deductions = ${formatCents(identity.computed)} ` +
        `but stored net is ${formatCents(identity.stored)} — investigate before issuing a stub`,
    );
  }
  const config = new Map((await db.select().from(appConfig)).map((c) => [c.key, c.value]));
  const stub: PayStub = {
    runId,
    taxYear: run.taxYear,
    payDate: run.payDate,
    employer: config.get("entity_name") ?? "(set entity_name in Settings)",
    employee: config.get("owner_name") ?? "Owner-employee",
    earnings: [{ label: `Officer compensation (annual run, ${run.grossSource})`, amount: run.grossWages }],
    preTax: run.eeDeferral401k > 0n ? [{ label: "401(k) employee deferral", amount: run.eeDeferral401k }] : [],
    taxes: [
      { label: "Social Security (employee)", amount: run.eeSocialSecurity },
      { label: "Medicare (employee)", amount: run.eeMedicare },
      ...(run.eeAddlMedicare > 0n
        ? [{ label: "Additional Medicare (0.9% over threshold)", amount: run.eeAddlMedicare }]
        : []),
      { label: "Federal income tax withheld", amount: run.fitWithheld },
      { label: "NY State income tax withheld", amount: run.nysWithheld },
      { label: "NYC income tax withheld", amount: run.nycWithheld },
    ],
    netPay: run.netPay,
    employerSide: [
      { label: "Social Security (employer)", amount: run.erSocialSecurity },
      { label: "Medicare (employer)", amount: run.erMedicare },
      { label: "FUTA", amount: run.erFuta },
      { label: "NYS SUI", amount: run.erSui },
      ...(run.er401k > 0n ? [{ label: "401(k) employer contribution", amount: run.er401k }] : []),
      ...(run.healthPremium > 0n
        ? [{ label: "2% shareholder health premium (see memo)", amount: run.healthPremium }]
        : []),
    ],
    memo: [
      "One annual payroll run (§4.4); year-to-date equals this stub.",
      ...(run.healthPremium > 0n
        ? [
            `The ${formatCents(run.healthPremium)} health premium is W-2 Box 1 and Box 14 income ` +
              "(never Boxes 3/5), paid by the company — it is not a cash deduction from this check.",
          ]
        : []),
      "Worksheet generated from the posted run — not an official form.",
    ],
    tableVersionIds: run.tableVersionIds,
  };
  return stub;
}

const CSS = `
  body { font: 13px/1.5 "Helvetica Neue", Arial, sans-serif; color: #111;
         max-width: 44rem; margin: 2.5rem auto; padding: 0 1.5rem; }
  h1 { font-size: 17px; margin-bottom: .1em; }
  .sub { color: #555; margin-top: 0; }
  table { width: 100%; border-collapse: collapse; margin: 1em 0; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
       color: #555; border-bottom: 1px solid #999; padding: .3em 0; }
  td { padding: .35em 0; border-bottom: 1px solid #eee; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.total td { border-top: 2px solid #111; border-bottom: none; font-weight: 700; }
  .note { font-size: 11px; color: #555; margin-top: 2rem; border-top: 1px solid #ccc; padding-top: .6rem; }
`;

function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function rows(items: Array<{ label: string; amount: Cents }>): string {
  return items
    .map((i) => `<tr><td>${esc(i.label)}</td><td class="num">${formatCents(i.amount)}</td></tr>`)
    .join("");
}

export function renderPayStubHtml(s: PayStub): string {
  const totalTaxes = s.taxes.reduce((a, t) => a + t.amount, 0n);
  const totalPreTax = s.preTax.reduce((a, t) => a + t.amount, 0n);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Pay stub ${s.taxYear}</title>
<style>${CSS}</style></head><body>
<h1>Pay stub — tax year ${s.taxYear}</h1>
<p class="sub">${esc(s.employer)} → ${esc(s.employee)} · pay date ${s.payDate} · run #${s.runId}</p>
<table><thead><tr><th>Earnings</th><th></th></tr></thead><tbody>${rows(s.earnings)}</tbody></table>
${s.preTax.length > 0 ? `<table><thead><tr><th>Pre-tax deductions</th><th></th></tr></thead><tbody>${rows(s.preTax)}<tr class="total"><td>Total pre-tax</td><td class="num">${formatCents(totalPreTax)}</td></tr></tbody></table>` : ""}
<table><thead><tr><th>Employee taxes &amp; withholding</th><th></th></tr></thead><tbody>${rows(s.taxes)}
<tr class="total"><td>Total taxes withheld</td><td class="num">${formatCents(totalTaxes)}</td></tr></tbody></table>
<table><tbody><tr class="total"><td>NET PAY</td><td class="num">${formatCents(s.netPay)}</td></tr></tbody></table>
<table><thead><tr><th>Employer-paid (informational, not deducted from pay)</th><th></th></tr></thead>
<tbody>${rows(s.employerSide)}</tbody></table>
${s.memo.map((m) => `<p class="note">${esc(m)}</p>`).join("")}
<p class="note">Tax tables used (verified versions): ${esc(
    Object.entries(s.tableVersionIds)
      .map(([k, v]) => `${k}#${v}`)
      .join(", "),
  )}</p>
</body></html>`;
}

/** Render, vault (PDF when Chromium is available), link to the run. */
export async function generatePayStub(
  db: Dbx,
  runId: bigint,
): Promise<{ documentId: bigint; mime: string }> {
  const stub = await buildPayStub(db, runId);
  const html = renderPayStubHtml(stub);
  const rendered = htmlToPdf(html);
  const ext = rendered.mime === "application/pdf" ? "pdf" : "html";
  const { document } = await storeDocument(db, {
    filename: `paystub-${stub.taxYear}-run${runId}.${ext}`,
    mime: rendered.mime,
    bytes: rendered.bytes,
    source: "generated",
    year: stub.taxYear,
  });
  await linkDocument(db, document.id, "payroll_run", runId);
  await db.insert(auditLog).values({
    actor: "owner",
    action: "generate_paystub",
    objectType: "payroll_run",
    objectId: runId.toString(),
    detail: { documentId: document.id.toString(), mime: rendered.mime },
  });
  return { documentId: document.id, mime: rendered.mime };
}
