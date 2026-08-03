-- 0016_avatars_bucket_hardening.sql
-- ============================================================================
-- HARDENS THE `avatars` STORAGE BUCKET.
--
-- ── The holes (confirmed live 2026-08-02) ───────────────────────────────────
-- 009_avatars_storage.sql leaves the bucket:
--   * anon-LISTABLE — the SELECT policy "Avatar images are publicly accessible"
--     has no role clause, so it applies to anon. An unauthenticated call to
--     POST /storage/v1/object/list/avatars returned the object listing, i.e. the
--     raw user UUIDs of every member with an avatar (a member enumeration
--     oracle on an invite-only platform):
--         [{"name":"eb12bd1a-9550-...","...":null}, ...]
--   * unbounded — file_size_limit = NULL, allowed_mime_types = NULL, so any
--     size and any content type (a renamed executable, an SVG with script) is
--     accepted.
--   * cross-writable — 009's INSERT/UPDATE/DELETE policies check only
--     auth.role() = 'authenticated', NOT ownership. So ANY logged-in member can
--     overwrite or delete ANY other member's avatar object.
--
-- ── The fix ─────────────────────────────────────────────────────────────────
--   1. Size + MIME limits on the bucket (5 MB, image types) — matches the
--      server-side checks in services/profiles.ts (AVATAR_MAX_BYTES / AVATAR_MIME)
--      so the storage layer enforces the same rule the API already does.
--   2. SELECT policy scoped to `authenticated` — anon can no longer LIST the
--      bucket. Public DISPLAY is unaffected: the bucket stays `public = true`, so
--      avatar images still load via the /object/public/ path (which bypasses RLS
--      and does not enumerate). Only the listing/enumeration API is closed.
--   3. INSERT/UPDATE/DELETE scoped to the OWNER (first path segment = the
--      caller's uid), restoring the ownership check 009 dropped. The backend
--      writes as `<userId>/avatar_...` via the service role (which bypasses RLS),
--      so /api/profiles/me/avatar keeps working.
--
-- IDEMPOTENT: bucket update is a plain UPDATE; policies are dropped-if-exists
-- then recreated. Safe to re-run.
-- ============================================================================

do $$
begin
  if to_regclass('storage.buckets') is null then
    raise exception 'storage.buckets is missing — is this a Supabase project?';
  end if;
  if not exists (select 1 from storage.buckets where id = 'avatars') then
    raise warning 'avatars bucket not found — creating it (public, limited)';
    insert into storage.buckets (id, name, public) values ('avatars','avatars', true)
      on conflict (id) do nothing;
  end if;
end $$;


-- ── 1. Size + MIME limits (bucket stays public for display) ──────────────────
update storage.buckets
   set file_size_limit   = 5242880,   -- 5 MB, matches AVATAR_MAX_BYTES
       allowed_mime_types = array['image/jpeg','image/png','image/gif','image/webp'],
       public             = true       -- explicit: display-by-path stays public
 where id = 'avatars';


-- ── 2 + 3. Replace the avatars storage.objects policies ──────────────────────
do $$
begin
  -- Clear every historical name (003 + 009) so we do not stack policies.
  execute 'drop policy if exists "Avatar images are publicly accessible" on storage.objects';
  execute 'drop policy if exists "Users can upload own avatar" on storage.objects';
  execute 'drop policy if exists "Users can update own avatar" on storage.objects';
  execute 'drop policy if exists "Users can delete own avatar" on storage.objects';
  execute 'drop policy if exists "Anyone can upload avatars" on storage.objects';
  execute 'drop policy if exists "Anyone can update avatars" on storage.objects';
  execute 'drop policy if exists "Anyone can delete avatars" on storage.objects';
  -- New-scheme names (idempotent re-run).
  execute 'drop policy if exists avatars_select_authenticated on storage.objects';
  execute 'drop policy if exists avatars_insert_owner on storage.objects';
  execute 'drop policy if exists avatars_update_owner on storage.objects';
  execute 'drop policy if exists avatars_delete_owner on storage.objects';

  -- SELECT/list: authenticated only. anon can no longer enumerate the bucket.
  execute $p$
    create policy avatars_select_authenticated on storage.objects
      for select to authenticated
      using (bucket_id = 'avatars')
  $p$;

  -- INSERT: only into your own <uid>/ prefix.
  execute $p$
    create policy avatars_insert_owner on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'avatars'
        and auth.uid()::text = (storage.foldername(name))[1]
      )
  $p$;

  -- UPDATE: only your own objects, and cannot be moved out of your prefix.
  execute $p$
    create policy avatars_update_owner on storage.objects
      for update to authenticated
      using (
        bucket_id = 'avatars'
        and auth.uid()::text = (storage.foldername(name))[1]
      )
      with check (
        bucket_id = 'avatars'
        and auth.uid()::text = (storage.foldername(name))[1]
      )
  $p$;

  -- DELETE: only your own objects.
  execute $p$
    create policy avatars_delete_owner on storage.objects
      for delete to authenticated
      using (
        bucket_id = 'avatars'
        and auth.uid()::text = (storage.foldername(name))[1]
      )
  $p$;

  raise notice 'avatars: anon listing closed, owner-scoped writes restored, 5MB/image-only limits set';
end $$;


-- ============================================================================
-- VERIFICATION — run after applying, or `npm run verify:avatars`.
-- ============================================================================
-- 1. anon cannot list the bucket. Expect an empty list / denial (BEFORE it
--    returned member UUIDs):
--
--      curl -s -X POST "$SUPABASE_URL/storage/v1/object/list/avatars" \
--           -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
--           -H 'Content-Type: application/json' -d '{"prefix":"","limit":100}'
--
-- 2. Limits are set. Expect file_size_limit = 5242880 and the four image types:
--
--      select file_size_limit, allowed_mime_types from storage.buckets where id='avatars';
--
-- 3. Display still works — a known public avatar URL loads with no auth:
--
--      GET $SUPABASE_URL/storage/v1/object/public/avatars/<uid>/<file>  -> 200
-- ============================================================================
