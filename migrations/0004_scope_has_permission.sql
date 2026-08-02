-- ============================================================================
-- 0004_scope_has_permission.sql
-- Scope has_permission() role grants to the organization being asked about.
-- ============================================================================
--
-- SUPERSEDES the has_permission() definition in
--   Frontend/supabase/migrations/017_roles_badges.sql
-- Do NOT re-apply 017 after this migration; doing so silently reinstates the
-- cross-tenant escalation described below. The backend is schema-of-record for
-- this function from here on (see Staunton Backend/README.md).
--
-- ── The bug ─────────────────────────────────────────────────────────────────
-- The 017 definition resolved "does this user hold a role granting this
-- permission?" with a join over member_roles that never filtered on org_id:
--
--     from members m
--     join member_roles mr on mr.member_id = m.id and mr.revoked_at is null
--     join role_permissions rp on rp.role_id = mr.role_id
--     where m.auth_user_id = p_user
--       and rp.permission_key = p_permission
--
-- member_roles.org_id exists precisely to scope a grant to one tenant, and it
-- was written but never read. The consequence: ANY role grant applied globally.
-- A 'trader' granted inside org A satisfied a permission check asked about
-- org B, and the only remaining gate was org B's own status — which an attacker
-- does not control but also does not need, because a live counterparty firm is
-- 'full' by definition. Confirmed against the dev database before this change:
--
--     has_permission('deal.enter', own org A)      = true
--     has_permission('deal.enter', OTHER org B)    = true   <-- escalation
--
-- The application-side half of this (never trusting a client-supplied org_id on
-- role assignment, and resolving the caller's org server-side on
-- /api/access/permissions/check) landed in commit 81aff09. That closed the
-- routes an attacker could reach today; this closes the function itself, so the
-- next caller that legitimately passes p_org cannot reopen it.
--
-- ── The fix, and why it is not a bare `mr.org_id = v_org` ───────────────────
-- Org-scoped and deal-scoped grants are now only counted when
-- mr.org_id = v_org. Platform-scoped roles (roles.scope = 'platform':
-- platform_admin, verifier, support) are deliberately left unscoped, because a
-- platform role is global by definition and its grant row may legitimately
-- carry org_id IS NULL (the column is nullable, and platform staff are commonly
-- not members of any org). A bare `mr.org_id = v_org` would evaluate to NULL
-- for those rows, drop them from the EXISTS, and take every `admin.*`
-- permission with them — breaking the admin vetting queue, onboarding and role
-- administration endpoints. The scope test preserves the platform-admin bypass
-- exactly as 017 intended while still confining tenant-level grants.
--
-- Signature, return type, volatility, security context and the
-- org_status_permits() gate are unchanged. The only behavioural differences:
--   1. org/deal-scoped grants no longer satisfy checks about another org;
--   2. v_org is resolved before the grant lookup instead of after (it is now an
--      input to that lookup). Resolution logic itself is identical.
--
-- Idempotent: CREATE OR REPLACE, safe to run repeatedly.
-- ============================================================================

-- Fail loudly and early rather than installing a function that cannot work.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'roles' and column_name = 'scope'
  ) then
    raise exception 'public.roles.scope is missing — apply 017_roles_badges.sql before this migration';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'member_roles' and column_name = 'org_id'
  ) then
    raise exception 'public.member_roles.org_id is missing — apply 017_roles_badges.sql before this migration';
  end if;

  if to_regprocedure('public.org_status_permits(text, text)') is null then
    raise exception 'public.org_status_permits(text,text) is missing — apply 017_roles_badges.sql before this migration';
  end if;
end;
$$;

create or replace function public.has_permission(
  p_user uuid,
  p_permission text,
  p_org uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_org uuid;
  v_status text;
  v_has_role boolean;
begin
  -- Resolve the org FIRST: it is now an input to the grant lookup below.
  -- Explicit param, else the user's own org. (Unchanged from 017, moved up.)
  v_org := coalesce(p_org, (select org_id from members where auth_user_id = p_user limit 1));

  -- Does the user hold any (non-revoked) role granting this permission
  -- *for this org*?
  --
  -- Platform-scoped roles are global and stay unscoped — that is what keeps the
  -- `admin.%` bypass below working for platform staff, whose grants may carry a
  -- NULL org_id. Org- and deal-scoped grants must match v_org exactly.
  select exists (
    select 1
    from members m
    join member_roles mr on mr.member_id = m.id and mr.revoked_at is null
    join roles r on r.id = mr.role_id
    join role_permissions rp on rp.role_id = mr.role_id
    where m.auth_user_id = p_user
      and rp.permission_key = p_permission
      and (r.scope = 'platform' or mr.org_id = v_org)
  ) into v_has_role;

  if not v_has_role then
    return false;
  end if;

  -- Platform-scope permissions aren't org-status gated.
  if p_permission like 'admin.%' then
    return true;
  end if;

  select status into v_status from organizations where id = v_org;
  if v_status is null then
    return false;
  end if;

  return org_status_permits(v_status, p_permission);
end;
$$;

comment on function public.has_permission(uuid, text, uuid) is
  'Effective permission = role grants (org-scoped, except platform roles) INTERSECT org-status allowances. Supersedes the definition in Frontend/supabase/migrations/017_roles_badges.sql; do not re-apply that file.';
