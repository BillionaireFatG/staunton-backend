-- 0001_notification_preferences.sql
-- Notification preferences: one row per user, backing Settings > Notifications.
-- Column defaults mirror the toggle defaults the frontend UI currently renders:
--   Email:  deal_updates=true, new_messages=true, price_alerts=true,
--           weekly_digest=false, marketing=false
--   Push:   desktop=true, sound=true, do_not_disturb=false
--   Quiet:  quiet_hours_enabled=false, quiet_hours_start='22:00', quiet_hours_end='07:00'
--
-- RLS note: the Fastify backend talks to Supabase with the service-role key,
-- which bypasses RLS. Authorization (scoping every read/write to the
-- authenticated user_id) is enforced in the backend service layer, not here.
-- No RLS policies are authored so as not to interfere with the service-role
-- client; add per-user policies only if clients are ever given direct access.

create table if not exists public.notification_preferences (
  user_id             uuid primary key references auth.users(id) on delete cascade,

  -- Email
  deal_updates        boolean not null default true,
  new_messages        boolean not null default true,
  price_alerts        boolean not null default true,
  weekly_digest       boolean not null default false,
  marketing           boolean not null default false,

  -- Push
  desktop             boolean not null default true,
  sound               boolean not null default true,
  do_not_disturb      boolean not null default false,

  -- Quiet hours (HH:00, 24h)
  quiet_hours_enabled boolean not null default false,
  quiet_hours_start   text    not null default '22:00',
  quiet_hours_end     text    not null default '07:00',

  updated_at          timestamptz not null default now()
);
