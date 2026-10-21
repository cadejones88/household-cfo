-- The pre-household lookups (members_lookup_fn for sign-in, household_ids_fn for the jobs, the two webhook lookups)
-- are security-definer functions, so they run as their owner. Every table FORCEs row-level security, which filters
-- the owner too unless it is a superuser or has BYPASSRLS. Locally the migrator is a superuser; in Azure it is the
-- Entra administrator, which is neither, so owned by the migrator these functions would return nothing there.
--
-- They are therefore owned by a dedicated NOLOGIN role with one read-only policy on exactly the tables they read.
-- Nobody signs in as it and the app role is not a member of it; it can only be reached through these functions,
-- which return identifiers only.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'homestead_lookup') then
    create role homestead_lookup nologin nosuperuser nobypassrls;
  end if;
end $$;

-- ALTER FUNCTION ... OWNER TO needs the migrator to be able to SET ROLE to the new owner. PostgreSQL 16 gives the
-- creator of a role ADMIN on it but not SET, so grant the membership explicitly (a no-op for a superuser).
grant homestead_lookup to current_user;

grant usage on schema public to homestead_lookup;
grant select on households, members, feed_connections, bc_webhook_subscriptions to homestead_lookup;

create policy lookup_read on households for select to homestead_lookup using (true);
create policy lookup_read on members for select to homestead_lookup using (true);
create policy lookup_read on feed_connections for select to homestead_lookup using (true);
create policy lookup_read on bc_webhook_subscriptions for select to homestead_lookup using (true);

alter function members_lookup_fn(uuid, text) owner to homestead_lookup;
alter function household_ids_fn() owner to homestead_lookup;
alter function plaid_feed_lookup_fn(text) owner to homestead_lookup;
alter function bc_subscription_lookup_fn(text) owner to homestead_lookup;
