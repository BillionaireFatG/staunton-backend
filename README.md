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
| `npm test` | Run the test suite (`node:test` via `tsx`) — see below |
| `npm run seed:loyalty` | **Dev only.** Seed sample loyalty data — see below |
| `npm run verify:applications` | **Dev only.** Security regression harness for the public application funnel — see below |
| `npm run verify:redemption` | **Dev only.** Security regression harness for loyalty redemption — see below |

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

### Security regression harnesses

Both drive the real code against the real dev database, because the properties they check
(authorization holding in the write path, a route hook covering every route) cannot be demonstrated
with mocks. Both refuse to run with `NODE_ENV=production` and clean up the rows they create.

```bash
npm run verify:applications   # public application funnel: draft-token authz + rate limiting
npm run verify:redemption     # loyalty redemption: tier gate + atomic decrement
```

`verify:applications` covers the two application-funnel bugs — the draft-resume endpoint serving
live member firms, and every `/:orgId` route trusting the path parameter as proof of ownership. 27
checks: missing / tampered / garbage / expired / wrong-org tokens on the read path, nine `/:orgId`
routes called without a token (eight writes plus `GET /:orgId/status`), that no rejected write took
effect, that a correct token still resumes a draft, that a non-draft org yields no owner rows, and
that `validate-invite` throttles.

Gap worth knowing: `POST /:orgId/documents` is **not** in that loop, so the one multipart write is
unproven. It is gated by the same `preHandler` hook as the others, which is keyed on the presence of
an `:orgId` param rather than a route list, so it is covered by construction — but not by a test.

`verify:redemption` needs `npm run seed:loyalty` first, and **fails until migration `0003` is
applied** — redemption deliberately returns 503 rather than falling back to the read-then-write path
that allowed double-spend.

### Environment variables

All of these live in `.env` (git-ignored); `.env.example` is the tracked template.

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no (default 3001) | HTTP port |
| `HOST` | no (default 0.0.0.0) | Bind address |
| `NODE_ENV` | no | `development` / `production` |
| `SUPABASE_URL` | **yes** | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | Service-role key. Bypasses RLS — never expose to clients |
| `APPLICATION_TOKEN_SECRET` | **yes** | HMAC secret for public application draft tokens. ≥32 chars, unique per environment. The server refuses to sign or verify without it |
| `ALLOWED_ORIGINS` | **yes** | Comma-separated CORS origins |
| `APP_URL` | **yes** | Public app URL, used for approval setup / magic links |
| `TRUST_PROXY` | no | Set **only** when a proxy in front of this server rewrites `X-Forwarded-For`. Controls `req.ip`, which keys rate limiting and the submission audit record. Trusting the header with no proxy present lets any caller spoof both |
| `OPENSANCTIONS_API_KEY` | no | Sanctions/PEP screening. Without it, screening degrades to a pending "screen manually" check and never blocks submission |

There is deliberately **no `JWT_SECRET`**. It used to be listed here as required, and nothing has
ever read it: `src/middleware/auth.ts` passes the bearer token to Supabase `getUser()` and Supabase
does the verification. Remove it from any deployment environment that still sets it.

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

#### Known live drift (probed 2026-08-01, still outstanding)

The loyalty case was not the only one. Probing the dev database with the service-role key found
these; each one makes the listed endpoints return 500 today, so treat them as **broken, not
secured**:

| Code expects | Live database | Endpoints affected |
|---|---|---|
| `voice_rooms.is_active` | column does not exist (`is_public` is the real flag) | `GET /api/voice-rooms` |
| `voice_room_messages` table | does not exist | `GET`/`POST /api/voice-rooms/:id/messages` |
| `profiles.trust_score`, `profiles.is_verified`, `profiles.roles` | none exist (`role` singular and `verification_status` do) | `GET /api/profiles/search`, `GET /api/profiles/:id`, `GET /api/voice-rooms/:id/participants`, `GET /api/deals/counterparties/search`, `PATCH /api/profiles/me` when `roles` is sent |
| `notification_preferences` table | does not exist (`0001` never applied) | `/api/notifications/*` |

Authorization fixes have still been applied to these paths. An endpoint that is broken today is not
a reason to leave it unauthorized tomorrow — the moment the drift is repaired, the missing check
would have become live. Resolving the drift is a separate piece of work and needs a decision on
which side moves (add the columns, or change the code to the deployed shape).

### Objects this backend requires but does NOT own

These are defined in **`Frontend/supabase/migrations/`**, a different git repository. Changing or
dropping any of them breaks this API, and nothing in this repo will warn you.

**Functions called via `supabase.rpc()`**

| Object | Defined in |
|---|---|
| `approve_organization(p_org, p_admin_member)` | `015_approval.sql` |
| `promote_to_full(...)` | `016_onboarding.sql` |
| `org_status_permits(p_status, p_permission)` | `017_roles_badges.sql` |
| `has_permission(...)` | originally `017_roles_badges.sql` — **now owned here**, see below |

> **`has_permission` has moved to this repo.** `migrations/0004_scope_has_permission.sql`
> `CREATE OR REPLACE`s it to close a cross-tenant privilege escalation: the 017 definition joined
> `member_roles` without filtering on `org_id`, so a role granted inside one org satisfied a
> permission check asked about **any other org**. **Do not re-apply `017_roles_badges.sql` after
> `0004`** — it would silently reinstate the vulnerable definition. If 017 must be re-run for its
> tables or triggers, re-apply `0004` immediately afterwards.

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

| File | Contents | Applied? |
|---|---|---|
| `0001_notification_preferences.sql` | Creates `public.notification_preferences` (one row per user, backs Settings → Notifications) | **No** — table still absent from the live database (verified 2026-08-02) |
| `0002_profiles_value_fields.sql` | Idempotent `add column if not exists` for `profiles.company_name`, `phone`, `location` and the verification-request fields | Partially — see drift note below |
| `0003_redeem_reward_atomic.sql` | Atomic `redeem_reward` RPC (tier gate + single-statement point decrement) | Yes |
| `0004_scope_has_permission.sql` | **Security.** Scopes `has_permission` role grants by `org_id` | Yes |
| `0005_emergency_rls_hardening.sql` | **Security.** RLS hardening sweep. Its `profiles` column REVOKEs were **INERT** — see `0010` | Yes (but partly ineffective) |
| `0007_fix_loyalty_tier_rank_cast.sql` | Fixes the enum cast in `loyalty_tier_rank` | Yes |
| `0008_fix_redeem_ambiguous_column.sql` | Fixes `column reference "available_points" is ambiguous` in `redeem_reward` | Yes |
| `0009_messaging_authz_hardening.sql` | **Security + functional.** Message-forgery lockdown, anon revoke on chat, `conversations.deal_id`, `conversation_list()`, creates `voice_room_messages` | **NO — APPLY FIRST. See below.** |
| `0010_fix_profiles_privilege_revoke.sql` | **Security.** Repairs `0005`'s inert column REVOKE (self-grant of platform admin) | Yes — adversarially verified |
| `0011_subscriptions_foundation.sql` | Subscription plans, key/value entitlements, atomic state changes. No payment provider | **No** — apply after `0009` |
| `0012_profiles_pii_select_lockdown.sql` | **Security (CRITICAL).** Revokes anon SELECT on `profiles` (live PII leak), restricts base-table SELECT to own-row + admin, adds the `public_profiles` subset view | **No** — pilot batch, apply FIRST |
| `0013_profiles_membership_columns.sql` | **Gate.** Adds `profiles.member_status` (default `none`) + `member_tier` — the columns the frontend auth gate reads | **No** — pilot batch |
| `0014_profiles_write_lockdown_verification.sql` | **Security.** Locks `verification_status` / `verification_requested_at` / `member_status` / `member_tier` to service-role writes (supersedes `0010`'s writable list) | **No** — pilot batch, apply after `0010`+`0013` |
| `0015_deals_write_lockdown.sql` | **Security (financial).** Revokes all client INSERT/UPDATE/DELETE on `deals`/`deal_events`/`inspections` (reprice + mass-assignment). Reads/realtime retained | **No** — pilot batch |
| `0016_avatars_bucket_hardening.sql` | **Security.** Closes anon bucket listing, sets 5 MB + image-only limits, restores owner-scoped avatar writes | **No** — pilot batch |

There is no migration runner wired up — these are applied by hand against Supabase, and nothing
verifies that they have been. Every file here is written to be **idempotent and safe to re-run**;
when you apply one, tick it off in the table above.

### ⚠️ Pending: apply `0009`, then `0011`

**`0009` is both a live security hole and the reason chat is currently broken.** Apply it first.

**Why it is urgent — confirmed by exploit, not by reading policy source.** With two real logged-in
user tokens against the live database, one conversation participant rewrote the other party's
message and reattributed it to himself. The stored row came back
`content = "FORGED: offer 500t at 200.00"` (was `973.25`), `sender_id` = the attacker. In plain
terms: **one member can silently rewrite another member's message and change who it came from**, on
a platform whose proposition is that the record is worth something to a counterparty. Separately,
the browser-shipped publishable key can read `global_messages.content` and
`voice_rooms.agora_channel_name` — and this backend mints no Agora token, so that channel name is
the closest thing to a join credential that exists.

**Why chat is broken:** `GET /api/messages/conversations` calls `conversation_list()`, which `0009`
creates. Until it is applied the endpoint returns `503` naming the migration.

```
1. Paste migrations/0009_messaging_authz_hardening.sql into the Supabase SQL editor and run it.
   Expect: "preflight OK: messages/conversations are on the expected 003 schema",
   then NOTICE lines for F-7, F-8, F-16, voice_room_messages, and deal threads.
   A WARNING about a missing table means that part was skipped — read it, do not ignore it.

2. npm run verify:messaging
```

`verify:messaging` detects whether `0009` is applied and flips its expectations, so it is meaningful
before *and* after. **Run it before applying too, and keep both outputs** — the pair is the evidence,
either alone is not. Before, every exploit must reproduce; after, every exploit must be denied *and*
the one legitimate client write (a recipient marking messages read) must still work.

**Do not accept "the migration ran without error" as proof.** That is exactly how `0005` shipped
inert: it printed a success notice and changed nothing, leaving the most severe finding in the audit
open. A pre-migration *denial* is scored as a FAILURE by the harness precisely so it cannot pass
vacuously.

Then, when convenient:

```
3. Paste migrations/0011_subscriptions_foundation.sql and run it.
   Expect: "preflight OK: organizations present", then notices for the seed and the lockdown.

4. npm run verify:subscriptions      (exits 2 if 0011 is not applied)
```

`0011` seeds every paid plan **inactive with no price**, so `POST /api/subscriptions/me` returns
`409 plan_inactive` for all of them. That is the designed behaviour — nothing is sellable until you
set real pricing. A `CHECK` constraint enforces that activating a plan requires a real,
non-placeholder price, so the guarantee survives a stray `UPDATE`.

Both verification scripts need `PROBE_ANON_KEY` in `.env` (the publishable key from
`Frontend/.env.local` — not a secret; it already ships in the browser bundle). Without it they
cannot ask the question that matters: what an unauthenticated caller can reach.

### 🚨 Pending: the pilot security batch (`0012`–`0016`)

Five migrations that close confirmed-live holes blocking the pilot. All are idempotent and
self-contained. **Apply them by hand in the Supabase SQL editor, in this order:**

```
0012_profiles_pii_select_lockdown.sql        # WORST — anon reads every member's email. Apply FIRST.
0013_profiles_membership_columns.sql         # adds member_status / member_tier (the gate's columns)
0014_profiles_write_lockdown_verification.sql# locks the self-settable "verified" flag + the gate columns
0015_deals_write_lockdown.sql                # deals reprice / mass-assignment
0016_avatars_bucket_hardening.sql            # anon bucket listing + size/MIME limits
```

Order matters: `0014` re-grants the profiles write surface and must run **after** `0013` adds
`member_status`/`member_tier` (so they end up excluded from the writable set) and after `0010`.
`0012`/`0015`/`0016` are independent and may be applied in any order relative to each other.

Each migration ends with expected output and copy-paste verification SQL. A `NOTICE` is progress;
a `WARNING` means a guarded step was skipped (a table/function was absent) — read it, do not ignore
it, exactly as with `0005`/`0009`.

**Prove it, before and after — do not accept "it ran without error" (that is how `0005` shipped
inert):**

```
npm run verify:profiles   # 0012 + 0013 + 0014 + the upsertProfile 500 regression + admin reads
npm run verify:deals      # 0015 — reprice / fabricate blocked, backend write + reads still work
npm run verify:avatars    # 0016 — anon cannot list, limits set, owner-scoped writes
```

Each harness **detects whether its migration is applied and flips expectations**: run it BEFORE
(every exploit must reproduce against the live DB with a real anon/authenticated token) and AFTER
(every exploit denied `42501`, every legitimate path still works). Keep both outputs — the pair is
the evidence. They need `PROBE_ANON_KEY`, create + delete their own throwaway users/objects, and
refuse `NODE_ENV=production`.

**Cross-layer follow-ups these create for the frontend lane** (documented so nothing breaks
silently — the backend service role is unaffected because it bypasses RLS):

| After | These direct-Supabase client calls stop working — reroute to |
|---|---|
| `0012` | cross-member `profiles` reads (`GlobalSearch`, `profile/[userId]`, deals counterparty join, `master-helpers`) → `public_profiles` view **or** `GET /api/profiles/:id` / `GET /api/profiles/search`. Own-row reads (middleware gate) and sign-in are **not** affected. |
| `0014` | `master-helpers.ts requestVerification` browser write of `verification_status` → `POST /api/profiles/me/verify` (already implemented). |
| `0015` | `lib/supabase/deals.ts updateDeal()` → `PATCH /api/deals/:id`; `createDealEvent()` → `POST /api/deals/:id/events`. Deal reads/realtime unaffected. **Not a transport swap** — the backend create/update contract is narrower than the create wizard collects (no `currency`/`tank_farm`/dates/`vessel_name`, no seller-initiated path; PATCH is `{status, notes}` only). Cutting over means widening the backend contract **or** narrowing the wizard, a product decision that overlaps the deal-spine redesign (MASTER §3) — its own initiative. Applying `0015` kills in-app deal create/update until that lands; low-cost now (no pilot deals yet) and the reprice hole is why it should be prioritised, not deferred. |

**`member_status` values (frontend contract):** `none | invited | applied | in_review | approved |
rejected | suspended`, default `none`. Only `approved` opens `/dashboard`. `member_tier`:
`principal | direct_mandate` or `NULL`. Existing rows default to `none`, so a pilot member must be
moved to `approved` (admin / vetting flow, service-role write) to reach the dashboard.

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
