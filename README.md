# Staunton Backend

Fastify + TypeScript API for Staunton Trade. This service is the **only** layer that talks to
Supabase for data. The Next.js frontend and the Expo mobile app call this API; they use Supabase
directly for **authentication only**.

```
Frontend (:3000) ─┐
                  ├─→  Staunton Backend (:3001)  ─→  Supabase
Mobile (Expo)   ──┘         (service-role key)
```

Because the backend connects with the Supabase **service-role key, RLS is bypassed**.
Authorization is therefore this codebase's responsibility: every read and write must check
ownership/membership in the service layer. RLS policies in the database are a backstop for
direct client access, not a control this API benefits from.

---

## Getting started

```bash
npm install
cp .env.example .env     # then fill in the values below
npm run dev              # tsx watch, http://localhost:3001
```

| Script | Does |
|---|---|
| `npm run dev` | Dev server with reload (`tsx watch src/server.ts`) on **:3001** |
| `npm run build` | Type-check and emit to `dist/` (`tsc`) |
| `npm start` | Run the built server (`node dist/server.js`) |
| `npm run seed:loyalty` | **Dev only.** Seed sample loyalty data — see below |

`npm run build` must pass before anything ships.

### Dev seed data

`scripts/seed-loyalty.ts` puts one realistic `user_loyalty` row (gold tier) plus sample
`loyalty_transactions` against an existing dev account, because those tables ship empty and
`getUserLoyalty()` 404s without them — which makes every loyalty endpoint untestable.

```bash
npm run seed:loyalty                                    # default dev account
SEED_USER_EMAIL=someone@example.com npm run seed:loyalty
```

It is idempotent (fixed row ids; re-run to reset `available_points` between redemption tests),
additive (never drops or deletes), refuses to run with `NODE_ENV=production`, and labels every row
it writes `[DEV SAMPLE]`. It also inserts one deliberately **inactive** reward so the missing
`is_active` filter in `getRewards()` is visible rather than theoretical. `scripts/` is outside
`tsconfig`'s `include`, so it is not part of `npm run build`.

### Environment variables

All of these live in `.env` (git-ignored); `.env.example` is the tracked template.

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no (default 3001) | HTTP port |
| `HOST` | no (default 0.0.0.0) | Bind address |
| `NODE_ENV` | no | `development` / `production` |
| `SUPABASE_URL` | **yes** | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | Service-role key. Bypasses RLS — never expose to clients |
| `JWT_SECRET` | **yes** | Must match the Supabase JWT secret; used to validate client tokens |
| `ALLOWED_ORIGINS` | **yes** | Comma-separated CORS origins |
| `APP_URL` | **yes** | Public app URL, used for approval setup / magic links |
| `OPENSANCTIONS_API_KEY` | no | Sanctions/PEP screening. Without it, screening degrades to a pending "screen manually" check and never blocks submission |

---

## Layout

```
src/
  server.ts              entry point; registers every route module
  middleware/
    auth.ts              validates the Supabase JWT, sets req.userId
    requireAdmin.ts      platform-admin / org-admin gate
    errorHandler.ts      global Fastify error handler
  lib/supabase.ts        service-role client (bypasses RLS)
  types/index.ts         shared types consumed by frontend + mobile
  services/              one module per domain: business logic + all data access
  routes/                one file per domain: thin handlers that call services
migrations/              schema this backend owns (see below)
```

Route prefixes registered in `server.ts`: `/api/deals`, `/api/loyalty`, `/api/voice-rooms`,
`/api/profiles`, `/api/messages`, `/api/applications`, `/api/admin/vetting`, `/api/onboarding`,
`/api/access`, `/api/notifications`.

Conventions: validate input at the route boundary, keep handlers thin, put logic in `services/`,
scope every write to `req.userId` (never a client-supplied id), and raise structured errors for the
global handler rather than ad-hoc throws.

---

## Database schema & dependencies

### The live Supabase database is the source of truth

Schema for this project is currently split across two repositories, and neither migration folder is
a complete description of the deployed database. **When they disagree, the live database wins** —
verify against it (a read-only PostgREST query with the service-role key is enough) before assuming
a table or column exists.

This is not theoretical. The loyalty service originally queried a `loyalty` table with
`points_earned` / `points_redeemed` / `points_balance` columns. No migration in either repo defines
those, and the deployed database does not have them — the real objects are `user_loyalty`
(`total_points`, `available_points`, `lifetime_points`) and `reward_redemptions`. Every loyalty
endpoint was dead until that drift was corrected.

### Objects this backend requires but does NOT own

These are defined in **`Frontend/supabase/migrations/`**, a different git repository. Changing or
dropping any of them breaks this API, and nothing in this repo will warn you.

**Functions called via `supabase.rpc()`**

| Object | Defined in |
|---|---|
| `approve_organization(p_org, p_admin_member)` | `015_approval.sql` |
| `promote_to_full(...)` | `016_onboarding.sql` |
| `has_permission(...)` | `017_roles_badges.sql` |

**View**

| Object | Defined in |
|---|---|
| `admin_application_queue` | `015_approval.sql` |

**Badge-grant triggers** — badges are awarded by the database, not by this API. The backend reads
the resulting rows and assumes they are kept current.

| Object | Defined in |
|---|---|
| `evaluate_org_badges()` + trigger `verification_checks_evaluate_badges` | `017_roles_badges.sql` |
| `revoke_expired_badges()` | `017_roles_badges.sql` |
| `roles` / `role_permissions` / `badge_definitions` seed data | `018_roles_badges_seed.sql` |

**Tables**

| Domain | Tables | Defined in |
|---|---|---|
| Trading | `deals`, `deal_events`, `inspections` | `006_deals_and_tracking.sql`, superseded by `011_fix_deals_schema.sql` |
| Profiles | `profiles`, `verification_requests` | `003_profiles_and_chat.sql` (plus this repo's `0002`) |
| Messaging | `conversations`, `messages` | `003_profiles_and_chat.sql` |
| Voice | `voice_rooms`, `voice_participants` | `005_voice_rooms.sql` |
| Voice chat | `voice_room_messages` | `008_voice_room_chat.sql` |
| Loyalty | `user_loyalty`, `loyalty_transactions`, `rewards`, `reward_redemptions`, `achievements`, `user_achievements` | `007_loyalty_rewards.sql` |
| Vetting | `organizations`, `members`, `invitations`, `beneficial_owners`, `verification_checks`, `application_documents`, `video_interviews`, `screening_results`, `interview_questions` | `013_vetting_core.sql` |
| Onboarding | `org_profiles`, `financial_capacity`, `onboarding_progress` | `016_onboarding.sql` |
| Roles & badges | `roles`, `role_permissions`, `member_roles`, `badge_definitions`, `org_badges`, `listing_badges` | `017_roles_badges.sql` |

`verification_checks` is append-only, enforced by `verification_checks_no_update` /
`verification_checks_no_delete` triggers (`013_vetting_core.sql`). Do not attempt updates or
deletes against it.

**Storage:** the `avatars` bucket (`009_avatars_storage.sql`) is used via `supabase.storage`, not
as a table.

### Objects this backend does own

`migrations/` in this repo currently holds only two files:

| File | Contents |
|---|---|
| `0001_notification_preferences.sql` | Creates `public.notification_preferences` (one row per user, backs Settings → Notifications) |
| `0002_profiles_value_fields.sql` | Idempotent `add column if not exists` for `profiles.company_name`, `phone`, `location` and the verification-request fields |

There is no migration runner wired up — these are applied by hand against Supabase.

### Recommendation: make the backend the schema-of-record

The backend is the only layer that reads or writes application data, but it owns almost none of the
schema it depends on. That inversion is what produced the loyalty drift above, and it will keep
producing drift: schema can change in `Frontend/` with no signal here, and this repo has no
migration for the majority of the tables it queries.

Going forward, **new schema should land in this repo's `migrations/`**, starting with the
Phase 2 `listings` migration. The existing 18 frontend migrations should be left where they are
rather than copied — duplicating them would create two competing histories and make the drift
problem worse. The intended end state is: `Frontend/supabase/migrations/` frozen as the historical
record, `Staunton Backend/migrations/` as the place all new schema is authored, and a migration
runner added when the first change to an existing frontend-owned table becomes necessary.

---

## API contract notes

`src/types/index.ts` is the shared contract. Clients (`Frontend/`, `Staunton Mobile/`) depend on
these shapes, so a change here is a breaking change for them — call it out when you make one.

Known outstanding mismatch: `Frontend/lib/vetting-api.ts` declares `LoyaltyState` with
`points_earned` / `points_redeemed` / `points_balance`, which no longer match what
`GET /api/loyalty/me` returns (`total_points` / `available_points` / `lifetime_points`). That needs
a follow-up in the frontend repo.
