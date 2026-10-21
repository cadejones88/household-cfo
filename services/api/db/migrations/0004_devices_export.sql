-- E3–E5: push tokens per member device (Expo push tokens are delivery addresses, not credentials) and the
-- outbox aggregate for a household export request (spec: "Audit and export"; authority matrix: either spouse, step-up).

create table if not exists member_devices (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households(id),
  member_id uuid not null references members(id),
  platform text not null check (platform in ('ios', 'android')),
  push_token text not null,
  device_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, member_id, push_token)
);
create trigger member_devices_updated_at before update on member_devices for each row execute function set_updated_at();
alter table member_devices enable row level security;
alter table member_devices force row level security;
create policy household_isolation on member_devices using (household_id = app_household_id()) with check (household_id = app_household_id());
grant select, insert, update, delete on member_devices to homestead_app;

alter table outbox drop constraint if exists outbox_aggregate_check;
alter table outbox add constraint outbox_aggregate_check check (aggregate in ('transaction', 'budget_revision', 'receipt', 'paycheck', 'household'));
