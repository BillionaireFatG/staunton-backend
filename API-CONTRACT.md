# Staunton Backend — API contract changes

Breaking changes to the contract that `Frontend/` and `Staunton Mobile/` consume. Everything here
is live on `master` in `Staunton Backend/`. Read this before touching any client code that calls
the affected endpoints.

Base URL: `http://localhost:3001` in dev.

---

## Error shape

All errors from this API, including the new ones below, are:

```jsonc
{
  "statusCode": 401,
  "error": "Unauthorized",       // name of the HTTP status
  "message": "Human-readable prose. Will change. Do not branch on it.",
  "code": "draft_token_missing"  // OPTIONAL, 4xx only. Stable. Branch on this.
}
```

`code` is new. It appears only on 4xx and only where a client plausibly needs to distinguish
causes. **Branch on `code`, never on `message`** — `message` is prose written for humans and will
be reworded. 5xx responses are deliberately opaque (`"An unexpected error occurred"`) and never
carry a `code`; the detail is in the server log.

Zod validation failures are `400` with a `details` array:

```jsonc
{
  "statusCode": 400,
  "error": "BadRequest",
  "message": "Request validation failed",
  "details": [{ "path": "primary_contact.email", "message": "Invalid email address" }]
}
```

---

## 1. `/api/applications/*` — now requires a signed draft token

### Why this changed

The application funnel is intentionally unauthenticated: a stranger with no account fills it in, so
there is no Supabase JWT to check. But every route under `/:orgId` treated the org UUID **in the URL
path** as proof that the caller owned that application. A UUID is an identifier, not a secret — it
is handed to the client, appears in URLs, and ends up in logs.

`GET /api/applications/:orgId` also loaded an organization at **any** status, not just drafts. So an
org id was enough to read a live, approved member firm's beneficial owners (full name, date of
birth, nationality, ownership percentage), its members' email addresses, and its uploaded document
records. Demonstrated against the dev database before the fix:

```
org.status      : full
beneficial owner: [{"name":"Jane Q Beneficial","dob":"1970-01-01","nat":"CH","pct":51}]
member emails   : ["cfo@livefirm.example"]
```

Two things changed as a result:

1. `GET /api/applications/:orgId` now serves **drafts only**. Anything past draft is `404`.
2. Every `/:orgId/*` route now requires a **signed draft token**.

### The token

- **Issued by:** `POST /api/applications` (starting an application). That is the *only* place it is
  minted. There is deliberately **no** "give me a token for org X" endpoint — anything reachable
  with just an org id would recreate the hole this closes.
- **Passed as:** the request header **`X-Application-Token`**. Header only. Never a query string —
  query strings land in logs, browser history and `Referer`.
- **Format:** opaque to clients (`stad1.<payload>.<hmac-sha256>`). Do not parse it. Store and replay
  it verbatim.
- **Bound to one org.** A token for org A is rejected for org B.
- **Expires after 14 days.** `expiresAt` (ISO-8601) is returned alongside it.
- **Not recoverable.** Lose it and the draft is unreachable — see *Client responsibilities*.

### Client responsibilities

Persist `token` the moment `POST /api/applications` returns, in storage that survives a page
reload — `sessionStorage` is not enough, an applicant will close the tab and come back. Key it by
`orgId`:

```ts
localStorage.setItem(`staunton.application.${orgId}`, JSON.stringify({ token, expiresAt }))
```

Send it on **every** subsequent `/api/applications/:orgId/...` call:

```ts
await fetch(`${API}/api/applications/${orgId}/company`, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json', 'X-Application-Token': token },
  body: JSON.stringify(patch),
})
```

Multipart uploads need it too — set the header, let the browser set `Content-Type`.

### Token error codes

| HTTP | `code` | When | Suggested client behaviour |
|---|---|---|---|
| 401 | `draft_token_missing` | No `X-Application-Token` header | Treat the draft as lost; offer to start a new application |
| 401 | `draft_token_invalid` | Malformed, wrong version, or bad signature | Same as missing — discard the stored token |
| 401 | `draft_token_expired` | Older than 14 days | Tell the applicant the session expired and start a new application |
| 403 | `draft_token_org_mismatch` | Valid token, but issued for a different org | A client bug (wrong token replayed). Discard and start over |

There is no refresh endpoint. An expired draft is started again from scratch.

### Endpoints

`POST` and `PATCH` bodies are JSON unless noted.

#### `POST /api/applications/validate-invite` — no token

Unchanged except for rate limiting.

- Request: `{ "code": "ABC123" }`
- Response `200`: `{ "valid": true, "email": string|null, "name": string|null }`
  or `{ "valid": false, "reason": "not_found" | "revoked" | "redeemed" | "expired" }`
- **Rate limit: 10 requests per 10 minutes per IP.** Exceeding it returns `429` with
  `code: "rate_limited"`. This is an unauthenticated oracle for "is this invite real", so the limit
  is deliberately tight. A human typing a code from an email will never reach it.

#### `POST /api/applications` — no token (this is what issues one)

- Request:
  ```jsonc
  {
    "inviteCode": "ABC123",                 // optional
    "legal_name": "Acme Trading Ltd",
    "jurisdiction": "CH",
    "primary_contact": { "email": "a@b.com", "full_name": "Ada Lovelace" }
  }
  ```
- Response `201` — **CHANGED, two new fields**:
  ```jsonc
  {
    "orgId": "uuid",
    "lane": "invited" | "applied",
    "token": "stad1....",                   // NEW — store this
    "expiresAt": "2026-08-15T12:00:00.000Z" // NEW
  }
  ```
- **Rate limit: 5 per hour per IP** (each call writes an `organizations` and a `members` row).

#### `GET /api/applications/:orgId` — token required

- Response `200`: `{ org, owners[], members[], documents[] }` (unchanged shape)
- **`404` if the application is not `status: "draft"`** — CHANGED. Previously returned the full
  payload at any status. `404` rather than `403` is deliberate: a distinguishing status code would
  make this an existence oracle for member org ids.
- `401` / `403` per the token table above.

#### `GET /api/applications/:orgId/status` — token required — **NEW**

Replaces what `GET /:orgId` used to give you after submission. Works at any status.

- Response `200`:
  ```jsonc
  {
    "orgId": "uuid",
    "legal_name": "Acme Trading Ltd",
    "status": "draft" | "pending" | "provisional" | "full" | "rejected",
    "lane": "invited" | "applied",
    "submitted_at": "2026-08-01T09:00:00.000Z" | null
  }
  ```

Status-only by design. It will **not** be widened to include owners, members or documents — that is
the leak described above. A post-submission review screen should show status, not the KYB file.

#### The remaining `/:orgId` routes — token required, bodies unchanged

| Method | Path | Notes |
|---|---|---|
| `PATCH` | `/api/applications/:orgId/company` | |
| `PATCH` | `/api/applications/:orgId/trading` | |
| `PATCH` | `/api/applications/:orgId/principal` | |
| `PATCH` | `/api/applications/:orgId/history` | |
| `POST` | `/api/applications/:orgId/owners` | `201` |
| `DELETE` | `/api/applications/:orgId/owners/:ownerId` | `204` |
| `POST` | `/api/applications/:orgId/members` | `201` |
| `POST` | `/api/applications/:orgId/documents` | multipart; **20 uploads/hour per IP** |
| `POST` | `/api/applications/:orgId/submit` | **10/hour per IP** |

All of them additionally return `409` if the application is no longer a draft (unchanged).

### Client migration checklist

- [ ] Capture `token` + `expiresAt` from `POST /api/applications` and persist per `orgId`.
- [ ] Add `X-Application-Token` to every `/api/applications/:orgId/...` request, multipart included.
- [ ] Handle the four token `code`s — all four mean "this draft is gone, start again".
- [ ] Handle `429` / `code: "rate_limited"` on `validate-invite`, start, upload and submit.
- [ ] Any post-submission screen currently calling `GET /:orgId` must call `GET /:orgId/status`.
- [ ] Drop any UI that displayed beneficial owners or member emails after submission — that data is
      no longer served to the applicant-facing funnel at all.

---

## 2. `/api/voice-rooms/*` — room authorization added, `VoiceRoom` shape corrected

Being authenticated used to be the whole check: any logged-in user could read any room by id, read
its full participant list, read its message history and post into it.

**New behaviour**

- `GET /api/voice-rooms` returns public rooms **plus** private rooms the caller has already joined.
  It previously filtered on `is_active`, a column that does not exist, so it returned a 500.
- `GET /:id`, `GET /:id/participants`, `GET /:id/messages`, `POST /:id/join` require access:
  the room is public, or the caller already has a participant row. **No access returns `404`, not
  `403`** — a 403 would confirm the room exists and let private rooms be enumerated.
- Private rooms **cannot be self-joined**. `POST /:id/join` on a private room the caller is not
  already in returns `404`. There is no invitation flow yet; this fails closed deliberately.
- `POST /:id/messages` now requires the caller to have **joined** the room: `403 "Join the room
  before posting a message"`. If your UI lets a user type into a room without joining, it must call
  `POST /:id/join` first.
- `PATCH /:id/status` accepts only `is_muted` and `is_speaking`, both booleans. Anything else is
  rejected with a `400`. It previously wrote the raw body into the row, so `{"user_id": "..."}`
  reassigned the participant row to another user.
- `GET /:id/messages?limit=` **must be 1–100** — `?limit=101` is a `400`, not a silent clamp.
  Default 50.

**`VoiceRoom` type changed** (`src/types/index.ts`) to match the deployed table. It declared
`topic`, `host_id` and `is_active` — none of which exist — and omitted every column that does:

```ts
{ id, created_at, name, category, emoji, description, is_public, agora_channel_name, participant_count? }
```

Known gap, not fixed: `agora_channel_name` is what clients hand to the Agora SDK, and this backend
mints no Agora token, so whatever authorizes the actual audio session is client-side and outside
these checks. A server-side Agora token service is the real fix.

Still broken, unrelated to this change: `voice_room_messages` does not exist in the deployed
database, so both message endpoints return 500 regardless.

---

## 3. `/api/messages/*` — unread count fixed, `Conversation`/`Message` shapes corrected

`GET /api/messages/unread-count` counted every unread message **on the entire platform** that the
caller had not sent. It now counts only messages in the caller's own conversations. Expect this
number to drop.

**`Conversation` and `Message` types changed** to match the deployed tables. The code assumed a
`participant_ids: string[]` column and a `messages.is_read` flag; the real table is a pair and the
flag is `read`. Every messaging endpoint was returning a PostgREST error before this.

```ts
Conversation { id, created_at, participant_1, participant_2, last_message_at, participants: string[], last_message?, unread_count? }
Message      { id, conversation_id?, room_id?, created_at, sender_id, content, read? }
```

`participants` is derived server-side (`[participant_1, participant_2]`) so clients have one field
to read. **If your code reads `conversation.participant_ids`, change it to `conversation.participants`.**
**If your code reads `message.is_read`, change it to `message.read`.**

Other changes:

- `POST /conversations` validates `recipient_id`: must be a UUID, must be an existing profile
  (`404 "Recipient not found"`), and must not be the caller (`400`).
- Conversations are now idempotent in both directions — `getOrCreate(A,B)` and `getOrCreate(B,A)`
  return the same row.
- **Non-participants now get `404`, not `403`,** on `GET /conversations/:id`,
  `POST /conversations/:id/messages` and `POST /conversations/:id/read`. Same enumeration-oracle
  reasoning as above.
- `GET /conversations/:id?limit=` **must be 1–100** (default 50) — out of range is a `400`, not a
  silent clamp; `before` must be an ISO-8601 datetime with an offset.

### New in this pass — requires migration `0009` to be applied

**⚠️ Until `migrations/0009_messaging_authz_hardening.sql` is applied, `GET /api/messages/conversations`
returns `503` with a message naming that migration.** It is not a code defect; the handler calls an
RPC the migration creates. Previously this surfaced as an opaque `500`.

**`GET /api/messages/conversations` no longer returns an unbounded embed.** The old `last_message`
field was a PostgREST embed, which returns the *entire* child collection — so the response carried
every message of every conversation on each render of the inbox. It is now genuinely the last
message, or `null`.

**If you are reducing `last_message` to the newest element client-side, delete that workaround once
0009 is applied.** The field is a single object or `null`.

```ts
ConversationSummary {
  id, participant_1, participant_2, participants: string[],
  deal_id: string | null,          // set on a deal thread, null on a plain DM
  deal_reference: string | null,   // e.g. "STN-…", for labelling. Reference only, no terms.
  last_message_at, created_at,
  unread_count: number,                 // per-conversation, for unread pills
  counterparty: { id, full_name, company_name, avatar_url } | null,
  last_message: { id, conversation_id, content, sender_id, created_at } | null
}
```

`counterparty` is `null` when that profile row has been deleted — handle it rather than assuming it
is present. It deliberately carries **no contact details**: a conversation list needs a name and a
face, not an email or a phone number.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `GET` | `/api/messages/global` | `?limit=1..100` (default 50), `?before=` ISO-8601 | `GlobalMessage[]`, oldest-first |
| `POST` | `/api/messages/global` | `{ content }` 1–4000 chars, strict | `201` `GlobalMessage` |
| `GET` | `/api/messages/deals/:dealId/conversation` | — | `Conversation` |
| `POST` | `/api/messages/deals/:dealId/conversation` | — | `201` `Conversation` |

**Global chat had no backend at all** — the browser talked to `global_messages` directly, which
breaks the three-layer rule, and that table's RLS policy was `USING (true)` with no role list.
Confirmed live: the browser-shipped anon key returned real global chat rows on an invite-only
platform. These endpoints are the supported path; `sender_id` is always the caller's id from the
validated JWT and is never read from the body.

`GlobalMessage { id, sender_id, content, created_at, sender: { id, full_name, company_name, avatar_url } | null }`

**Per-deal threads** attach a negotiation to the transaction it is about. Authorized against the deal
via the same predicate as `GET /api/deals/:id`, so a non-party gets `404` (not `403`) and the endpoint
is not an existence oracle for deal ids. `GET` and `POST` are the same find-or-create operation and
return the same body.

**A deal thread is a SEPARATE row from the plain DM between the same two people.** A pair of firms
may hold one DM plus one thread per deal simultaneously — enforced by two partial unique indexes
(one DM per pair; one thread per pair per deal). `GET /api/messages/conversations` returns **both**,
so an inbox will show two entries with the same counterparty name unless you distinguish them.
Use `deal_id` to tell them apart and `deal_reference` to label the deal thread. Do not merge them,
and do not present one as the other.

Two deliberate `409`s: a deal with no counterparty, and a deal with **more than one** counterparty
(buyer + seller + broker). The deployed `conversations` table is a two-column pair and cannot
represent a three-way thread; picking one party silently would produce a negotiation record missing a
participant, which is worse than no thread. Multi-party deal threads need a participants table.

**`voice_room_messages` column disagreement — resolved.** The backend used `sender_id`, the frontend
used `user_id`, and migration `008` declared `user_id`. **Neither has ever worked: the table does not
exist in the live database at all** (verified via PostgREST — `008` was never applied), so both
`GET/POST /api/voice-rooms/:id/messages` and the frontend's direct-Supabase equivalent have been
failing since they were written. `0009` creates it with **`sender_id`**, matching `messages` and
`global_messages` so all three chat surfaces share one shape. It is backend-only (RLS on, no policies,
all client grants revoked), so clients must go through the API.

---

## 4. `/api/profiles/*` — search bounded, projections corrected

`GET /api/profiles/search?q=&limit=100000` returned the entire member directory.

- **`q` is now required and must be at least 2 characters** (`400` otherwise). An empty `q` used to
  match every member.
- **`limit` must be 1–50** (default 20); `?limit=51` is a `400`. The client no longer chooses.
- LIKE metacharacters in `q` are escaped, so `?q=%` and `?q=__` no longer match everything.
- Search now also matches `company_name`, not just `full_name`.

**Response projection changed** for `GET /search` and `GET /:id`. They selected `trust_score`,
`is_verified` and `roles`, none of which exist on the deployed `profiles` table — both endpoints
were returning 500. Now:

```ts
// GET /api/profiles/search
{ id, full_name, company_name, avatar_url, verification_status, role }
// GET /api/profiles/:id
{ id, full_name, company_name, avatar_url, role, verification_status, bio }
```

`email`, `phone`, `location` and `is_admin` are deliberately **not** in either projection.

`PATCH /api/profiles/me` now rejects unknown keys with a `400` instead of silently ignoring them.
Accepted: `full_name`, `bio`, `avatar_url`, `company_name`, `phone`, `location`. **`roles` is no
longer accepted** — there is no such column, and `role` is set by admin flows, not self-service.

---

## 5. `/api/notifications/preferences` — strict body validation

`PUT /api/notifications/preferences` now parses its body against a strict schema instead of casting
it. **Unknown keys are a `400`** rather than being silently ignored — notably `user_id`, which a
client might send expecting it to select whose preferences are written. It never did; the caller's
own id is always used.

Accepted, all optional: `deal_updates`, `new_messages`, `price_alerts`, `weekly_digest`,
`marketing`, `desktop`, `sound`, `do_not_disturb`, `quiet_hours_enabled` (booleans),
`quiet_hours_start`, `quiet_hours_end` (strings, `HH:00`, on the hour only — `"09:30"` is a `400`).

An empty body `{}` is still valid and is a no-op that ensures the defaults row exists.

---

## 6. Rate limiting — now two layers, and keyed per account

Previously a single per-IP limit of 300/minute. Two things were wrong with that:

- **A shared office IP was a shared bucket.** A trading firm's whole desk egresses from one
  address, so one busy dashboard throttled everyone else at that firm.
- **It could not protect authentication.** The limiter attaches as a route-level hook, which runs
  *after* the `authenticate` hook. Every request had already cost a Supabase `getUser` round trip
  before the limiter saw it, so spraying invalid bearer tokens was unthrottled where it mattered.

**Now:**

| Layer | Runs | Keyed on | Default |
|---|---|---|---|
| 1 — pre-auth gate | before `authenticate` | client IP | 600 / minute |
| 2 — main limit | after `authenticate` | **account id**, falling back to IP when unauthenticated | 300 / minute |

Per-route limits (all layer 2, so all per account where the route is authenticated):

| Route | Limit |
|---|---|
| `POST /api/applications/validate-invite` | 10 / 10 min |
| `POST /api/applications` | 5 / hour |
| `POST /api/applications/:orgId/documents` | 20 / hour |
| `POST /api/applications/:orgId/submit` | 10 / hour |
| `GET /api/profiles/search` | 30 / min |
| `GET /api/deals/counterparties/search` | 30 / min |

`429` responses carry `code: "rate_limited"` and a `Retry-After` header, in the same body shape as
every other error.

**What this means for clients:** a logged-in user now gets their own budget rather than sharing one
with their colleagues, so legitimate concurrent use is far less likely to 429. The flip side is that
retrying with a different IP no longer resets anything. The two search endpoints are the tightest at
30/minute — if a UI does search-as-you-type against either, debounce it.

Both limits are per server process and held in memory, so neither holds across a multi-instance
deployment. This needs a shared (Redis) store before the API runs on more than one node.

---

## 7. `Profile` type corrected — three fields removed

`Profile` in `src/types/index.ts` declared `roles: string[]`, `is_verified: boolean` and
`trust_score: number` as **required**. None of the three exists on the deployed `profiles` table —
verified by querying the live database, not by reading migrations. Any client field typed against
them compiled fine and was always `undefined`.

They are gone. The singular `role` is the real column. `email`, `is_admin`, `updated_at` and
`verified_at` are real and have been added, but note that `email` and `is_admin` are returned **only**
by `GET /api/profiles/me` (the caller's own row) — never by `/search` or `/:id`.

**If your code reads `profile.roles`, `profile.is_verified` or `profile.trust_score`, it has never
had a value. Remove it, or render trust/verification from `verification_status`.**

---

## 8. `/api/subscriptions/*` — NEW (requires migration `0011`)

Foundation only. **There is no payment provider**; Stripe is an unmade commercial decision. Nothing
here charges anyone.

**Expect `POST /me` to return `409 plan_inactive` for every seeded plan.** That is the designed
behaviour, not a defect: no plan is sellable until real pricing is set, and a database `CHECK`
constraint enforces that an active plan has a real, non-placeholder price.

**Prices are `null`, not placeholder numbers.** Branch on `pricing_status`, never on the number. A
fabricated price is the one figure that must not reach a trading desk.

All routes require a JWT. **No route accepts an `org_id`** — the org is resolved server-side from the
caller's member row, the same rule `/api/access/permissions/check` follows.

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| `GET` | `/api/subscriptions/plans` | — | `SubscriptionPlan[]` |
| `GET` | `/api/subscriptions/me` | — | `OrgSubscription` (incl. resolved `entitlements`) |
| `GET` | `/api/subscriptions/entitlements` | — | `{ entitlements }` |
| `GET` | `/api/subscriptions/me/events` | `?limit=1..100` | audit rows; **admin only** |
| `POST` | `/api/subscriptions/me` | `{ plan_key, status?, reason? }` strict; `status` is `active` or `trialing` | `OrgSubscription` |
| `POST` | `/api/subscriptions/me/cancel` | `{ reason? }` strict | `OrgSubscription` |

```ts
SubscriptionPlan {
  id, key, name, description: string | null,
  price: number | null,            // null until real pricing is set. Never 0, never a guess.
  currency, interval,
  pricing_status: 'set' | 'not_set',
  is_active: boolean,              // sellable
  is_base: boolean,                // the fail-closed floor
  sort_order: number
}

OrgSubscription {
  org_id, plan_key, plan_name,
  status: 'none' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired',
  is_granting: boolean,            // gate features on THIS, not on the status string
  started_at, current_period_end, canceled_at,
  entitlements: Record<string, { type, value, source: 'base' | 'plan' }>
}
```

A firm that has never had a subscription returns `status: 'none'` with the base plan and base
entitlements — **not a `404`** — so clients render one shape.

**Entitlements are not permissions.** `has_permission` answers *what is your role*; entitlements
answer *what did your firm pay for*. They fail in opposite directions and neither is a proxy for the
other — check both where both apply.

**Reading entitlements fails closed.** No subscription, or any non-granting status (including
`past_due`), resolves to the base floor. An **absent key means not entitled**; unlimited is the
explicit value `{ "type": "limit", "value": null }`. Do not treat a missing key as permissive.

Ordinary members see only sellable plans from `GET /plans`; org and platform admins also see
unreleased ones. Changing a subscription requires an **org admin or platform admin** — `403`
otherwise. `409 concurrent_modification` means someone changed it at the same time: re-read and retry.

---

## 9. Environment

New backend env var, required — the server refuses to sign or verify a draft token without it:

| Variable | Purpose |
|---|---|
| `APPLICATION_TOKEN_SECRET` | HMAC secret for application draft tokens. ≥32 chars, unique per environment. |
| `TRUST_PROXY` | Optional. Set only when a proxy in front of this server rewrites `X-Forwarded-For`. Controls what `req.ip` resolves to for rate limiting and submission audit records. |

**Removed:** `JWT_SECRET`. This service never verified tokens itself — `src/middleware/auth.ts`
hands the bearer token to Supabase `getUser()` — so the variable was documented but unread. It has
been deleted from `.env.example`; delete it from any deployment environment too. `@fastify/jwt` and
`@fastify/websocket` have been removed from `package.json` for the same reason: both were installed,
neither was used, and `@fastify/websocket` was registered with no handler behind it.

No client-side env change.
