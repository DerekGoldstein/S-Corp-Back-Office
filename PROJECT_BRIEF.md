# Project brief: S-corp back office (working name)

## 0. How to use this document

This is the opening prompt for Claude Code. Save it as `PROJECT_BRIEF.md` in an empty repo and open Claude Code in that directory.

**Claude Code: read this entire file first. Then, before writing any application code:**

1. Ask the open questions in §9.
2. Propose the data model (ERD), the chart of accounts with tax mappings, the journal-entry invariants, the bank-ingestion flow, and a Phase 1 task list.
3. Wait for approval of the model. Then generate a `CLAUDE.md` from this brief that captures the guardrails in §8 as standing rules for the repo.

---

## 1. Context

- **Entity:** a single-member New York LLC with an S-corporation election effective 1/1/2027. Calendar tax year. Cash-basis books.
- **Location:** New York City. NYC does not recognize S status, so the entity owes NYC General Corporation Tax (GCT) in addition to NYS and federal pass-through treatment.
- **People:** one shareholder-employee (the owner), who is also the only user of this app. No other employees. Contractors are not expected (support 1099-NEC as a low-priority optional).
- **Income streams:**
  1. Consulting revenue billed by the LLC.
  2. Pass-through income from partnership/LLC investments held by the LLC (currently a 50% interest in a factoring LLC; more investees are possible). These arrive as Schedule K-1 (Form 1065) each spring.
- **Payroll:** one annual pay run in December. Design for N runs per year, but the December run is the real one.
- **Retirement:** solo 401(k) under the LLC. The employee deferral comes out of the December check; the employer contribution is made by the return due date.
- **Health insurance:** if the entity pays or reimburses the owner's premiums, the 2%-shareholder rules apply (see §4.4). Owner confirms the arrangement in §9.
- **Owner reimbursements:** home office, phone, internet, and similar are reimbursed under a written accountable plan (§4.8), not deducted personally.
- **What this replaces:** ZipBooks (bookkeeping), a third-party payroll service, and most CPA preparation time. The actual returns are e-filed through a low-cost commercial product (or by the CPA) *from the workpapers this app produces*. **This app never renders or files official IRS/NYS/NYC forms.**
- **The operating goal is low touch.** The CPA's role is a quick annual sign-off, not preparation. Every year-end output must arrive pre-tied-out (§4.11) so the CPA reviews rather than reconciles. Anything that would otherwise be a recurring manual chore (reimbursement math, 401(k) limits, board consents, document retention) is an app output.
- **Owner profile:** finance professional; has built an in-house accounting app before. Optimize for correctness, auditability, and low annual maintenance over polish.

---

## 2. Architecture principle: the ledger is the hub

- A double-entry general ledger is the single source of truth. Every module either posts to it or reads from it. No module keeps parallel totals.
- The journal is **append-only**. Corrections are reversing entries. Periods can be locked; locked periods reject new entries dated inside them.
- Money is stored as integer cents (or `NUMERIC(15,2)`), never floating point. Tax computations use a decimal library with explicit, documented rounding at each step (IRS forms round to whole dollars; the ledger keeps cents).
- Every number that will land on a return must be reproducible: store the inputs, the tax-table version used, and a computation trace.
- Book = tax wherever possible (cash basis, tax depreciation) so Schedule M-1 stays nearly empty.

---

## 3. Recommended stack (owner may override — see §9)

- TypeScript end to end.
- Postgres (local instance or a small managed one). SQLite is acceptable if the app stays single-file/local; Postgres preferred for `NUMERIC`, views, and constraints.
- Drizzle (or Prisma) for schema/migrations. Next.js for the UI: server components for reports, a handful of interactive screens (classification queue, K-1 review, payroll run).
- Minimal background jobs: a Plaid sync cron and nightly backup. No queue infrastructure.
- Tests: Vitest. The tax engine and ledger invariants must have golden tests (see §4.4, §6).
- Secrets in `.env`, never committed. Plaid access tokens and the owner's SSN encrypted at rest.

---

## 4. Modules

### 4.1 General ledger

**Tables:** `accounts`, `journal_entries` (header: date, memo, source module, source id, period), `journal_lines` (entry id, account id, debit, credit, dimensions).

**Invariants (enforce in the database, not just the app):**
- Sum of debits = sum of credits for every entry.
- Entries are immutable after posting. Reversal = a new entry referencing the original.
- No entries dated inside a locked period.

**Dimensions on every line** (nullable): `investee_id`, `payroll_run_id`, `k1_id`, `bank_transaction_id`, `tax_year`. Downstream modules query by dimension rather than re-classifying.

**Account attributes:** each account carries
- `tax_treatment`: `deductible`, `deductible_50pct` (meals), `nondeductible`, `separately_stated`, `not_tax` (balance sheet / equity).
- `form_1120s_line` and/or `schedule_k_line`: where the balance lands on the 1120-S. This mapping is what makes §4.6 a set of queries.

**Starting chart of accounts** (Claude Code: refine, don't bloat):

| # | Account | Notes |
|---|---|---|
| 1000 | Operating checking | |
| 1010 | Payroll / tax reserve | optional second account |
| 1500-15xx | Investment in [investee] | one per investee; ledger carrying value, outside basis tracked separately in §4.5 |
| 1600 | Fixed assets (above de minimis) | register in §4.8; items at or under the de minimis safe harbor are expensed |
| 1610 | Accumulated depreciation | |
| 2100 | Federal income tax withheld payable | |
| 2110 | Social Security payable (EE + ER) | |
| 2120 | Medicare payable (EE + ER, incl. Additional Medicare) | |
| 2130 | NYS withholding payable | |
| 2140 | NYC withholding payable | |
| 2150 | FUTA payable | |
| 2160 | NY SUI payable | |
| 2170 | 401(k) employee deferral payable | |
| 2180 | 401(k) employer contribution payable | |
| 2190 | Accountable-plan reimbursements payable | approved §4.8 submissions not yet paid |
| 2200 | Accrued NYC GCT | |
| 2210 | Accrued NYS franchise tax / PTET | |
| 3000 | Shareholder paid-in capital | |
| 3100 | AAA (accumulated adjustments account) | |
| 3110 | OAA (other adjustments account) | tax-exempt income, related nondeductibles |
| 3200 | Shareholder distributions | contra-equity, closed to AAA at year end |
| 3900 | Current-year net income | |
| 4000 | Consulting revenue | Schedule K line 1 via page 1 |
| 4500 | Investee ordinary income (K-1 box 1) | Schedule K line 1 (via page 1 income from partnerships) |
| 4510-45xx | Investee separately stated items | one account per K-1 box/code that must stay separately stated: interest, dividends, capital gains, §1231, §179, charitable, etc. |
| 5000 | Officer compensation | Form 1120-S line 7 |
| 5010 | Employer payroll taxes | line 12 |
| 5020 | Employer 401(k) contribution | line 17 |
| 5030 | Shareholder health insurance (2% shareholder) | included in officer comp on line 7 via W-2 Box 1; see §4.4 |
| 5040 | Accountable-plan reimbursements | by category (home office, phone, internet, supplies); each maps to its 1120-S line |
| 5050 | Depreciation / de minimis expense | line 14 for depreciation; de minimis items as ordinary expense |
| 5100-51xx | Operating expenses | software, professional fees, bank fees, meals (50%) |
| 5200 | Entity-level state/local taxes (GCT, NYS fixed dollar minimum, PTET) | line 12 |
| 5900 | Nondeductible (penalties, disallowed 50% of meals) | M-1 / M-2 nondeductible |

**Reports:** trial balance, P&L, balance sheet, GL detail, account register, all as of any date. Year-end close routine: net income → AAA, distributions → AAA, nondeductibles → AAA (or OAA per rules).

### 4.2 Bank ingestion and classification

- **Sources:** (a) CSV/OFX import — build this first, it is the fallback the ledger can always rely on; (b) Plaid Link + `/transactions/sync` (cursor-based) + balance. Both feed the same `bank_transactions` table.
- `bank_transactions` is immutable raw data. Dedupe by Plaid `transaction_id` or, for imports, a hash of (account, date, amount, normalized description).
- **Classification** = creating a journal entry from a bank transaction. States: `unreviewed` → `proposed` (rule-suggested) → `posted`. Nothing posts without the owner clicking confirm, except transactions matched by a rule the owner has explicitly flagged `auto_post`.
- **Rules engine:** match on description regex + amount range + account → target account, memo template, dimensions. After the owner classifies two similar transactions by hand, suggest a rule.
- **Transfers** between the entity's own accounts are matched pairwise and posted as transfers, never income/expense.
- **Special patterns the classifier must recognize and force into the right account:**
  - Incoming wire from an investee → credit `Investment in [investee]` (a distribution reduces the asset). **Never revenue.** Income is recognized only from the K-1 (§4.5).
  - Outgoing payment to the owner → must be tagged as one of: payroll net pay, shareholder distribution, accountable-plan reimbursement. Refuse to post untagged.
  - EFTPS / NYS Online Services / SUI debits → clear the specific payroll liability account. Never expense.
  - 401(k) provider debits → clear 2170/2180.
- **Reconciliation:** monthly, compare ledger cash to the statement (Plaid balance or a typed-in closing balance) and list unmatched items.
- **Plaid practicalities:** apply for production access at the start of Phase 1; approval and the security questionnaire take time. Store the Item's access token encrypted. Budget for usage-based pricing on one to three Items.

### 4.3 Time log and reasonable compensation

This module produces the wage figure for the December payroll and the evidence pack behind it. The methodology must be frozen and versioned **before 1/1/2027**.

- **Time entries:** date, hours, task type (e.g., credit underwriting, deal review, deal sourcing, consulting delivery, admin/compliance), optional investee or client, note. Optional ICS calendar import to corroborate.
- **Rate table:** hourly market rate per task type, each with a source (job posting, survey), the salary-to-hourly conversion assumption (standard work-week), and the date captured. Multiple sources per task type.
- **Corroboration inputs:** deal counts / volume by period, entered manually or derived from investee data, to reconcile against logged hours.
- **Output:** annual reasonable-compensation computation = Σ (hours by task type × rate by task type), plus an exportable comp-memo data pack (hours by type, rates and sources, corroboration, methodology version and freeze date). This is the default `gross_wages` input to §4.4. "Part-time" is a result of the log, not an input.

### 4.4 Payroll

**Setup records:** one employee (the owner); Form W-4 (2020+ redesign fields: filing status, Step 2 checkbox, Steps 3/4 amounts, extra withholding); NY Form IT-2104 elections (NYS + NYC); 401(k) deferral election with its effective date (must predate the pay date); pay frequency (default annual); health-insurance arrangement (entity-paid, owner-paid and reimbursed, or none) with the year's premium total.

**2%-shareholder health insurance (must be handled correctly or the deduction is lost):**
- Premiums the entity pays or reimburses for the owner are added to W-2 Box 1 wages and reported in Box 14. They are **excluded** from Social Security, Medicare, and FUTA wages (NY UI treatment: confirm once with NYS DOL; store as configuration).
- The entity deducts them as officer compensation (5030 → line 7). The owner then takes the self-employed health insurance deduction on the 1040. The projection in §4.7 must include this deduction.
- The policy must be in the entity's name, or in the owner's name with the entity paying or reimbursing the premiums. Reimbursements are posted through §4.8 with the premium notices attached.

**Solo 401(k) limit computation (from per-year tables):** employee elective deferral cap (plus catch-up if age-eligible); employer contribution cap = 25% of W-2 compensation (Box 1 wages *before* the deferral reduction, per the plan document — Claude Code: read the plan's definition of compensation and make it a configuration choice); overall annual additions limit. Because wages are set once, compute the maximum employer contribution the December wage supports, the deadline (return due date including extensions), and warn if the owner's target exceeds the cap.

**Tax tables are versioned data files per tax year (JSON), never constants in code.** Each file records its source URL and effective dates. The app must refuse to run payroll for a year whose tables are not loaded and marked `verified_by_owner`. Required per year:
- Social Security rate and wage base; Medicare rate; Additional Medicare 0.9% threshold ($200,000 of wages, no filing-status adjustment at the employer level).
- IRS Pub 15-T percentage-method tables (annual pay period) and the W-4 handling rules.
- NYS-50-T-NYS and NYS-50-T-NYC withholding tables/methods.
- FUTA rate, wage base ($7,000), and the current-year credit-reduction status for New York (NY has been a credit-reduction state in recent years; check annually).
- NY SUI wage base for the year and the employer's assigned contribution rate (from the NYS DOL rate notice), plus the re-employment service fund rate.

**Pay-run computation, in order:**
1. Gross wages (default from §4.3; owner can override, override is logged).
2. Add 2%-shareholder health insurance premiums to income-tax wages only (Box 1, Box 14). Maintain separate wage bases from here on: `fit_wages`, `nys_wages`, `nyc_wages`, `fica_wages`, `futa_wages`, `sui_wages`. Every later step names which base it uses.
3. Pre-tax deductions: 401(k) elective deferral. Reduces federal, NYS, and NYC income-tax wages. Does **not** reduce Social Security, Medicare, FUTA, or SUI wages.
4. Employee Social Security (to wage base), Medicare, Additional Medicare over the threshold — on `fica_wages`.
5. Federal income tax withholding per Pub 15-T (annual period) on `fit_wages`, honoring the W-4 and adding the **additional withholding override** from §4.7 (this is where the "over-withhold to cover K-1 income" amount goes).
6. NYS and NYC withholding on `nys_wages` / `nyc_wages`.
7. Net pay (health-insurance amounts are non-cash if the entity paid the insurer directly; if the owner paid, the reimbursement flows through §4.8, not net pay).
8. Employer side: Social Security, Medicare, FUTA, NY SUI, employer 401(k) contribution (capped per the limit computation above).

**Outputs of a posted run:**
- Pay stub (PDF).
- Auto-posted journal entry: debit 5000 officer comp, 5010 employer taxes, 5020 employer 401(k), 5030 shareholder health insurance (if not already expensed through §4.8 during the year — never double-count); credit each liability (2100–2180) and cash for net pay. Lines carry `payroll_run_id`.
- **Deposit schedule** with amounts and due dates:
  - EFTPS (federal): FIT withheld + employee and employer Social Security and Medicare. New employers default to **monthly depositor** (due the 15th of the following month). If accumulated liability reaches **$100,000 on any day, the deposit is due the next business day** — check this against the December run; a large single check can trigger it.
  - NYS-1 (NYS + NYC withholding): due within **5 business days** after the pay date once withheld tax reaches **$700** (3 business days if prior-year withholding was $15,000 or more).
  - NY SUI: paid with the quarterly NYS-45.
  - FUTA: deposit quarterly only if cumulative liability exceeds $500; otherwise pay with Form 940.
  - When the corresponding bank debit arrives, §4.2 clears the liability.
- **Form worksheets** — line-by-line numbers with the form's own line numbers, for keying into the IRS paper/e-file product, SSA Business Services Online, and NY Online Services. No form rendering.
  - Form 941 for the quarter with wages (Q4). Flag the **seasonal-employer checkbox** so zero-wage quarters need no return.
  - Form 940 (annual FUTA), including credit-reduction computation if applicable.
  - W-2 / W-3: Box 1 includes health insurance; Box 3/5 exclude it; box 12 code D for the 401(k) deferral; box 13 retirement-plan checked; Box 14 "S-corp health" with the premium amount; NYS/NYC local boxes.
  - NYS-1 and NYS-45 (all four quarters — zero-wage quarters still file) with NYS-45-ATT wage detail.
  - NY new-hire report: due within 20 days of the owner's first pay date as an employee (calendar item, §5).
  - Warnings: MCTMT employer threshold check; NY DBL/PFL, workers' compensation, and UI coverage applicability for an LLC member paid W-2 wages (owner to confirm with NYS DOL / WCB once; store the answers as configuration).

**Golden tests:** a fixture December payroll computed by hand from the Pub 15-T worksheet and the NYS/NYC tables, plus a cross-check against an independent paycheck calculator's output, stored as expected values. Tests must fail loudly if a table file changes without the fixture being re-verified.

### 4.5 K-1 ingestion and investee tracking

- **Investee record:** name, EIN, entity type, ownership %, acquisition date, initial contribution, ledger account id. **Hard error if entity type is S-corporation** — this LLC cannot be an S-corp shareholder; an investment would terminate the investee's election. Partnerships/LLCs taxed as partnerships and C-corp stock are fine.
- **Upload:** Schedule K-1 (Form 1065) PDF → extraction via the Anthropic API with the PDF as a document input and a strict JSON schema covering every field in Parts I–III, including the coded sub-items for boxes 11, 13, 15, 17, 18, and 20 and the Part II capital-account analysis (item L, tax-basis method) and items J–N. Return a confidence flag per field. (Claude Code: check docs.claude.com at build time for the current model ID and document-input format; keep the model ID in config, not code.)
- **Review screen:** PDF side by side with extracted values; owner confirms or edits every field. Low-confidence fields are highlighted and block confirmation until touched. Nothing posts before confirmation.
- **Posting on confirm** (lines carry `investee_id`, `k1_id`, `tax_year`):
  - Box 1 ordinary income → debit Investment asset, credit 4500.
  - Interest, dividends, capital gains, §1231, §179, charitable, and other separately stated items → their own 45xx accounts, so character is preserved through to the 1120-S.
  - Nondeductible items and tax-exempt income → OAA-path accounts.
  - Box 19 distributions → reconcile against the investee wires already classified in §4.2; report any difference.
- **Outside basis roll-forward per investee per year:** beginning basis + contributions + income items + tax-exempt income − distributions − losses/deductions − nondeductibles = ending basis. Flag when losses would take basis below zero (suspended-loss tracking). Store the K-1's reported capital account separately; do not conflate it with outside basis.
- **1120-S mapping table:** K-1 (1065) box/code → 1120-S Schedule K line → shareholder K-1 (1120-S) box/code. Aggregate across investees where the 1120-S expects a single line.
- Optional later: 1099-INT/DIV/B ingestion for C-corp holdings or cash balances.

### 4.6 Entity tax workpapers (1120-S, CT-3-S, NYC GCT)

Produce workpapers (PDF and spreadsheet) with line references for keying into an e-file product. Every figure links back to the ledger query or trace that produced it.

- **Federal:** page-1 income and deductions by line; Schedule K by line (from `schedule_k_line` mappings plus §4.5 pass-through items); shareholder K-1 (1120-S) values; Schedule L balance sheet from the ledger; Schedule M-1 (book/tax differences — should be near zero); Schedule M-2 (AAA / OAA roll-forward, distributions); **Form 7203** shareholder stock-basis roll-forward (required on the owner's 1040 in any year with distributions); Form 4562 worksheet from the §4.8 fixed-asset register when anything is on it.
- **New York:** CT-3-S — fixed dollar minimum from NY receipts; if the NYS PTET (and optionally NYC PTET) election is made, track the election, the quarterly PTET estimates (March 15, June 15, September 15, December 15), and the annual PTET return.
- **New York City:** GCT computation per the NYC-4S instructions — compute every base the form requires (entire net income at the GCT rate, the alternative base that adds back shareholder compensation, the capital base, the fixed dollar minimum) and take the highest. Track NYC-400 estimated-tax installments when prior-year GCT exceeds the threshold in the instructions. **Formulas, rates, and thresholds come from the per-year data files (§4.4 pattern), verified against the current-year instructions.**
- **Accruals:** entity-level taxes accrue to 2200/2210 with the offset in 5200 so the balance sheet and the 1120-S deduction agree.

### 4.7 Owner-level projection ("quarterly payments")

The S-corp itself makes no federal quarterly income-tax payments. The quarterly pain lives at the owner level (Form 1040-ES; NY IT-2105 for NYS + NYC personal) and, at the entity, NYC-400 and PTET installments.

- **Projection engine:** YTD ledger P&L + expected K-1 items (prior year as placeholder, owner override) + planned officer compensation + other household income (entered manually) − the owner-level deductions the entity's numbers create (self-employed health insurance deduction from §4.4, the 401(k) deferral already excluded from Box 1) → estimated federal, NYS, and NYC personal liability for the year.
- **Safe-harbor check:** compare to the lesser of 90% of current-year tax or 100%/110% of prior-year tax (threshold-dependent; table-driven).
- **Recommendation:** the additional federal, NYS, and NYC withholding to apply on the December payroll. Withholding is treated as paid evenly through the year, so December withholding cures Q1–Q3 shortfalls; estimated payments do not. Show the residual to pay by 1040-ES / IT-2105 if wages are too small to carry the required withholding.
- Track payments made: personal ES payments entered manually; entity payments read from the ledger.

### 4.8 Accountable plan, owner reimbursements, and fixed assets

Once the entity is an S-corp, the owner cannot deduct home office, phone, internet, or similar personally. The entity reimburses them under a written accountable plan; reimbursements are deductible to the entity and non-taxable to the owner, provided they are substantiated and paid within the plan's time limits.

- **Plan record:** the adopted written policy (template generated by §4.9, adopted before 1/1/2027), its substantiation window, and the categories it covers.
- **Home office computation:** business-use percentage (square footage) applied to rent/mortgage interest, utilities, renters/homeowners insurance, and similar; phone and internet at a stated business-use percentage. Inputs entered once per year (or when they change); the app computes the annual reimbursement.
- **Submissions:** each reimbursement is a submission with category, amount, computation or receipt attached (§4.10), and approval date. Approved submissions post to 5040 (by category) / 2190; the bank payment to the owner clears 2190 (this is the `accountable-plan reimbursement` tag in §4.2). **No reimbursement posts without an attached document.**
- **Health insurance premiums** the owner paid personally flow through here as their own category, with the W-2 treatment handled in §4.4.
- **Cadence:** one annual submission batch (paid with or near the December payroll) is the default; the app allows more.
- **Fixed-asset register:** items above the de minimis safe-harbor threshold (from per-year tables) go to 1600 with a depreciation method and a §179 / bonus election flag; items at or below it are expensed. Produce the Form 4562 worksheet values in §4.6. The de minimis election statement is a §4.9 output each year.

### 4.9 Corporate records (generated from ledger data)

Formalities are cheap to generate and expensive to reconstruct. Each is a template filled from the database, exported as PDF, signed by the owner, and stored in §4.10.

- **Annual written consent of the sole member/shareholder** covering, for the year: adoption of the reasonable-compensation methodology and the resulting wage (from §4.3, with the methodology version and freeze date); approval of distributions taken (from 3200); ratification of the employer 401(k) contribution (from §4.4); confirmation of the accountable plan (§4.8); adoption of the de minimis safe-harbor election (§4.8); any PTET election decision.
- **Pre-year consent** (before each January 1): comp methodology for the coming year, accountable plan in force, 401(k) deferral election.
- **Standing documents:** operating agreement reference, S-election acceptance letters (CP261 federal, CT-6 approval), EIN letter, NY employer registration confirmations, plan adoption agreement, insurance policy in force. The app tracks that each exists and where it is filed, and flags gaps.

### 4.10 Document vault

- Any record (bank transaction, journal entry, K-1, payroll run, reimbursement submission, corporate record, tax filing) can have documents attached: drag-drop upload or an email-forward inbox address that files by matching amount/date/vendor and queues the rest for the owner.
- Store originals immutably with a hash; retain for at least seven years after the filing they support; export the whole vault by year as a zip with an index.
- Filing confirmations (EFTPS receipts, NY Online Services confirmations, SSA W-2 submission receipts, e-file acknowledgements) attach to the corresponding §5 calendar item and mark it complete.
- The classifier in §4.2 can require a document for specified accounts (meals, travel, reimbursements, professional fees above a threshold) before posting.

### 4.11 CPA review package (the sign-off deliverable)

The goal is that the CPA reviews, never reconciles. One button produces a year-end binder in which every tie-out has already been run and passed.

- **Tie-outs the package must run and display (green/red):**
  - Ledger cash by account = statement closing balance at 12/31, with the reconciliation attached.
  - Officer compensation (5000 + 5030) = W-2 Box 1; FICA wages = Box 3/5; W-3 totals = sum of the 941s; NYS/NYC withholding = sum of NYS-1s = NYS-45 annual totals; 940 FUTA wages = payroll register.
  - Every K-1 input on the 1120-S Schedule K traces to a confirmed §4.5 extraction with the source PDF attached, and the investee's ending outside basis rolls from the prior year.
  - Investee distributions received (bank) = K-1 box 19 (or the difference is explained).
  - Schedule M-2 AAA roll-forward: beginning + income − distributions − nondeductibles = ending, and distributions = 3200.
  - Form 7203 basis roll-forward reconciles to M-2 and to distributions.
  - Schedule L balance sheet balances and ties to the trial balance.
  - Entity tax accruals (2200/2210) = the computed GCT / NYS / PTET liabilities in §4.6.
  - Payroll liability accounts are zero after year-end deposits clear (or the open balance matches a scheduled deposit).
  - Accountable-plan reimbursements each have a document; 401(k) contributions are within the computed limits.
- **Contents:** cover memo listing the tie-out results and any owner notes; trial balance; GL detail; bank reconciliations and statements; payroll register, deposit confirmations, and the form worksheets; K-1 PDFs with extraction reviews; investee basis schedules; the §4.6 workpapers (1120-S, K-1, M-1, M-2, L, 7203, 4562; CT-3-S; NYC GCT; PTET); §4.8 reimbursement schedule; §4.9 signed consents; the §5 calendar with completion evidence.
- **Trial balance export in the CPA's tax-software import format.** Ask the CPA which product they use (Lacerte, UltraTax, ProSeries, Drake, CCH Axcess, etc.) and generate a trial balance CSV with that product's tax-line codes so their review is an import plus a scan. The `form_1120s_line` mapping in §4.1 is the source of those codes; keep the product-specific code table as a data file.
- **Open-items list:** anything the app could not tie out or that needs judgment (a K-1 code it did not recognize, a distribution in excess of basis, a PTET decision) is listed on page one so the CPA's time goes there.
- **Sign-off record:** the CPA's review comments and sign-off date are stored against the package version; a re-run after changes produces a new version with a diff.

---

## 5. Compliance calendar

Generate from rules, never hardcode dates. Each item has a due-date rule (with weekend/holiday rollover), an amount source (ledger query, §4.4 deposit schedule, §4.6 accrual, or §4.7 projection), a filing channel, and a status. Illustrative list; Claude Code encodes the current-year specifics from official instructions and the owner verifies:

- After the December pay run: EFTPS deposit (monthly rule or next-business-day if the $100k rule trips); NYS-1 within 5 business days.
- January 31: Form 941 (Q4), Form 940, W-2 to employee and W-2/W-3 to SSA, NYS-45 (Q4), any 1099-NEC.
- April 30 / July 31 / October 31: NYS-45 (Q1–Q3, zero-wage).
- March 15: Form 1120-S with K-1 (Form 7004 for extension); CT-3-S; NYC GCT return (confirm due date in the NYC-4S instructions); PTET annual return if elected. Employer 401(k) contribution by the return due date including extensions.
- PTET estimates (if elected): March 15, June 15, September 15, December 15.
- NYC-400 installments when applicable, per the form's schedule.
- Owner: 1040-ES and IT-2105 on April 15, June 15, September 15, January 15.
- Before the December pay date: 401(k) deferral election on file; reasonable-comp methodology and wage figure signed off; NY employer registration complete (done outside the app in Q4 2027); annual accountable-plan submission batch approved (§4.8).
- Within 20 days of the first pay date: NY new-hire report for the owner as employee.
- March 15 of the tax year: NYS PTET election deadline (and NYC PTET) — a decision item for the owner and CPA in Q1 of each year, starting Q1 2027.
- Before each January 1: pre-year written consent (§4.9) — comp methodology, accountable plan, 401(k) election, de minimis election.
- Every two years, in the LLC's formation anniversary month (August; formed August 2024, so August 2026 and August 2028): NY LLC biennial statement.
- July 31: Form 5500-EZ if solo 401(k) assets exceed the filing threshold.
- After the 1120-S is filed: assemble the §4.11 review package version marked "as filed"; archive to §4.10.

---

## 6. Non-functional requirements

- Single user, local-first. Minimal but real authentication; the database holds an SSN and bank tokens.
- Audit log for every posted entry, reversal, classification decision, K-1 confirmation, and tax computation (timestamp, table version, before/after).
- Every tax computation stores a trace (inputs, table version, intermediates) exportable as a worksheet.
- Nightly encrypted backup of the database to local disk and one cloud object store.
- Year-start checklist: load and verify the new year's table files (§4.4), roll forward basis (§4.5), open the new period, generate the pre-year consent (§4.9).
- Year-end close checklist: all bank transactions posted and reconciled through 12/31; payroll run posted and deposits scheduled; reimbursement batch paid; K-1s received and confirmed (or placeholders flagged); closing entries (net income and distributions to AAA); §4.11 package generated with all tie-outs green; period locked.
- Retention: seven years minimum for documents and the ledger snapshot supporting each filing; yearly export of everything (database dump + vault zip) to cold storage.
- Ledger invariant tests: random entry generation must never produce an unbalanced or back-dated-into-locked-period entry.

---

## 7. Build order (everything live before the December 2027 payroll)

**Phase 1 — Oct–Dec 2026.** Ledger, COA with tax mappings, CSV/OFX import, classification queue and rules, reconciliation, basic reports. A minimal time log and rate table (§4.3) so the comp methodology can be frozen before 1/1/2027. Document vault basics (§4.10: attach and retain). Accountable-plan policy and pre-year consent templates (§4.9) so both are adopted before 1/1/2027. Parallel-run Q4 2026 against ZipBooks and reconcile to the cent. Owner actions: apply for Plaid production access; ask the CPA which tax software they use and what they want in the review package; confirm the health-insurance arrangement for 2027; file the August 2026 biennial statement if not done.

**Phase 2 — Jan–Apr 2027.** Plaid sync. K-1 ingestion and basis roll-forward, tested on the real 2026 K-1 when it arrives (~March 2027). Year-start checklist. Load 2027 payroll tables as they are published. Reimbursement submissions and fixed-asset register (§4.8). PTET decision with the CPA before March 15.

**Phase 3 — May–Sep 2027.** Payroll engine with 2027 tables including health insurance and 401(k) limits; golden tests; deposit schedule; form worksheets; email-forward inbox for the vault; full dry run of a December payroll.

**Phase 4 — Oct–Nov 2027.** Projection module (§4.7), compliance calendar (§5), entity workpapers (§4.6) dry-run on 2026 data mapped as if it were an S-corp year, annual consent generator (§4.9), and the CPA review package with tie-outs (§4.11) — dry-run the package on the 2026 data and have the CPA react to the format before it matters. Owner registers as a NY employer outside the app.

**December 2027:** first live payroll. **January 2028:** year-end payroll filings. **March 2028:** first 1120-S / CT-3-S / GCT from workpapers.

---

## 8. Guardrails (these become `CLAUDE.md` rules)

- No tax rate, wage base, threshold, or due date is ever hardcoded. All live in per-year data files with source URLs and an owner-verified flag.
- No bank transaction posts to the ledger without owner confirmation or an owner-flagged auto-post rule.
- Investee wires are never revenue. Payments to the owner are never posted untagged.
- No official form is rendered, generated, or filed by this app. Workpapers only.
- No K-1 field posts on low extraction confidence without the owner touching it.
- No reimbursement to the owner posts without an approved §4.8 submission and an attached document.
- Health-insurance premiums are expensed exactly once (5030), and always appear in W-2 Box 1 and Box 14 and never in Box 3/5.
- The §4.11 package cannot be marked "final" with a red tie-out; it can be marked "final with open items" only if each red item has an owner note.
- The app assumes zero commingling: every transaction in a connected account is a business transaction. Personal transactions in a business account are flagged as an error to fix at the bank, not classified as personal.
- Do not build accounts receivable/payable as posting subledgers, inventory, multi-entity, multi-currency, or multi-user. If invoice tracking is wanted, it is a memo list that posts nothing until cash arrives.
- Anthropic API details (model ID, document-input format) are read from current documentation at build time and kept in config.
- The app is not a tax adviser; every workpaper carries a "reviewed by owner/CPA" sign-off field before it is marked final.

---

## 9. Questions Claude Code must ask before writing code

1. Confirm or override the stack in §3, and where the app runs (local machine vs. a small VPS).
2. Is consulting revenue invoiced (memo AR wanted) or paid on receipt only?
3. Which bank accounts are in scope (operating, reserve, any brokerage or 401(k) custodial view)?
4. Is the NYS PTET election (and NYC PTET) planned for 2027?
5. Does the current investee report tax-basis capital on its K-1? Any other investees expected in 2027?
6. Does the solo 401(k) provider require any export/upload format for contributions? What is the plan document's definition of compensation?
7. Preferred format for workpapers: PDF, XLSX, or both?
8. Which tax software does the CPA use (for the §4.11 trial-balance export), and does the CPA have a preferred review-package layout?
9. Health insurance for 2027: entity-paid, owner-paid and reimbursed, or none?
10. Which accountable-plan categories apply (home office square footage and total, phone, internet, other), and are there any fixed assets above the de minimis threshold at 1/1/2027?
11. Is there a personal card or account that has been used for business expenses that needs a one-time cleanup before the zero-commingling rule applies?

---

## 10. First deliverable

An ERD, the chart of accounts with `tax_treatment` and `form_1120s_line` / `schedule_k_line` filled in, the ledger invariants as SQL constraints, the CSV/OFX → classification → posting flow as a sequence diagram, and a Phase 1 task list with estimates. No application code until the owner approves.
