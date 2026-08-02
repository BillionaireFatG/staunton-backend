-- 0009_messaging_authz_hardening.sql
-- ============================================================================
-- MESSAGING AUTHORIZATION HARDENING
--
-- Chat is designated core to the business model, so the messaging findings from
-- the RLS audit are treated here as priority defects rather than known issues.
--
-- ── WHAT WAS VERIFIED AGAINST THE LIVE DATABASE BEFORE THIS WAS WRITTEN ─────
-- `002_messages_schema.sql` and `003_profiles_and_chat.sql` define INCOMPATIBLE
-- `messages` tables and both use CREATE TABLE IF NOT EXISTS, so which one won is
-- a question about the database, not about the repo. Probed via PostgREST with
-- real SELECTs that return a body (a HEAD+count against a missing table returns
-- a NULL count and NO error, which produced a false positive earlier in this
-- project). Findings, 2 Aug 2026:
--
--   * public.messages       EXISTS, and is the 003 shape:
--                           (id, conversation_id, sender_id, content, read, created_at)
--                           => migration 002's messages table NEVER APPLIED.
--   * public.conversations  EXISTS as a TABLE, 003 shape (participant_1/2).
--                           => NOT the 002 VIEW. No deal_id column.
--   * public.global_messages EXISTS, has rows, and the ANON role CAN READ THEM.
--                           => F-8 CONFIRMED EXPLOITABLE.
--   * public.voice_rooms    EXISTS; anon can read every row, including
--                           agora_channel_name.
--   * public.voice_room_messages  DOES NOT EXIST AT ALL.
--                           => migration 008 never applied. See Part D.
--   * get_unread_message_count / get_unread_count_by_partner /
--     mark_conversation_as_read / get_room_messages  DO NOT EXIST.
--                           => F-16 is NOT currently exploitable. Part C drops
--                              them defensively so re-applying 002 cannot
--                              reintroduce it.
--
-- ── THE INSTRUMENT USED FOR COLUMN LOCKDOWN, AND WHY IT CHANGED ─────────────
-- Migration 0005 used bare column-level REVOKE. Per the PostgreSQL REVOKE
-- documentation:
--
--     "On the other hand, if a role has been granted privileges on a table,
--      then revoking the same privileges from individual columns will have no
--      effect."
--
-- Supabase's stock default privileges GRANT ALL ON ALL TABLES IN SCHEMA public
-- TO anon, authenticated — a TABLE-level grant. So a bare column REVOKE against
-- it is a no-op. Every column lockdown in this file therefore uses the only
-- pattern that works against a table-level grant:
--
--     revoke <priv> on <table> from anon, authenticated;   -- drop table-level
--     grant  <priv> (<cols>) on <table> to authenticated;  -- re-grant narrowly
--
-- See 0010_fix_profiles_privilege_revoke.sql — the same defect affects 0005's
-- F-1 fix (self-grant of platform admin), which is the more urgent of the two.
--
-- IDEMPOTENT: every statement is guarded on object existence and safe to re-run.
-- `REVOKE` has no IF EXISTS and `DROP POLICY IF EXISTS` still requires the
-- table, so both live inside to_regclass() guards.
-- ============================================================================


-- ── Preflight ───────────────────────────────────────────────────────────────
-- Fail loudly rather than half-applying against a shape this file does not
-- describe.
do $$
begin
  if to_regclass('public.messages') is null then
    raise exception 'public.messages is missing — apply Frontend/supabase/migrations/003_profiles_and_chat.sql first';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'messages' and column_name = 'conversation_id'
  ) then
    raise exception
      'public.messages has no conversation_id — this database is on the 002 (sender/receiver) schema, '
      'which this migration does not describe. STOP and re-audit before applying.';
  end if;

  if to_regclass('public.conversations') is null then
    raise exception 'public.conversations is missing — apply 003_profiles_and_chat.sql first';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'conversations' and column_name = 'participant_1'
  ) then
    raise exception 'public.conversations is not the participant_1/participant_2 table this migration expects';
  end if;

  raise notice 'preflight OK: messages/conversations are on the expected 003 schema';
end $$;


-- ============================================================================
-- PART A — F-7: MESSAGE CONTENT FORGERY
-- ============================================================================
-- 003_profiles_and_chat.sql:100-106 creates:
--
--     CREATE POLICY "Users can update own messages" ON messages FOR UPDATE
--       USING (EXISTS (SELECT 1 FROM conversations
--                       WHERE id = conversation_id
--                         AND (participant_1 = auth.uid() OR participant_2 = auth.uid())));
--
-- With no WITH CHECK, Postgres reuses the USING clause. That constrains WHICH
-- ROW may be written and says nothing about WHICH COLUMNS. So either participant
-- could rewrite the OTHER party's message text after the fact, and sender_id was
-- writable too — i.e. a counterparty could retroactively edit what you said in a
-- commodity negotiation, or reattribute their own words to you. On a record
-- whose value is that it is evidence of what was agreed, this is severe.
--
-- The fix has two independent halves, because neither alone is sufficient:
--
--   1. COLUMN PRIVILEGES decide which columns may be written at all. A WITH
--      CHECK expression cannot express "content must not change" — it sees only
--      the NEW row, never the OLD one. This is the same lesson recorded in 0005;
--      the difference here is that the revoke is done in the form that actually
--      takes effect against Supabase's table-level default grant.
--
--   2. THE POLICY decides which rows. Narrowed from "either participant" to
--      "a participant who is NOT the sender", because the only legitimate client
--      write is the recipient flipping `read`.
--
-- Net effect for clients: the sole permitted UPDATE is
--     update messages set read = true where conversation_id = ... and sender_id <> me
-- which is exactly what Frontend/lib/supabase/master-helpers.ts markAsRead()
-- already does, so this is behaviour-preserving for the app as written.
do $$
begin
  -- Old, unbounded policy.
  execute 'drop policy if exists "Users can update own messages" on public.messages';
  -- Any earlier run of this migration.
  execute 'drop policy if exists messages_update_read_flag on public.messages';

  execute $p$
    create policy messages_update_read_flag on public.messages
      for update
      to authenticated
      using (
        sender_id <> auth.uid()
        and exists (
          select 1 from public.conversations c
           where c.id = messages.conversation_id
             and (c.participant_1 = auth.uid() or c.participant_2 = auth.uid())
        )
      )
      with check (
        -- Evaluated against the NEW row. Blocks reattributing a message to
        -- yourself even if the column grant below were ever restored.
        sender_id <> auth.uid()
        and exists (
          select 1 from public.conversations c
           where c.id = messages.conversation_id
             and (c.participant_1 = auth.uid() or c.participant_2 = auth.uid())
        )
      )
  $p$;

  -- Drop the TABLE-level UPDATE grant, then re-grant the one column that has a
  -- legitimate client write path. `content`, `sender_id`, `conversation_id`,
  -- `id` and `created_at` are now unwritable by any client, full stop.
  execute 'revoke update on public.messages from anon, authenticated';
  execute 'grant update (read) on public.messages to authenticated';

  raise notice 'F-7 closed: messages UPDATE restricted to the recipient, and to the `read` column only';
end $$;


-- ============================================================================
-- PART B — F-8: ANON CAN READ CHAT ON AN INVITE-ONLY PLATFORM
-- ============================================================================
-- 004_global_chat.sql:18-19 and 008_voice_room_chat.sql:21-22 both use
-- `FOR SELECT USING (true)` with no `TO authenticated`. A policy with no role
-- list applies to PUBLIC, so the `anon` role qualifies — and the anon key ships
-- in the browser bundle. CONFIRMED live: an unauthenticated request with the
-- published anon key returned real global_messages rows.
--
-- On an invite-only platform for commodity trading firms, the global chat
-- backlog is market intelligence. It is not public data.
--
-- Note the shape of the fix: the SELECT predicate stays `true`, only the ROLE
-- changes. Members keep exactly the access they have today; anonymous callers
-- lose all of it. The INSERT/DELETE policies are also re-scoped `TO
-- authenticated` — they were already unreachable by anon (auth.uid() is NULL,
-- and `NULL = sender_id` is NULL, not true) but relying on a NULL comparison to
-- do an access control job is how the next hole gets missed.

-- ── global_messages ─────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.global_messages') is null then
    raise warning 'public.global_messages NOT FOUND — F-8 global chat NOT closed. Investigate.';
    return;
  end if;

  execute 'drop policy if exists "Anyone can view global messages" on public.global_messages';
  execute 'drop policy if exists "Authenticated users can send global messages" on public.global_messages';
  execute 'drop policy if exists "Users can delete own global messages" on public.global_messages';
  execute 'drop policy if exists global_messages_select on public.global_messages';
  execute 'drop policy if exists global_messages_insert on public.global_messages';
  execute 'drop policy if exists global_messages_delete on public.global_messages';

  execute 'create policy global_messages_select on public.global_messages
             for select to authenticated using (true)';
  execute 'create policy global_messages_insert on public.global_messages
             for insert to authenticated with check (auth.uid() = sender_id)';
  execute 'create policy global_messages_delete on public.global_messages
             for delete to authenticated using (auth.uid() = sender_id)';

  -- Anon loses the table entirely, not merely the policy.
  execute 'revoke all on public.global_messages from anon';

  -- There is no UPDATE policy, so edits are already denied — but the same
  -- content-forgery reasoning as Part A applies, so remove the privilege too.
  -- A global chat message is a broadcast to every member; it must not be
  -- silently rewritten after the fact.
  execute 'revoke update on public.global_messages from anon, authenticated';

  raise notice 'F-8 closed for global_messages: SELECT scoped TO authenticated, anon revoked, UPDATE removed';
end $$;

-- ── direct messages: defence in depth ───────────────────────────────────────
-- The 003 policies on these two are already participant-scoped, so anon sees
-- nothing today. Revoking outright means an accidental `USING (true)` in some
-- future migration still cannot expose them to the browser-shipped key.
do $$
begin
  execute 'revoke all on public.messages from anon';
  execute 'revoke all on public.conversations from anon';
  raise notice 'anon revoked on messages and conversations';
end $$;

-- ── voice_rooms ─────────────────────────────────────────────────────────────
-- 005_voice_rooms.sql:31-32 — `USING (is_public = true)` with no role list.
-- CONFIRMED live: anon reads every public room, INCLUDING agora_channel_name.
-- That column is the channel identifier handed to the Agora SDK, and this
-- backend mints no Agora token — so the channel name is the closest thing to a
-- join credential that exists. Publishing it to unauthenticated callers is the
-- worst part of this finding, not the room names.
do $$
begin
  if to_regclass('public.voice_rooms') is null then
    raise warning 'public.voice_rooms NOT FOUND — skipped';
    return;
  end if;

  execute 'drop policy if exists "Public rooms viewable by all" on public.voice_rooms';
  execute 'drop policy if exists voice_rooms_select on public.voice_rooms';
  execute 'create policy voice_rooms_select on public.voice_rooms
             for select to authenticated using (is_public = true)';

  execute 'revoke all on public.voice_rooms from anon';
  -- Rooms are created and edited by the backend only.
  execute 'revoke insert, update, delete on public.voice_rooms from anon, authenticated';

  raise notice 'voice_rooms: SELECT scoped TO authenticated, anon revoked, writes backend-only';
end $$;

-- ── voice_participants ──────────────────────────────────────────────────────
-- Two problems in 005, both reachable with the anon key:
--
--   SELECT `USING (auth.role() = 'authenticated')` — any member could read the
--   participant list of EVERY room. services/voice.ts calls this out precisely:
--   on a platform whose premise is that counterparty identity is not revealed
--   pre-deal, a room's participant list says which firms are in the market for
--   what. Narrowed to: participants of PUBLIC rooms, plus your own rows.
--   Deliberately NOT "participants of any room I am in" — that predicate would
--   have to query voice_participants from inside voice_participants' own policy,
--   which recurses. Members needing the full list of a private room they belong
--   to go through GET /api/voice-rooms/:id/participants, which resolves it
--   server-side with the service-role key and the proper membership check.
--
--   INSERT `WITH CHECK (auth.uid() = user_id)` — checks WHO but not WHICH ROOM,
--   so any member could self-join a PRIVATE room straight from the browser,
--   bypassing assertRoomAccess() in services/voice.ts entirely. Narrowed to
--   public rooms; private-room membership is established server-side only.
do $$
begin
  if to_regclass('public.voice_participants') is null then
    raise warning 'public.voice_participants NOT FOUND — skipped';
    return;
  end if;

  execute 'drop policy if exists "Participants viewable by authenticated users" on public.voice_participants';
  execute 'drop policy if exists "Users can join rooms" on public.voice_participants';
  execute 'drop policy if exists "Users can leave rooms" on public.voice_participants';
  execute 'drop policy if exists "Users can update their status" on public.voice_participants';
  execute 'drop policy if exists voice_participants_select on public.voice_participants';
  execute 'drop policy if exists voice_participants_insert on public.voice_participants';
  execute 'drop policy if exists voice_participants_delete on public.voice_participants';
  execute 'drop policy if exists voice_participants_update on public.voice_participants';

  execute $p$
    create policy voice_participants_select on public.voice_participants
      for select to authenticated
      using (
        user_id = auth.uid()
        or exists (select 1 from public.voice_rooms r
                    where r.id = voice_participants.room_id and r.is_public)
      )
  $p$;

  execute $p$
    create policy voice_participants_insert on public.voice_participants
      for insert to authenticated
      with check (
        user_id = auth.uid()
        and exists (select 1 from public.voice_rooms r
                     where r.id = voice_participants.room_id and r.is_public)
      )
  $p$;

  -- Leaving is unconditional: a member must be able to leave a room even after
  -- their access to it has been revoked.
  execute 'create policy voice_participants_delete on public.voice_participants
             for delete to authenticated using (user_id = auth.uid())';

  execute 'create policy voice_participants_update on public.voice_participants
             for update to authenticated
             using (user_id = auth.uid()) with check (user_id = auth.uid())';

  -- Mute/speaking flags only. `user_id`, `room_id`, `id` and `joined_at` were
  -- all client-writable; rewriting user_id reassigns a presence row to someone
  -- else. (services/voice.ts already whitelists these two fields on the API
  -- path — this closes the direct-PostgREST path to the same table.)
  execute 'revoke update on public.voice_participants from anon, authenticated';
  execute 'grant update (is_muted, is_speaking) on public.voice_participants to authenticated';

  execute 'revoke all on public.voice_participants from anon';

  raise notice 'voice_participants: reads narrowed, self-join limited to public rooms, UPDATE limited to is_muted/is_speaking';
end $$;


-- ============================================================================
-- PART C — F-16: SECURITY DEFINER MESSAGING FUNCTIONS
-- ============================================================================
-- 002_messages_schema.sql:67-92,99-101 defines three SECURITY DEFINER functions
-- that take a user_id argument, never check `auth.uid() = user_id`, never set
-- search_path, and are explicitly GRANT EXECUTE ... TO authenticated. The third,
-- mark_conversation_as_read(user_id, partner_id), lets any member mark ANOTHER
-- user's messages as read — hiding incoming counterparty messages from them.
--
-- VERIFIED LIVE: none of the three exists. Migration 002 was never applied; the
-- deployed messages table is the 003 shape. So F-16 is NOT currently
-- exploitable, and this section is a guard rather than a fix.
--
-- They are DROPPED rather than repaired. Their whole model — messages carrying
-- sender_id/receiver_id directly — contradicts the deployed conversation-scoped
-- schema, so a repaired version would still be querying columns that do not
-- exist. The backend does this work correctly and scoped, at
-- GET /api/messages/unread-count and POST /api/messages/conversations/:id/read.
--
-- Dropping also means that if anyone ever runs 002 against this database, the
-- functions come back but the messages table does not change shape — so they
-- would be broken-and-visible rather than silently reintroducing the hole.
-- Re-running THIS migration removes them again.
--
-- ⚠️ DO NOT APPLY Frontend/supabase/migrations/002_messages_schema.sql.
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'get_unread_message_count',
         'get_unread_count_by_partner',
         'mark_conversation_as_read',
         'get_room_messages'   -- 008's equivalent; superseded by the API
       )
  loop
    execute format('drop function if exists %s', fn.sig);
    raise notice 'dropped superseded messaging function %', fn.sig;
  end loop;
end $$;

-- cleanup_old_global_messages() (004:38-48) is not SECURITY DEFINER, so RLS
-- still applies to the DELETE it performs and it is not currently a data-loss
-- vector. But Postgres defaults functions to EXECUTE TO PUBLIC, which makes it a
-- callable PostgREST RPC endpoint (POST /rest/v1/rpc/cleanup_old_global_messages)
-- for anyone holding the browser anon key. A history-truncating maintenance
-- routine should be operator-only regardless.
do $$
declare fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('cleanup_old_global_messages', 'cleanup_stale_participants')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', fn.sig);
    execute format('grant execute on function %s to service_role', fn.sig);
    raise notice 'locked down maintenance function %', fn.sig;
  end loop;
end $$;


-- ============================================================================
-- PART D — voice_room_messages DOES NOT EXIST
-- ============================================================================
-- Reported column-name disagreement: src/services/voice.ts writes `sender_id`,
-- Frontend/lib/supabase/voice.ts writes `user_id`, and 008_voice_room_chat.sql
-- declares `user_id`.
--
-- THE ANSWER IS THAT NEITHER HAS EVER WORKED. Verified live: the table is absent
-- from the database entirely (PostgREST PGRST205, "Could not find the table
-- 'public.voice_room_messages' in the schema cache"), and 008's get_room_messages
-- function is absent too. Migration 008 was never applied. Both the backend's
-- GET/POST /api/voice-rooms/:id/messages and the frontend's direct-Supabase
-- equivalent have been failing since they were written.
--
-- So the column name is a free choice, and it is settled here in favour of
-- `sender_id`, for two reasons:
--   * it matches `messages.sender_id` and `global_messages.sender_id`, so all
--     three chat surfaces share one shape and one Message type; and
--   * the backend is schema-of-record for migrations (master §7), and
--     services/voice.ts is the code that will actually run — the frontend must
--     route through the API rather than this table.
--
-- Created here rather than by applying 008, because 008 also carries the
-- `USING (true)` SELECT policy that is the other half of F-8. This version is
-- BACKEND-ONLY: RLS on, no policies at all, all client grants revoked. With RLS
-- enabled and no policy, every non-service role is denied by default. The
-- service-role key bypasses RLS, so services/voice.ts keeps working — and its
-- membership checks (assertRoomAccess + isParticipant) become the only way in,
-- which is the architecture rule rather than an exception to it.
do $$
begin
  if to_regclass('public.voice_rooms') is null then
    raise warning 'voice_rooms missing — cannot create voice_room_messages';
    return;
  end if;

  if to_regclass('public.voice_room_messages') is null then
    create table public.voice_room_messages (
      id           uuid primary key default gen_random_uuid(),
      room_id      uuid not null references public.voice_rooms(id) on delete cascade,
      sender_id    uuid not null references public.profiles(id) on delete cascade,
      content      text not null,
      created_at   timestamptz not null default now()
    );
    raise notice 'created public.voice_room_messages (sender_id)';
  else
    raise notice 'public.voice_room_messages already exists — leaving structure alone';
  end if;

  -- If an earlier/other run created the 008 shape, say so loudly rather than
  -- silently leaving the API broken. A WARNING, not an exception, so the rest of
  -- this migration's security fixes still land.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'voice_room_messages'
       and column_name = 'sender_id'
  ) then
    raise warning
      'voice_room_messages exists WITHOUT sender_id (probably the 008 `user_id` shape). '
      'GET/POST /api/voice-rooms/:id/messages will keep failing. '
      'Resolve manually before relying on voice room chat.';
  end if;

  execute 'create index if not exists idx_voice_room_messages_room_created
             on public.voice_room_messages (room_id, created_at desc)';

  execute 'alter table public.voice_room_messages enable row level security';
  -- No policies, deliberately: RLS on + zero policies = deny for every role
  -- except those that bypass RLS (service_role). The backend is the only
  -- intended accessor and it enforces room membership in code.
  execute 'revoke all on public.voice_room_messages from anon, authenticated';
  execute 'grant all on public.voice_room_messages to service_role';

  raise notice 'voice_room_messages: RLS on, no policies, backend-only';
end $$;


-- ============================================================================
-- PART E — PER-DEAL CONVERSATION THREADS
-- ============================================================================
-- The deployed `conversations` table is participant_1/participant_2 only, with
-- no deal_id — verified live — so a negotiation cannot be attached to the
-- transaction it is about.
--
-- `deal_id` is NULLABLE on purpose: a plain DM has no deal, and existing rows
-- must stay valid.
--
-- THE UNIQUE CONSTRAINT HAS TO CHANGE, and this is the part that is easy to miss.
-- 003 declares UNIQUE(participant_1, participant_2). With deal_id added, that
-- constraint would allow a pair of firms exactly ONE conversation in total —
-- so opening a thread on a second deal, or having both a DM and a deal thread,
-- would fail on a unique violation. Replaced with two PARTIAL unique indexes:
--
--   * one DM thread per pair            (where deal_id is null)
--   * one thread per pair per deal      (where deal_id is not null)
--
-- Note a plain UNIQUE(participant_1, participant_2, deal_id) would NOT do this
-- job: NULLs are distinct under a unique constraint by default, so it would
-- permit unlimited duplicate DM threads for the same pair.
do $$
declare
  con record;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'conversations' and column_name = 'deal_id'
  ) then
    if to_regclass('public.deals') is null then
      -- Still add the column, just without the FK, rather than skipping the
      -- feature entirely.
      alter table public.conversations add column deal_id uuid;
      raise warning 'public.deals not found — conversations.deal_id added WITHOUT a foreign key';
    else
      alter table public.conversations
        add column deal_id uuid references public.deals(id) on delete set null;
      raise notice 'added conversations.deal_id (nullable, FK to deals)';
    end if;
  else
    raise notice 'conversations.deal_id already present';
  end if;

  -- Drop the two-column UNIQUE constraint, found by shape rather than by name so
  -- this works regardless of what Postgres auto-named it.
  for con in
    select c.conname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and t.relname = 'conversations' and c.contype = 'u'
       and (
         select array_agg(a.attname::text order by a.attname)
           from unnest(c.conkey) k
           join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
       ) = array['participant_1','participant_2']
  loop
    execute format('alter table public.conversations drop constraint %I', con.conname);
    raise notice 'dropped superseded unique constraint %', con.conname;
  end loop;
end $$;

create unique index if not exists uq_conversations_dm_pair
  on public.conversations (participant_1, participant_2)
  where deal_id is null;

create unique index if not exists uq_conversations_deal_pair
  on public.conversations (participant_1, participant_2, deal_id)
  where deal_id is not null;

create index if not exists idx_conversations_deal
  on public.conversations (deal_id) where deal_id is not null;


-- ============================================================================
-- PART F — INDEXES FOR THE CONVERSATION-LIST QUERIES
-- ============================================================================
-- GET /api/messages/conversations previously embedded
-- `last_message:messages(content, created_at, sender_id)`, which is not "the
-- last message" — PostgREST returns the WHOLE child collection, so the response
-- carried every message of every conversation. Same unbounded-query class
-- already fixed in deals.ts and profiles/search. The service now issues bounded
-- per-conversation queries instead; these indexes are what keep that cheap.
create index if not exists idx_messages_conversation_created
  on public.messages (conversation_id, created_at desc);

-- Per-conversation unread pills: count of messages in a conversation not sent by
-- the caller and not yet read. Partial, because read messages are the majority
-- and never need to be scanned for this.
create index if not exists idx_messages_unread_by_conversation
  on public.messages (conversation_id, sender_id) where read = false;

-- Keyset pagination on global chat.
create index if not exists idx_global_messages_created_desc
  on public.global_messages (created_at desc);


-- ============================================================================
-- PART G — conversation_list(): the conversation index, in ONE round trip
-- ============================================================================
-- Replaces the PostgREST embed `last_message:messages(content, created_at,
-- sender_id)`, which did NOT return the last message — PostgREST returns the
-- whole child collection for an embed, so that response carried EVERY message of
-- EVERY conversation the caller had. Unbounded in both cost and disclosure, and
-- growing with usage.
--
-- Doing this correctly needs DISTINCT ON (the last message per conversation),
-- a grouped COUNT (per-conversation unread), and a join to profiles for the
-- counterparty — none of which PostgREST can express. The alternative is 2N+1
-- round trips from the service layer. This is one call.
--
-- ⚠️ SECURITY DEFINER WITH A p_user ARGUMENT — this is exactly the shape of
-- finding F-16 (Part C), so the grants below are not optional. Anyone who can
-- CALL this can read any user's conversation index, counterparty names and
-- unread counts. It is therefore revoked from public/anon/authenticated and
-- granted ONLY to service_role. The backend passes req.userId, taken from the
-- JWT that middleware/auth.ts already validated — never a client-supplied id.
-- This mirrors the grant model established for redeem_reward() in 0003.
--
-- `search_path` is pinned, which F-16's functions also omitted: without it a
-- SECURITY DEFINER function can be redirected to attacker-controlled objects by
-- a caller-set search_path.
--
-- Deliberately NOT returned: profiles.email or phone. A conversation list needs
-- a name and a face, not contact details.
create or replace function public.conversation_list(
  p_user  uuid,
  p_limit int default 50
)
returns table (
  id                      uuid,
  participant_1           uuid,
  participant_2           uuid,
  deal_id                 uuid,
  last_message_at         timestamptz,
  created_at              timestamptz,
  counterparty_id         uuid,
  counterparty_name       text,
  counterparty_company    text,
  counterparty_avatar_url text,
  unread_count            int,
  last_message_id         uuid,
  last_message_content    text,
  last_message_sender_id  uuid,
  last_message_created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with mine as (
    select c.id, c.participant_1, c.participant_2, c.deal_id,
           c.last_message_at, c.created_at
      from public.conversations c
     where c.participant_1 = p_user or c.participant_2 = p_user
     order by c.last_message_at desc nulls last
     -- Clamped in the database as well as at the route: this is the last line
     -- before the scan, and a future caller may not come through that route.
     limit greatest(least(coalesce(p_limit, 50), 100), 1)
  ),
  last_msg as (
    select distinct on (m.conversation_id)
           m.conversation_id, m.id, m.content, m.sender_id, m.created_at
      from public.messages m
      join mine on mine.id = m.conversation_id
     order by m.conversation_id, m.created_at desc
  ),
  unread as (
    select m.conversation_id, count(*)::int as n
      from public.messages m
      join mine on mine.id = m.conversation_id
     where m.read = false
       and m.sender_id <> p_user
     group by m.conversation_id
  )
  select mine.id,
         mine.participant_1,
         mine.participant_2,
         mine.deal_id,
         mine.last_message_at,
         mine.created_at,
         cp.id,
         cp.full_name,
         cp.company_name,
         cp.avatar_url,
         coalesce(unread.n, 0),
         last_msg.id,
         last_msg.content,
         last_msg.sender_id,
         last_msg.created_at
    from mine
    left join public.profiles cp
           on cp.id = case when mine.participant_1 = p_user
                           then mine.participant_2 else mine.participant_1 end
    left join last_msg on last_msg.conversation_id = mine.id
    left join unread   on unread.conversation_id   = mine.id
   order by mine.last_message_at desc nulls last;
$$;

revoke all on function public.conversation_list(uuid, int) from public, anon, authenticated;
grant execute on function public.conversation_list(uuid, int) to service_role;

comment on function public.conversation_list(uuid, int) is
  'Conversation index for one user: last message, unread count and counterparty profile in a single call. SECURITY DEFINER with a p_user argument — service_role ONLY; the backend supplies req.userId from a validated JWT.';


-- ============================================================================
-- VERIFICATION — run these after applying. Expected results are stated.
-- ============================================================================
--
-- 1. F-7 — clients may write ONLY messages.read.
--    Expect exactly one row: authenticated / UPDATE / read.
--
--    select grantee, privilege_type, column_name
--      from information_schema.column_privileges
--     where table_schema='public' and table_name='messages'
--       and privilege_type='UPDATE' and grantee in ('anon','authenticated');
--
-- 2. F-7 — the unbounded policy is gone and the narrow one is present.
--    Expect one row, policyname='messages_update_read_flag', with a non-null
--    with_check, and roles={authenticated}.
--
--    select policyname, roles, qual, with_check from pg_policies
--     where schemaname='public' and tablename='messages' and cmd='UPDATE';
--
-- 3. F-8 — no chat policy still applies to anon/public.
--    Expect ZERO rows.
--
--    select tablename, policyname, roles from pg_policies
--     where schemaname='public'
--       and tablename in ('global_messages','messages','conversations',
--                         'voice_rooms','voice_participants')
--       and ('anon' = any(roles) or 'public' = any(roles));
--
-- 4. F-8 — anon holds no privilege on any chat table. Expect ZERO rows.
--
--    select table_name, grantee, privilege_type from information_schema.table_privileges
--     where table_schema='public' and grantee='anon'
--       and table_name in ('global_messages','messages','conversations',
--                          'voice_rooms','voice_participants','voice_room_messages');
--
-- 5. F-8 — the live proof. From a shell, with the PUBLISHABLE/anon key:
--
--      curl -s "$SUPABASE_URL/rest/v1/global_messages?select=*&limit=1" \
--           -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"
--
--    BEFORE this migration this returned a real message row.
--    AFTER, expect: {"code":"42501", ... "permission denied for table global_messages"}
--
-- 6. F-16 — the three functions are absent. Expect ZERO rows.
--
--    select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--     where n.nspname='public' and proname in
--       ('get_unread_message_count','get_unread_count_by_partner','mark_conversation_as_read');
--
-- 7. Part D — the table now exists with sender_id. Expect one row: 'sender_id'.
--
--    select column_name from information_schema.columns
--     where table_schema='public' and table_name='voice_room_messages'
--       and column_name in ('sender_id','user_id');
--
--    And confirm it is closed to clients — expect relrowsecurity = true and
--    ZERO policies:
--    select relrowsecurity from pg_class where relname='voice_room_messages';
--    select count(*) from pg_policies where tablename='voice_room_messages';
--
-- 8. Part E — deal threads. Expect deal_id present and BOTH partial indexes.
--
--    select column_name, is_nullable from information_schema.columns
--     where table_schema='public' and table_name='conversations' and column_name='deal_id';
--
--    select indexname from pg_indexes
--     where schemaname='public' and tablename='conversations'
--       and indexname in ('uq_conversations_dm_pair','uq_conversations_deal_pair');
--
--    And that the old constraint is gone — expect ZERO rows:
--    select conname from pg_constraint where conrelid='public.conversations'::regclass and contype='u';
--
-- 9. Part G — conversation_list exists and is service_role-only.
--    Expect exactly one grantee: service_role.
--
--    select grantee, privilege_type from information_schema.routine_privileges
--     where routine_schema='public' and routine_name='conversation_list';
--
--    And it must be UNREACHABLE with the browser anon key — expect a 404
--    PGRST202 (not in schema cache) or 42501 permission denied, NEVER a result:
--
--      curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/conversation_list" \
--           -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" \
--           -H "Content-Type: application/json" \
--           -d '{"p_user":"<any user id>","p_limit":50}'
--
-- 10. Smoke-test the API after applying (a member's bearer token):
--       GET  /api/messages/conversations      -> 200, unread_count + counterparty present
--       GET  /api/messages/global?limit=20    -> 200, array
--       POST /api/messages/global {"content":"x"} -> 201
-- ============================================================================
