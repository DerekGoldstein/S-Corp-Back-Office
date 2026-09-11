#!/bin/bash
# Probe the ledger invariants: each EXPECT_FAIL must be rejected by the DB,
#
# Companion to 03-ledger-invariants.sql: loads nothing itself — run the DDL
# into a fresh database first, then this script. Every "bad" case must be
# rejected BY THE DATABASE, every "ok" case must commit. Verified 29/29 on
# Postgres 16. Set PSQL_ARGS to point at your instance. This becomes the
# seed of the M1.4 property tests (brief §6).
# each EXPECT_OK must commit.
H="${PSQL_ARGS:--h /tmp/pgs -U postgres -d scorp} -q -v ON_ERROR_STOP=1"
pass=0; fail=0
ok()   { if psql $H -c "$2" >/dev/null 2>/tmp/probe-err; then echo "PASS (ok)   $1"; pass=$((pass+1)); else echo "FAIL (ok)   $1 -> $(tail -1 /tmp/probe-err)"; fail=$((fail+1)); fi }
bad()  { if psql $H -c "$2" >/dev/null 2>/tmp/probe-err; then echo "FAIL (bad)  $1 -> was ACCEPTED"; fail=$((fail+1)); else echo "PASS (bad)  $1 [$(grep -oE 'ERROR:.*' /tmp/probe-err | head -1 | cut -c1-70)]"; pass=$((pass+1)); fi }

# ---- seed ----
ok "seed accounts/investee/bank account" "
INSERT INTO investees (name, entity_type, ownership_pct, acquired_on) VALUES ('Factoring LLC','partnership',50,'2024-08-01');
INSERT INTO accounts (code,name,type,tax_treatment) VALUES ('1000','Operating checking','asset','not_tax');
INSERT INTO accounts (code,name,type,tax_treatment,m2_col) VALUES ('5100','Software','expense','deductible','aaa');
INSERT INTO accounts (code,name,type,tax_treatment,investee_id) VALUES ('1500','Investment in Factoring LLC','asset','not_tax',1);
INSERT INTO bank_accounts (name,ledger_account_id) VALUES ('Chase operating',1);"

# ---- I1/I2/I3 ----
ok  "I1 balanced 2-line entry commits" "
BEGIN;
INSERT INTO journal_entries (entry_date,memo,source_module) VALUES ('2026-10-05','sw subscription','manual');
INSERT INTO journal_lines (entry_id,line_no,account_id,debit,credit) VALUES (1,1,2,4900,0),(1,2,1,0,4900);
COMMIT;"
bad "I1 unbalanced entry rejected at commit" "
BEGIN;
INSERT INTO journal_entries (entry_date,memo,source_module) VALUES ('2026-10-06','oops','manual');
INSERT INTO journal_lines (entry_id,line_no,account_id,debit,credit) VALUES (2,1,2,100,0),(2,2,1,0,99);
COMMIT;"
bad "I2 single-line entry rejected" "
BEGIN;
INSERT INTO journal_entries (entry_date,memo,source_module) VALUES ('2026-10-06','half','manual');
INSERT INTO journal_lines (entry_id,line_no,account_id,debit,credit) VALUES (3,1,2,100,0);
COMMIT;"
bad "I2 header with zero lines rejected" "
BEGIN;
INSERT INTO journal_entries (entry_date,memo,source_module) VALUES ('2026-10-06','empty','manual');
COMMIT;"
bad "I3 line with both sides positive rejected" "
BEGIN;
INSERT INTO journal_entries (entry_date,memo,source_module) VALUES ('2026-10-06','both','manual');
INSERT INTO journal_lines (entry_id,line_no,account_id,debit,credit) VALUES (5,1,2,100,100),(5,2,1,100,100);
COMMIT;"

# ---- I4 append-only ----
bad "I4 UPDATE journal_entries rejected" "UPDATE journal_entries SET memo='edited' WHERE id=1;"
bad "I4 DELETE journal_lines rejected"   "DELETE FROM journal_lines WHERE entry_id=1;"

# ---- I6 locked periods ----
ok  "lock 2026-09" "UPDATE periods SET locked=true, locked_at=now() WHERE tax_year=2026 AND month=9;
INSERT INTO periods (tax_year,month,locked,locked_at) VALUES (2026,9,true,now()) ON CONFLICT (tax_year,month) DO UPDATE SET locked=true, locked_at=now();"
bad "I6 entry dated in locked period rejected" "
BEGIN;
INSERT INTO journal_entries (entry_date,memo,source_module) VALUES ('2026-09-15','backdated','manual');
INSERT INTO journal_lines (entry_id,line_no,account_id,debit,credit) SELECT max(id),1,2,100,0 FROM journal_entries;
COMMIT;"

# ---- I5 reversals ----
ok  "I5 post_reversal mirrors entry 1" "SELECT post_reversal(1,'2026-10-31','undo sw subscription');"
bad "I5 second reversal of same entry rejected" "SELECT post_reversal(1,'2026-10-31','again');"
bad "I5 reversal dated into locked period rejected" "SELECT post_reversal(1,'2026-09-20','locked');"

# ---- I9 dimensions ----
bad "I9 line on investee account without dimension rejected" "
BEGIN;
INSERT INTO journal_entries (entry_date,memo,source_module) VALUES ('2026-10-07','wire','manual');
INSERT INTO journal_lines (entry_id,line_no,account_id,debit,credit) SELECT max(id),1,1,50000,0 FROM journal_entries;
INSERT INTO journal_lines (entry_id,line_no,account_id,debit,credit) SELECT max(id),2,3,0,50000 FROM journal_entries;
COMMIT;"
ok  "I9 same entry with investee_id dimension commits" "
BEGIN;
INSERT INTO journal_entries (entry_date,memo,source_module,source_id) VALUES ('2026-10-07','investee wire','bank',1);
INSERT INTO journal_lines (entry_id,line_no,account_id,debit,credit) SELECT max(id),1,1,50000,0 FROM journal_entries;
INSERT INTO journal_lines (entry_id,line_no,account_id,debit,credit,investee_id) SELECT max(id),2,3,0,50000,1 FROM journal_entries;
COMMIT;"

# ---- I10 source discipline ----
bad "I10 source=bank without source_id rejected" "
INSERT INTO journal_entries (entry_date,memo,source_module) VALUES ('2026-10-08','no source','bank');"
bad "I10 reversal flag without reference rejected" "
INSERT INTO journal_entries (entry_date,memo,source_module) VALUES ('2026-10-08','fake reversal','reversal');"

# ---- I11 account identity ----
bad "I11 re-typing account with posted lines rejected" "UPDATE accounts SET tax_treatment='nondeductible' WHERE code='5100';"
ok  "I11 renaming account (non-identity column) allowed" "UPDATE accounts SET name='Software & subscriptions' WHERE code='5100';"

# ---- investee enum ----
bad "S-corp investee rejected (invalid enum value)" "
INSERT INTO investees (name,entity_type,ownership_pct,acquired_on) VALUES ('Bad Sub','s_corporation',10,'2027-01-01');"

# ---- bank transactions ----
ok  "bank txn import" "
INSERT INTO bank_transactions (bank_account_id,source,import_hash,txn_date,amount,description_raw,description_norm)
VALUES (1,'csv','hash-001','2026-10-09',-4900,'ACME SOFTWARE INC','acme software');"
bad "I12 raw amount update rejected"   "UPDATE bank_transactions SET amount=-5000 WHERE id=1;"
bad "I12 DELETE bank txn rejected"     "DELETE FROM bank_transactions WHERE id=1;"
bad "dedupe: same import_hash rejected" "
INSERT INTO bank_transactions (bank_account_id,source,import_hash,txn_date,amount,description_raw,description_norm)
VALUES (1,'csv','hash-001','2026-10-09',-4900,'ACME SOFTWARE INC','acme software');"
bad "posted status without journal entry rejected" "UPDATE bank_transactions SET status='posted' WHERE id=1;"
ok  "posted with linked entry accepted" "UPDATE bank_transactions SET status='posted', journal_entry_id=1 WHERE id=1;"
bad "I8 owner outflow posted untagged rejected" "
INSERT INTO bank_transactions (bank_account_id,source,import_hash,txn_date,amount,description_raw,description_norm,is_owner_payee,status,journal_entry_id)
VALUES (1,'csv','hash-002','2026-10-10',-100000,'ZELLE TO OWNER','zelle to owner',true,'posted',7);"
ok  "I8 owner outflow with distribution tag accepted" "
INSERT INTO bank_transactions (bank_account_id,source,import_hash,txn_date,amount,description_raw,description_norm,is_owner_payee,status,journal_entry_id,owner_payment_tag)
VALUES (1,'csv','hash-003','2026-10-10',-100000,'ZELLE TO OWNER','zelle to owner',true,'posted',7,'distribution');"
bad "plaid txn without external_id rejected" "
INSERT INTO bank_transactions (bank_account_id,source,txn_date,amount,description_raw,description_norm)
VALUES (1,'plaid','2026-10-11',-500,'FEE','fee');"

echo "==== $pass passed, $fail failed ===="
exit $fail
