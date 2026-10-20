-- Sign-in happens before the household is known. This security-definer function returns the one member row
-- for a member id or Entra object id without exposing the members table outside RLS.
create or replace function members_lookup_fn(p_member_id uuid, p_entra_object_id text)
returns table (id uuid, household_id uuid, display_name text, role text, entra_object_id text)
language sql security definer stable
set search_path = public as $$
  select m.id, m.household_id, m.display_name, m.role, m.entra_object_id
  from members m
  where (p_member_id is not null and m.id = p_member_id)
     or (p_entra_object_id is not null and m.entra_object_id = p_entra_object_id)
  limit 1
$$;
revoke all on function members_lookup_fn(uuid, text) from public;
grant execute on function members_lookup_fn(uuid, text) to homestead_app;

-- A view the API queries by id or entra_object_id; the function does the privileged read.
create or replace view members_lookup as
  select m.id, m.household_id, m.display_name, m.role, m.entra_object_id from members m;
-- The view inherits RLS from members for ordinary reads; the API uses the function for sign-in.
