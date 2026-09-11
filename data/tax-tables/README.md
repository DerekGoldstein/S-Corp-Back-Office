# Per-year tax tables (guardrail 1)

No tax rate, wage base, threshold, or due date lives in code. Each year gets a directory
(`data/tax-tables/2027/…`) of JSON files, one per `kind`:

| kind | contents | official source |
|---|---|---|
| `fica` | SS rate + wage base, Medicare rate, Additional Medicare threshold | SSA COLA fact sheet / IRS Pub 15 |
| `pub15t` | percentage-method tables (annual period) + W-4 handling | IRS Pub 15-T |
| `nys50t_nys`, `nys50t_nyc` | NYS/NYC withholding methods | NYS-50-T-NYS / -NYC |
| `futa` | rate, wage base, NY credit-reduction status | IRS Form 940 instructions |
| `ny_sui` | SUI wage base, employer's assigned rate, re-employment fund rate | NYS DOL rate notice |
| `limits_401k` | elective deferral cap, catch-up, 415(c) overall limit, comp cap | IRS COLA notice |
| `de_minimis` | de minimis safe-harbor threshold | Treas. Reg. §1.263(a)-1(f) |
| `safe_harbor` | 1040-ES safe-harbor percentages and AGI threshold | Form 1040-ES |
| `gct`, `ct3s`, `ptet` | NYC GCT bases/rates/FDM, CT-3-S FDM schedule, PTET rates/dates | NYC-4S / CT-3-S / PTET instructions |
| `holidays` | federal + NYS holidays (due-date rollover) | OPM / NYS |
| `k1_map` | K-1 (1065) box/code → 1120-S Schedule K line map | form instructions |
| `form_captions` | semantic mapping code → printed form line/caption | current-year forms |
| `tb_export_codes` | account → CPA tax-software import code | CPA's product docs |

File shape:

```json
{
  "kind": "fica",
  "source_url": "https://…official…",
  "effective_from": "2027-01-01",
  "effective_to": "2027-12-31",
  "payload": { "…": "…" }
}
```

## Workflow (year-start checklist, brief §6)

1. Create/refresh the files from the official sources. **`null` means placeholder.**
2. `loadTaxTables(db, year)` — every changed file becomes a new *unverified* version.
3. Verify each version in-app after checking against the source. Verification refuses
   payloads that still contain nulls, and is one-way (immutable row).
4. Payroll/workpapers call `getVerifiedTable(...)`: they refuse to run on unverified
   tables, and refuse when a file changed without re-verification — so editing a table
   can never silently flow into a computation. Golden payroll tests pin expected values,
   failing loudly on any table change until fixtures are re-derived by hand.

The 2027 files ship as placeholders (all-null payloads) so the shape is fixed now and the
values are filled from official 2027 publications when released — never from memory.
