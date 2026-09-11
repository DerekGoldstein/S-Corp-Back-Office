# Chart of accounts with tax mappings (proposed)

Status: **proposal.** The COA is seeded from a data file, not migrations-with-literals; the
`form_1120s_line` / `schedule_k_line` values below are semantic codes resolved to the printed
form by a per-year `form_captions` file (brief §8: nothing form-specific is hardcoded). Line
references shown reflect the current Form 1120-S layout and are re-verified against each year's
instructions when that year's file is loaded.

## Enums

- **`tax_treatment`** — `taxable_ordinary` (flows into page-1 ordinary income),
  `separately_stated` (Schedule K item, character preserved), `deductible` (page-1 deduction),
  `deductible_50pct` (meals), `nondeductible` (M-1 addback, reduces AAA), `tax_exempt` (OAA),
  `not_tax` (balance sheet / equity).
- **`m2_col`** — close destination for income/expense accounts: `aaa` (default) or `oaa`
  (tax-exempt income and its related nondeductibles).

Mapping code key: `p1.N` = Form 1120-S page 1 line N · `K.N` = Schedule K line N · `L.N` =
Schedule L line N · `M2.a` / `M2.d` = Schedule M-2 column (a) AAA / (d) OAA.

## Assets

| Code | Account | tax_treatment | 1120-S | Notes |
|---|---|---|---|---|
| 1000 | Operating checking | not_tax | L.1 | |
| 1010 | Payroll / tax reserve checking | not_tax | L.1 | optional second account |
| 1500+ | Investment in [investee] | not_tax | L.8 | one account per investee, `investee_id` set; ledger carrying value only — outside basis lives in `basis_rollforwards` |
| 1600 | Fixed assets | not_tax | L.10a | above de-minimis items only (per-year threshold) |
| 1610 | Accumulated depreciation | not_tax | L.10b | contra-asset |

## Liabilities

All `not_tax`, all mapped `L.18` (other current liabilities, with supporting schedule).

| Code | Account | Cleared by |
|---|---|---|
| 2100 | Federal income tax withheld payable | EFTPS deposit |
| 2110 | Social Security payable (EE + ER) | EFTPS deposit |
| 2120 | Medicare payable (EE + ER, incl. Additional) | EFTPS deposit |
| 2130 | NYS withholding payable | NYS-1 payment |
| 2140 | NYC withholding payable | NYS-1 payment |
| 2150 | FUTA payable | 940 / quarterly deposit if > $500 |
| 2160 | NY SUI payable | NYS-45 quarterly |
| 2170 | 401(k) employee deferral payable | provider debit |
| 2180 | 401(k) employer contribution payable | provider debit (by return due date incl. ext.) |
| 2190 | Accountable-plan reimbursements payable | payment to owner tagged `reimbursement` |
| 2200 | Accrued NYC GCT | NYC-400 / NYC-4S payment |
| 2210 | Accrued NYS franchise tax / PTET | CT-3-S FDM / PTET estimate payments |

Tie-out (§4.11): 21xx accounts are zero after year-end deposits clear, or the open balance
matches a scheduled `payroll_deposits` row.

## Equity

| Code | Account | tax_treatment | 1120-S | Notes |
|---|---|---|---|---|
| 3000 | Shareholder paid-in capital | not_tax | L.23 | single-member LLC "units"; APIC presentation |
| 3100 | AAA | not_tax | L.24 + M2.a | close destination for ordinary items |
| 3110 | OAA | not_tax | L.24 + M2.d | tax-exempt income and related nondeductibles |
| 3200 | Shareholder distributions | not_tax | K.16d + M2 line 7 | contra-equity; K-1 (1120-S) box 16 code D; closed to 3100 at year end; only bank txns tagged `distribution` post here |
| 3900 | Current-year net income | not_tax | L.24 | income-summary account used only by the close routine |

M-2 note: the ledger nets distributions into 3100; the M-2 *workpaper* applies the statutory
ordering (distributions cannot take AAA below zero on the form) and reconciles to the ledger.

## Revenue and pass-through items

| Code | Account | tax_treatment | m2 | 1120-S | Sch K | Source |
|---|---|---|---|---|---|---|
| 4000 | Consulting revenue | taxable_ordinary | aaa | p1.1a | (K.1 via p1) | bank classification |
| 4500 | Investee ordinary income (K-1 box 1) | taxable_ordinary | aaa | p1.5 (other income — partnership ordinary income per instructions) | (K.1 via p1) | **confirmed K-1s only — never wires** |
| 4510 | Interest income | separately_stated | aaa | — | K.4 | K-1 box 5; own bank interest (no `investee_id`) |
| 4520 | Dividend income | separately_stated | aaa | — | K.5a/5b | K-1 box 6a/6b; qualified split kept in `k1_fields` |
| 4540 | Net short-term capital gain (loss) | separately_stated | aaa | — | K.7 | K-1 box 8 |
| 4550 | Net long-term capital gain (loss) | separately_stated | aaa | — | K.8a | K-1 box 9a (8b/8c sub-codes retained) |
| 4560 | Net §1231 gain (loss) | separately_stated | aaa | — | K.9 | K-1 box 10 |
| 4570 | Other income (portfolio/other) | separately_stated | aaa | — | K.10 | K-1 box 11 (code kept per field) |
| 4580 | §179 deduction (pass-through) | separately_stated | aaa | — | K.11 | K-1 box 12 |
| 4585 | Charitable contributions (pass-through) | separately_stated | aaa | — | K.12a | K-1 box 13 A/B |
| 4600 | Tax-exempt income | tax_exempt | **oaa** | — | K.16a/16b | K-1 box 18 A/B |
| 4610 | Investee nondeductible expenses | nondeductible | aaa | — (M-1) | K.16c | K-1 box 18 C |
| 4615 | Nondeductibles related to tax-exempt income | nondeductible | **oaa** | — (M-1) | K.16c | create on first use |

Additional 45xx accounts (royalties K.6, investment interest expense K.12b, §59(e) K.12c, other
deductions K.12d, credits K.13, AMT items K.15) are **created on first use** from the K-1 box
catalog in the `k1_map` data file — one account per box/code that must stay separately stated.

## Expenses

| Code | Account | tax_treatment | 1120-S | Doc req. | Notes |
|---|---|---|---|---|---|
| 5000 | Officer compensation | deductible | p1.7 | | gross W-2 wages from payroll runs |
| 5010 | Employer payroll taxes | deductible | p1.12 | | ER SS + Medicare + FUTA + SUI |
| 5020 | Employer 401(k) contribution | deductible | p1.17 | | capped by `limit_checks_401k` |
| 5030 | Shareholder health insurance (2%) | deductible | p1.7 | ✓ | in W-2 Box 1/Box 14, never Box 3/5; **expensed exactly once** (direct payment or §4.8 reimbursement, never both) |
| 5041 | Reimbursements — home office | deductible | p1.19 | ✓ | accountable plan only |
| 5042 | Reimbursements — phone | deductible | p1.19 | ✓ | |
| 5043 | Reimbursements — internet | deductible | p1.19 | ✓ | |
| 5044 | Reimbursements — supplies/other | deductible | p1.19 | ✓ | |
| 5050 | Depreciation | deductible | p1.14 | | from fixed-asset register / 4562 worksheet |
| 5055 | De minimis safe-harbor expense | deductible | p1.19 | ✓ | at/below per-year threshold; election statement is a §4.9 output |
| 5100 | Software & subscriptions | deductible | p1.19 | | |
| 5110 | Professional fees | deductible | p1.19 | ✓ over threshold | legal, CPA, etc. |
| 5120 | Bank & payment fees | deductible | p1.19 | | |
| 5130 | Meals (50% limitation) | deductible_50pct | p1.19 | ✓ | full amount during the year; close reclasses disallowed half to 5900 |
| 5135 | Travel | deductible | p1.19 | ✓ | 100% deductible; kept separate from meals |
| 5140 | Business insurance | deductible | p1.19 | | |
| 5150 | Filing fees & registrations | deductible | p1.12 | | biennial statement, DOS fees |
| 5200 | Entity-level state/local taxes | deductible | p1.12 | | GCT, NYS fixed-dollar minimum, PTET; accrues against 2200/2210; state-level addback handled in CT-3-S/GCT workpapers, not the ledger |
| 5900 | Nondeductible expenses | nondeductible | — (M-1 line 3) | | penalties; disallowed 50% of meals via close reclass; reduces AAA |

"Doc req." = `requires_document`: the §4.2 classifier refuses to post to these accounts without
a vault attachment (thresholds for 5110 configurable).

## Splits the brief listed as single accounts

- Brief's **5040** (reimbursements "by category") → 5041–5044, one account per category so each
  maps to its own supporting-schedule row; the health-insurance category posts to **5030**, not
  a 504x, so the W-2/Box 14 tie-out reads one account.
- Brief's **5050** ("depreciation / de minimis") → 5050 (p1.14) + 5055 (p1.19), because the two
  halves land on different 1120-S lines.

## Guards wired to specific accounts (from §4.2/§8)

- **4500** and all 45xx: bank classification can never target these — they accept postings only
  from the K-1 module (source `k1`) or manual entries flagged for audit. Investee wires credit
  15xx.
- **3200**: only reachable from a bank transaction tagged `distribution` (or close).
- **5000/net-pay**: only reachable from payroll postings and `payroll_net_pay`-tagged
  transactions.
- **21xx**: EFTPS / NYS Online Services / SUI / 401(k)-provider debit patterns are forced to
  clear these, never expense.
