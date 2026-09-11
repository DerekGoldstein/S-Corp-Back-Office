# Open questions (brief §9) — answer before any code

Edit answers inline, or reply in the session. Where a recommended default exists I'll use it
unless overridden; questions marked **(blocking)** have no sensible default.

### 1. Stack and where the app runs

Recommended: TypeScript end-to-end, Next.js, Postgres in Docker, Drizzle, Vitest — on your
local machine (local-first per §6), with the nightly encrypted backup to local disk + one
cloud object store. A small VPS later only if you want access away from that machine.

> **Answer:** _[accept default / override; which machine/OS?]_

### 2. Consulting revenue: invoiced (memo AR list) or paid-on-receipt only?

Changes nothing in the ledger (cash basis either way); "invoiced" adds a memo list that posts
nothing until cash arrives (§8). Default: receipt-only, no memo AR.

> **Answer:** _[receipt-only / memo AR wanted]_

### 3. **(blocking)** Which bank accounts are in scope?

Operating checking, a reserve account, anything else (brokerage or 401(k) custodial view)?
For each: institution, and whether a CSV or OFX/QFX export is available (drives the M3 import
profiles). Also needed for the Q4 parallel run.

> **Answer:** _[list]_

### 4. Is the NYS PTET election (and NYC PTET) planned for 2027?

Decision item with the CPA by March 15, 2027 — not needed to build (support is built either
way; it changes which calendar items and accruals activate). Default: build support, decide
in Q1 2027.

> **Answer:** _[planned / not planned / decide Q1 with CPA]_

### 5. Does the factoring LLC's K-1 report tax-basis capital (item L)? Other investees expected in 2027?

Affects how much the §4.5 capital-account cross-check can lean on item L, and whether
multi-investee aggregation needs real data in Phase 2 tests.

> **Answer:** _[yes/no; expected investees]_

### 6. Solo 401(k): provider, any required contribution export/upload format, and the plan document's definition of compensation

The employer-cap computation (25% of comp) keys off the plan's definition — W-2 Box 1 before
deferral reduction, or another definition. I need the provider name and ideally the adoption
agreement in the vault.

> **Answer:** _[provider; format; comp definition]_

### 7. Workpaper format: PDF, XLSX, or both?

Default: **both** — PDF for the binder/sign-off, XLSX for keying into the e-file product and
for the CPA.

> **Answer:** _[both / PDF only / XLSX only]_

### 8. **(blocking for §4.11, not for Phase 1)** Which tax software does the CPA use, and any preferred review-package layout?

Drives the trial-balance export code table (Lacerte / UltraTax / ProSeries / Drake / CCH
Axcess / other). Brief says ask the CPA in Phase 1 — an owner action in `05-phase1-plan.md`.

> **Answer:** _[product; layout notes]_

### 9. Health insurance for 2027: entity-paid, owner-paid and reimbursed, or none?

Drives W-2 Box 1/14 handling, the §4.8 category, the pre-year consent text, and the §4.7
self-employed-health-insurance deduction. Needed before the December 2026 consent is generated.

> **Answer:** _[arrangement; expected annual premium]_

### 10. Accountable-plan categories and fixed assets at 1/1/2027

Home office: total and business square footage, annual rent/utilities/insurance. Phone and
internet: business-use %. Any other categories? Any assets above the de-minimis threshold
expected on hand at 1/1/2027 (would open the fixed-asset register in Phase 2)?

> **Answer:** _[figures; asset list or none]_

### 11. Any personal card/account historically used for business expenses needing a one-time cleanup?

If yes, a one-time documented cleanup (owner contribution or reimbursement batch) happens
before the zero-commingling rule (§8) starts enforcing; the app flags rather than classifies
personal items after that.

> **Answer:** _[yes — describe / no]_

---

Also confirm the two Phase-1-relevant items the brief asks the owner to verify outside §9:
the **August 2026 biennial statement** status (see `05-phase1-plan.md` — appears past due),
and that you're good to start the **Plaid production application** at the top of Phase 1.
