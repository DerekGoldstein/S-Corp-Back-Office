# Owner's guide — a year in the back office

What to actually do, screen by screen, for tax year 2027 (the first S-corp
year). The app enforces the guardrails; this guide is the rhythm. Everything
here assumes `npm run dev` (or the production server) and the nightly backup
cron are running.

## Once, before 1/1/2027 (the pre-year gate)

1. **Settings** — set `entity_name`, `owner_name`, the owner-payee regex
   (matches ACH descriptions of payments to you), and confirm the Anthropic
   model/config rows.
2. **Time & comp** — the time log should already be accumulating 2026 hours.
   Add the market-rate sources with citations, build the comp computation,
   and **freeze the methodology before 1/1/2027** (brief §4.3). The December
   payroll refuses to run from an unfrozen methodology.
3. **Corporate records** — generate the accountable-plan policy and the
   pre-year consent, print, sign, scan, and upload the signed copies. The
   records screen tracks the gap until both signed documents are vaulted.
4. **Banking** — open the dedicated business accounts; connect them under
   Import (CSV profile per account). Zero commingling from day one: the
   queue flags any owner-looking payee that isn't tagged.
5. **Calendar** — generate the 2027 items. Verify the federal-holiday table
   when prompted (rollover dates depend on it).

## Monthly (15 minutes)

1. **Import** — download CSV/OFX from each bank, upload. Re-imports are
   no-ops; identical same-day charges both survive.
2. **Classification queue** — work it to zero. The guards do the arguing:
   investee wires can never be revenue, EFTPS/NYS debits must clear their
   liability accounts, owner payments must carry a tag (payroll net /
   distribution / reimbursement), documents are demanded where required.
   Rules you flag as auto-post handle the repeat vendors next month.
3. **Reconciliation** — tick the month against the statement. It completes
   only at a zero difference, and period locks in Settings are gated on it.

## When an investee K-1 or wire arrives

- Wires from partnerships land in the queue pre-forced to the investment
  account (never revenue). At K-1 season, upload each PDF under **K-1s**:
  extraction proposes per-field values with confidence, you confirm
  field-by-field (low-confidence fields never post untouched), posting is
  character-preserving, and box 19 must reconcile to the year's classified
  wires. The basis roll-forward (§705 ordering, suspended losses) updates
  itself and feeds Form 7203.

## Quarterly (optional but smart)

- **Year-end → owner projection** — refresh the safe-harbor picture. It
  states its assumptions on every result; nothing files from here.

## December (the big week, brief §4.4/§6.3)

Order matters; each step refuses to run until its prerequisites exist.

1. **Payroll → tables** — load the 2027 table files (Pub 15-T, NYS-50-T,
   FICA/FUTA/SUI, 401(k) limits, deposit rules, holidays) and verify each
   against the official source. Placeholders with nulls refuse verification;
   nothing computes from an unverified table.
2. **Reimbursements** — enter the year's submissions (home-office fields
   compute the amount; every submission needs its document), approve them —
   approval posts expense / 2190 — and pay the batch with one transfer.
   Tag the bank payment `reimbursement`; it clears 2190 and marks the
   submissions paid. Health premiums route to 5030 exactly once.
3. **Payroll → run** — the annual run computes from the frozen comp
   methodology and verified tables, posts the §4.1 entry, schedules the
   deposits ($100k next-day rule and NYS-1 windows handled). Generate the
   **pay stub** from the posted run. Pay the net amount; tag it
   `payroll_net_pay`. Clear each deposit as its EFTPS/NYS debit arrives.
4. **Fixed assets** — make sure every 2027 purchase classified to 1600 has
   a register row (the package tie-out will catch strays), then **post
   annual depreciation**. §179/bonus elections need the verified
   `depreciation` table and >50% business use.
5. **Distributions** — any owner draw beyond net pay and reimbursements is
   tagged `distribution` in the queue (it posts to 3200 automatically).

## January–March (year-end close and the CPA)

1. **Reconcile December**, then **Year-end → close**: meals 50% reclass
   (odd cent to disallowed), income to AAA/OAA, distributions closed,
   periods locked. Reopen exists and reverses cleanly if something surfaces.
2. **Workpapers** — build 1120-S (page 1, K, L, M-1, M-2), GCT/CT-3-S,
   Form 7203, 4562. Every sheet carries its tie-outs; red rows are your
   work list, not the CPA's.
3. **Payroll worksheets** — 941 Q4, 940, W-2, NYS-45 line values for
   whoever files them (the app renders no official forms).
4. **Year-end → CPA review package** — run all tie-outs, note any red rows
   you're consciously leaving open, finalize (guardrail 8: `final` needs
   all green; `final_with_open_items` needs a note on every red).
   Download the **hand-off zip** (latest workpapers + every 2027 vault
   document, integrity-checked) and send it with the TB export in the
   CPA's software codes.
5. **Calendar** — mark each filing confirmed as its acknowledgment arrives;
   attach the confirmation document.

## Standing rules the app will hold you to

- No entry without balance; no correction except by reversal; no locked
  period changes. The database enforces these, not good intentions.
- No tax computation from an unverified table, ever. When a rate looks
  wrong, fix the table file and re-verify — never patch a number in code.
- Disposing of a fixed asset stops its depreciation and routes the gain
  (§1245 recapture) to a manual entry with the CPA for now.
- The package is never "final" with silent red tie-outs.

*The app prepares workpapers and records; it does not file, and nothing in
it is legal or tax advice.*
