-- E3–E5 additions (additive only).
-- 1. sync_runs.kind: the jobs that record runs beyond the original eight.
-- 2. receipts.offline_id: the phone's queue id, echoed back so an offline replay can clear its entry.
-- 3. bills.is_bc_native: PennyMac and Frontier payments are posted by BC's own recurring journals (R7).
-- 4. ask_conversations.member_id index for "what did I ask".

alter table sync_runs drop constraint if exists sync_runs_kind_check;
alter table sync_runs add constraint sync_runs_kind_check check (kind in (
  'plaid', 'bc_poll', 'bc_webhook', 'webhook_renewal', 'autopost', 'ocr', 'file_import', 'alerts',
  'matching', 'outbox_relay', 'bc_worker', 'bc_readback', 'paycheck_fallback', 'receipt_fallback', 'rule_proposals'));

alter table receipts add column if not exists offline_id text;

alter table bills add column if not exists is_bc_native boolean not null default false;

create index if not exists ask_conversations_member on ask_conversations(household_id, member_id, created_at desc);
