-- Homestead schema v1 (Phase 3 spec, "Data model"). Every table is keyed by household_id and protected by
-- row-level security; the API sets `app.household_id` per request and the jobs set it per household.
-- Money is integer cents. Timestamps are timestamptz. The audit log is insert-only at the role level.

-- No extensions: gen_random_uuid() is built into PostgreSQL 13 and later. (pgcrypto was listed here and is not
-- allow-listed on Azure Database for PostgreSQL by default; nothing used it. Removed 10/22/2026 before the first
-- successful Azure run, so no environment has applied the old text.)

-- Roles -------------------------------------------------------------------------------------------
-- homestead_app: the API and jobs. Subject to RLS. Cannot update or delete audit_log.
-- homestead_migrator: owns the schema (used only by migrations and the DBA).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'homestead_app') then
    create role homestead_app nologin;
  end if;
end $$;

create or replace function app_household_id() returns uuid
  language sql stable as $$
    select nullif(current_setting('app.household_id', true), '')::uuid
  $$;

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Households and members --------------------------------------------------------------------------
create table households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'America/Boise',
  currency char(3) not null default 'USD',
  ledger_kind text not null default 'bc' check (ledger_kind in ('bc')),
  settings jsonb not null default '{}'::jsonb,
  settings_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table household_setting_versions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  version int not null,
  settings jsonb not null,
  approved_by uuid[] not null default '{}',
  effective_from timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (household_id, version)
);

create table members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  entra_object_id text not null unique,
  display_name text not null,
  role text not null default 'member' check (role in ('member', 'adviser')),
  passkey_registered boolean not null default false,
  face_id_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ledger and feeds --------------------------------------------------------------------------------
create table ledger_connections (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id) unique,
  bc_tenant_id text not null,
  bc_environment text not null,
  bc_company_id text not null,
  journal_template text not null default 'HHAPP',
  batch_feeds text not null default 'FEEDS',
  batch_receipts text not null default 'RECEIPTS',
  batch_autopost text not null default 'AUTOPOST',
  api_base_url text not null,
  cert_secret_ref text not null,          -- Key Vault secret name; never the certificate
  auto_post_enabled boolean not null default false,
  last_poll_at timestamptz,
  last_webhook_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table feed_connections (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  owner_member_id uuid not null references members(id),
  provider text not null check (provider in ('plaid', 'file', 'simplefin')),
  plaid_item_ref text,                     -- Key Vault secret name for the access token; never the token
  plaid_item_id text,
  institution_id text,
  institution_name text,
  cursor text,
  status text not null default 'ok' check (status in ('ok', 'stale', 'needs_relink', 'disabled')),
  needs_relink boolean not null default false,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  kind text not null check (kind in ('checking', 'savings', 'share', 'card', 'loan', 'mortgage', 'wallet', 'cash', 'line')),
  institution text not null,
  display_name text not null,
  mask text not null default '',           -- last four or the suffix the family uses; never a full number
  bc_bank_account_code text,               -- e.g. BEEHIVE-CHK; null for loans (G/L liabilities)
  bc_gl_account text,                      -- e.g. 101101 or 271101
  feed_connection_id uuid references feed_connections(id),
  plaid_account_id text,
  is_restricted boolean not null default false,
  balance_cents bigint,
  balance_as_of timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, bc_bank_account_code),
  unique (household_id, plaid_account_id)
);

-- Categories and rules ----------------------------------------------------------------------------
create table categories (
  id text not null,                        -- slug from @homestead/shared
  household_id uuid not null references households(id),
  name text not null,
  "group" text not null,
  gl_account text not null,
  dimension_defaults jsonb not null default '{}'::jsonb,
  spend_class text,
  is_allowance boolean not null default false,
  is_transfer boolean not null default false,
  household_visible boolean not null default true,
  examples text[] not null default '{}',
  version int not null default 1,
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (household_id, id)
);

create table rules (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  rule_no text,                            -- R1..R7 for the auto-post candidates
  kind text not null check (kind in ('merchant', 'transfer', 'card_payment', 'recurring_bill', 'paycheck', 'loan_payment', 'bc_native', 'small_merchant')),
  name text not null,
  match jsonb not null,                    -- merchant pattern, account, amount band, cadence
  action jsonb not null,                   -- category, dimensions, split, business flag
  may_auto_post boolean not null default false,
  state text not null default 'proposed' check (state in ('proposed', 'approved', 'retired')),
  proposed_by text not null,               -- member id or 'system'
  approved_by uuid references members(id),
  approved_at timestamptz,
  approval_note text,                      -- the written approval for auto-post rules
  effective_from date,
  version int not null default 1,
  supersedes_rule_id uuid references rules(id),
  test_passed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index rules_household_state on rules(household_id, state);

-- Transactions ------------------------------------------------------------------------------------
create table transactions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  account_id uuid not null references accounts(id),
  source text not null check (source in ('plaid', 'ofx', 'csv', 'pdf', 'receipt', 'paycheck', 'manual')),
  source_ref text not null,
  idempotency_key text not null,
  posted_date date not null,
  authorized_date date,
  amount_cents bigint not null,            -- negative = money out, positive = money in (bank sign)
  merchant_raw text not null default '',
  merchant_norm text not null default '',
  pending boolean not null default false,
  state text not null default 'imported' check (state in (
    'imported', 'possible_duplicate', 'needs_receipt', 'needs_classification', 'ready_for_review', 'approved',
    'sent_to_bc', 'bc_draft_created', 'posted', 'reconciled', 'exception', 'reversed', 'dropped')),
  category_id text,
  dimension_set jsonb not null default '{}'::jsonb,
  business_flag text not null default 'none' check (business_flag in ('none', 'ctj', 'lash')),
  kind text not null default 'spend' check (kind in ('spend', 'income', 'transfer', 'loan_payment', 'paycheck', 'bc_native')),
  confidence numeric(4,3),
  rule_id uuid references rules(id),
  duplicate_of_id uuid references transactions(id),
  pair_id uuid references transactions(id),  -- the other side of a transfer or card payment
  receipt_id uuid,
  receipt_status text not null default 'none' check (receipt_status in ('none', 'needed', 'matched', 'estimated')),
  bc_external_doc_no text,
  bc_batch text check (bc_batch in ('FEEDS', 'RECEIPTS', 'AUTOPOST')),
  bc_journal_id text,
  bc_line_ids text[],
  bc_document_no text,
  bc_entry_nos int[],
  bc_posting_date date,
  bc_bank_ledger_entry_no int,
  last_sync_at timestamptz,
  sync_status text check (sync_status in ('pending', 'in_sync', 'difference', 'error')),
  sync_difference text,
  exception_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, idempotency_key),
  foreign key (household_id, category_id) references categories(household_id, id),
  -- A transaction cannot enter sent_to_bc or later without a BC External Document No.
  constraint bc_doc_required check (
    state not in ('sent_to_bc', 'bc_draft_created', 'posted', 'reconciled', 'reversed') or bc_external_doc_no is not null
  )
);
create index transactions_household_state on transactions(household_id, state);
create index transactions_household_date on transactions(household_id, posted_date desc);
create index transactions_household_account_date on transactions(household_id, account_id, posted_date);
create index transactions_bc_doc on transactions(household_id, bc_external_doc_no) where bc_external_doc_no is not null;

create table transaction_splits (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  transaction_id uuid not null references transactions(id) on delete cascade,
  line_no int not null,
  amount_cents bigint not null,
  category_id text not null,
  gl_account text not null,
  dimension_set jsonb not null default '{}'::jsonb,
  description text not null default '',
  receipt_line_id uuid,
  bc_line_id text,
  unique (transaction_id, line_no),
  foreign key (household_id, category_id) references categories(household_id, id)
);

-- Receipts ----------------------------------------------------------------------------------------
create table receipts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  member_id uuid not null references members(id),
  blob_ref text not null,                  -- container/path; the image is encrypted with the household key
  sha256 text not null,
  captured_at timestamptz not null,
  uploaded_at timestamptz not null default now(),
  ocr_status text not null default 'queued' check (ocr_status in ('queued', 'read', 'failed', 'needs_review')),
  ocr_result jsonb,
  merchant text,
  merchant_norm text,
  total_cents bigint,
  tax_cents bigint,
  tip_cents bigint,
  receipt_date date,
  matched_transaction_id uuid references transactions(id),
  match_confidence numeric(4,3),
  kind text not null default 'receipt' check (kind in ('receipt', 'pay_stub', 'statement')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, sha256)
);

create table receipt_lines (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  receipt_id uuid not null references receipts(id) on delete cascade,
  line_no int not null,
  description text not null,
  qty numeric(10,3),
  amount_cents bigint not null,
  suggested_category_id text,
  suggested_confidence numeric(4,3),
  unique (receipt_id, line_no)
);

-- Paychecks ---------------------------------------------------------------------------------------
create table employers (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  member_id uuid not null references members(id),
  code text not null check (code in ('HFH', 'CTJ')),
  name text not null,
  descriptor_pattern text not null,
  bc_gross_account text not null,
  bc_bonus_account text not null,
  template jsonb not null default '{}'::jsonb,
  last_stub_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, code)
);

create table paychecks (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  employer_id uuid not null references employers(id),
  member_id uuid not null references members(id),
  pay_date date not null,
  period_start date,
  period_end date,
  net_cents bigint not null,
  source text not null check (source in ('stub_pdf', 'stub_image', 'template')),
  estimated boolean not null default false,
  transaction_id uuid references transactions(id),
  stub_receipt_id uuid references receipts(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, employer_id, pay_date, net_cents)
);

create table paycheck_components (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  paycheck_id uuid not null references paychecks(id) on delete cascade,
  line_no int not null,
  kind text not null check (kind in ('regular', 'bonus', 'overtime', 'fit', 'state_tax', 'social_security', 'medicare', 'benefit', 'other_deduction')),
  label text not null,
  amount_cents bigint not null,
  gl_account text not null,
  dimension_set jsonb not null default '{}'::jsonb,
  unique (paycheck_id, line_no)
);

-- Approvals, budgets, bills, alerts ---------------------------------------------------------------
create table approvals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  kind text not null check (kind in ('budget_move', 'correction', 'rule', 'business_flag', 'auto_post_rule', 'settings')),
  payload jsonb not null,
  requested_by uuid not null references members(id),
  decided_by uuid references members(id),
  decision text check (decision in ('approved', 'declined')),
  step_up_verified boolean not null default false,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint other_spouse_decides check (decided_by is null or decided_by <> requested_by)
);

create table budget_revisions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  bc_budget_name text not null,
  revision_no int not null,
  lines jsonb not null,                    -- [{account, dimensions, period, amount_cents}]
  approval_id uuid references approvals(id),
  written_to_bc_at timestamptz,
  created_at timestamptz not null default now(),
  unique (household_id, bc_budget_name, revision_no),
  constraint no_original_budget check (bc_budget_name !~* '-ORIG$')
);

create table bills (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  name text not null,
  account_id uuid references accounts(id),
  category_id text,
  amount_cents bigint not null,
  due_day int,                             -- day of month for monthly bills
  next_due_date date not null,
  cadence text not null default 'monthly' check (cadence in ('weekly', 'biweekly', 'monthly', 'annual', 'once')),
  is_minimum boolean not null default false,
  autopay boolean not null default false,
  paid_through date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (household_id, category_id) references categories(household_id, id)
);

create table alerts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  member_id uuid references members(id),   -- null = both spouses
  kind text not null,
  level text not null check (level in ('action', 'watch', 'pulse')),
  fingerprint text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  snoozed_until timestamptz,
  resolved_at timestamptz
);
create unique index alerts_open_fingerprint on alerts(household_id, fingerprint) where resolved_at is null;

-- Operations: sync runs, outbox, audit ------------------------------------------------------------
create table sync_runs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  kind text not null check (kind in ('plaid', 'bc_poll', 'bc_webhook', 'webhook_renewal', 'autopost', 'ocr', 'file_import', 'alerts')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'failed')),
  counts jsonb not null default '{}'::jsonb,
  error text
);
create index sync_runs_household_kind on sync_runs(household_id, kind, started_at desc);

create table outbox (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  aggregate text not null check (aggregate in ('transaction', 'budget_revision', 'receipt', 'paycheck')),
  aggregate_id uuid not null,
  operation text not null,
  payload jsonb not null,
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  dead_lettered boolean not null default false,
  published_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index outbox_due on outbox(next_attempt_at) where completed_at is null and not dead_lettered;

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  actor text not null,                     -- member id or job name
  action text not null,
  entity text not null,
  entity_id text not null,
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);
create index audit_log_household_at on audit_log(household_id, at desc);
create index audit_log_entity on audit_log(household_id, entity, entity_id);

create table bc_webhook_subscriptions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  resource text not null,                  -- generalLedgerEntries, journals
  subscription_id text not null,
  client_state_ref text not null,          -- Key Vault secret name for the clientState
  expires_at timestamptz not null,
  last_renewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (household_id, resource)
);

create table ask_conversations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  member_id uuid not null references members(id),
  question text not null,
  answer text,
  used jsonb,
  data_through timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days'
);

create table import_profiles (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  name text not null,
  institution text not null,
  format text not null check (format in ('csv', 'ofx', 'qfx', 'pdf')),
  spec jsonb not null,                     -- column map, date format, sign convention
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, name)
);

-- updated_at triggers -----------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['households','members','ledger_connections','feed_connections','accounts','categories','rules',
    'transactions','receipts','employers','paychecks','bills','import_profiles'] loop
    execute format('create trigger %I_updated_at before update on %I for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

-- Row-level security ------------------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array['households','household_setting_versions','members','ledger_connections','feed_connections',
    'accounts','categories','rules','transactions','transaction_splits','receipts','receipt_lines','employers','paychecks',
    'paycheck_components','approvals','budget_revisions','bills','alerts','sync_runs','outbox','audit_log',
    'bc_webhook_subscriptions','ask_conversations','import_profiles'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    if t = 'households' then
      execute 'create policy household_isolation on households using (id = app_household_id()) with check (id = app_household_id())';
    else
      execute format('create policy household_isolation on %I using (household_id = app_household_id()) with check (household_id = app_household_id())', t);
    end if;
  end loop;
end $$;

-- Grants: the app role may read and write everything in its household, but the audit log is insert-only.
grant usage on schema public to homestead_app;
grant select, insert, update, delete on all tables in schema public to homestead_app;
revoke update, delete on audit_log from homestead_app;
revoke update, delete on household_setting_versions from homestead_app;
grant execute on function app_household_id() to homestead_app;

-- Posted BC entries are mirrored, never edited: once a transaction is posted, bc_entry_nos may not change.
create or replace function protect_posted_mirror() returns trigger language plpgsql as $$
begin
  if old.state in ('posted', 'reconciled', 'reversed') and new.bc_entry_nos is distinct from old.bc_entry_nos
     and old.bc_entry_nos is not null then
    raise exception 'bc_entry_nos is immutable once posted (transaction %)', old.id;
  end if;
  if old.idempotency_key <> new.idempotency_key then
    raise exception 'idempotency_key is immutable (transaction %)', old.id;
  end if;
  return new;
end $$;
create trigger transactions_protect_posted before update on transactions for each row execute function protect_posted_mirror();
