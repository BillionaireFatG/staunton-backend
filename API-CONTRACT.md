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

## 2. Global rate limiting

All routes are now behind a per-IP limit of **300 requests/minute**, with the tighter per-route
limits listed above. `429` responses carry `code: "rate_limited"` and a `Retry-After` header.

The limit is per server process and held in memory, so it does not currently hold across a
multi-instance deployment.

---

## 3. Environment

New backend env var, required — the server refuses to sign or verify a draft token without it:

| Variable | Purpose |
|---|---|
| `APPLICATION_TOKEN_SECRET` | HMAC secret for application draft tokens. ≥32 chars, unique per environment. |
| `TRUST_PROXY` | Optional. Set only when a proxy in front of this server rewrites `X-Forwarded-For`. Controls what `req.ip` resolves to for rate limiting and submission audit records. |

No client-side env change.
