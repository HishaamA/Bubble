begin;

-- PostgREST applies SELECT visibility when an INSERT asks for the created row.
-- The approved owner-membership is added by an AFTER INSERT trigger, so that
-- membership is not yet available while INSERT ... RETURNING is evaluated.
-- The immutable owner_id is already protected by the insert policy and is a
-- valid read authority during that narrow window (and afterwards).
drop policy if exists circles_read_approved_members on public.circles;

create policy circles_read_approved_members
on public.circles
for select
to authenticated
using (
  owner_id = public.current_app_user_id()
  or public.is_approved_circle_member(id)
);

commit;
