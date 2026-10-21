-- Lookups that run before a household is known. Under row-level security the app role sees nothing without
-- `app.household_id`, so these security-definer functions (like members_lookup_fn in 0002) answer exactly one
-- question each and return identifiers only, never household data.
--
-- household_ids_fn         the jobs iterate households (each one then runs inside withHousehold)
-- plaid_feed_lookup_fn     a Plaid webhook names an Item; which household and feed is it?
-- bc_subscription_lookup_fn a BC notification names a subscription; which household, and where is its clientState?

create or replace function household_ids_fn()
returns table (id uuid)
language sql security definer stable
set search_path = public as $$
  select h.id from households h order by h.created_at
$$;
revoke all on function household_ids_fn() from public;
grant execute on function household_ids_fn() to homestead_app;

create or replace function plaid_feed_lookup_fn(p_item_id text)
returns table (household_id uuid, id uuid, owner_member_id uuid, institution_name text)
language sql security definer stable
set search_path = public as $$
  select f.household_id, f.id, f.owner_member_id, f.institution_name
  from feed_connections f
  where f.plaid_item_id = p_item_id and f.provider = 'plaid'
  limit 1
$$;
revoke all on function plaid_feed_lookup_fn(text) from public;
grant execute on function plaid_feed_lookup_fn(text) to homestead_app;

create or replace function bc_subscription_lookup_fn(p_subscription_id text)
returns table (household_id uuid, id uuid, client_state_ref text, resource text)
language sql security definer stable
set search_path = public as $$
  select s.household_id, s.id, s.client_state_ref, s.resource
  from bc_webhook_subscriptions s
  where s.subscription_id = p_subscription_id
  limit 1
$$;
revoke all on function bc_subscription_lookup_fn(text) from public;
grant execute on function bc_subscription_lookup_fn(text) to homestead_app;
