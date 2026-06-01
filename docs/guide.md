# Supabase Integration Guide

Deep reference for `w3-io/w3-supabase-action`. The [README](../README.md) is the quick-start; this guide covers every command's full input and output schema, filter semantics, error handling, and operational gotchas.

## What is Supabase?

[Supabase](https://supabase.com) is an open-source backend-as-a-service built on Postgres. It gives you a managed Postgres database, user authentication (GoTrue), object storage (S3-compatible), realtime subscriptions, and Edge Functions (Deno-based serverless) — all behind a single API key per project.

For W3 workflows, Supabase fits four common patterns:

- **Off-chain structured state** — workflows often need a place to log audit trails, accumulate intermediate state, or read configuration. Postgres + Row Level Security gives you multi-tenant-safe storage with no infrastructure to operate.
- **Auth gating** — workflows triggered by end users can validate the caller's JWT, branch on user role / metadata, and operate within the user's permission scope.
- **Artifact storage** — workflows that produce files (reports, exports, generated assets) upload them to Storage and share via time-limited signed URLs.
- **Pre/post-processing** — Edge Functions are good for transformations that benefit from being close to your database (low-latency reads, secret access).

## Authentication

Every command takes two required inputs:

- `url` — your project URL, e.g. `https://abcdefghij.supabase.co`
- `key` — a Supabase API key

There are two key types, each suited to different commands:

| Key type         | Where to find it                                            | Security posture                                                              | Use it for                                                                |
| ---------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **service-role** | Supabase dashboard → Settings → API → `service_role` secret | Full admin; bypasses Row Level Security. **Treat it like a master password.** | Server-side workflows — database CRUD, storage management, admin auth ops |
| **anon**         | Supabase dashboard → Settings → API → `anon` public key     | Subject to Row Level Security. Safe to ship to end users.                     | Client-style auth flows (sign-up, sign-in, password reset)                |

The `key-type` input on the action is informational — Supabase itself enforces which key is needed for which operation based on the call. The README's [Picking the right key](../README.md#picking-the-right-key) table maps each command family to the recommended key.

Store keys as W3 workflow secrets (or GitHub Actions secrets if running as a GHA) and reference them with `${{ secrets.NAME }}`.

## Commands

All commands share these two required inputs: `url` and `key`. The sections below document the command-specific inputs and output shapes.

### Database

PostgREST-backed CRUD against your project's database. All database commands accept `schema` (defaults to `public`).

---

#### `query` — select rows

| Input    | Type            | Required | Description                                                                   |
| -------- | --------------- | -------- | ----------------------------------------------------------------------------- |
| `table`  | string          | yes      | Table name                                                                    |
| `schema` | string          | no       | Default `public`                                                              |
| `filter` | JSON string     | no       | Filter object (see [Filter syntax](#filter-syntax))                           |
| `select` | string          | no       | PostgREST select string, default `*`. Supports joins: `"id,user(name,email)"` |
| `order`  | JSON string     | no       | Array of `{column, ascending, nullsFirst}`                                    |
| `limit`  | string (number) | no       | Max rows                                                                      |
| `offset` | string (number) | no       | Rows to skip                                                                  |

**Output:**

```json
{ "rows": [...], "count": 3 }
```

`count` is the length of `rows`, not a total-row count (for that, use `count` command).

---

#### `insert` — add rows

| Input         | Type                    | Required | Description                          |
| ------------- | ----------------------- | -------- | ------------------------------------ |
| `table`       | string                  | yes      | Table name                           |
| `schema`      | string                  | no       | Default `public`                     |
| `data`        | JSON string             | yes      | Object or array of objects           |
| `return-rows` | string (`true`/`false`) | no       | Return inserted rows. Default `true` |

**Output:**

```json
{ "rows": [...], "count": N }
```

When `return-rows: false`, `rows` may be empty (`count` reflects what Postgres reports).

---

#### `upsert` — insert or update on conflict

| Input         | Type        | Required | Description                                                            |
| ------------- | ----------- | -------- | ---------------------------------------------------------------------- |
| `table`       | string      | yes      |                                                                        |
| `schema`      | string      | no       |                                                                        |
| `data`        | JSON string | yes      | Object or array                                                        |
| `on-conflict` | string      | no       | Column(s) for conflict resolution (e.g. `id`, `email`, `id,tenant_id`) |
| `return-rows` | string      | no       | Default `true`                                                         |

If `on-conflict` is omitted, Supabase uses the table's primary key.

---

#### `update` — modify rows matching a filter

| Input         | Type        | Required | Description              |
| ------------- | ----------- | -------- | ------------------------ |
| `table`       | string      | yes      |                          |
| `filter`      | JSON string | **yes**  | Non-empty filter         |
| `data`        | JSON string | yes      | Updates as a JSON object |
| `schema`      | string      | no       |                          |
| `return-rows` | string      | no       | Default `true`           |

Empty filters raise `UNSAFE_UPDATE` — passes safety net for accidental "update all rows" mistakes. To update everything intentionally, pass a filter like `{"id":{"neq":null}}`.

---

#### `delete` — remove rows matching a filter

Same inputs as `update` minus `data`. Empty filters raise `UNSAFE_DELETE` for the same reason.

---

#### `count` — count matching rows without returning them

| Input    | Type        | Required | Description                    |
| -------- | ----------- | -------- | ------------------------------ |
| `table`  | string      | yes      |                                |
| `filter` | JSON string | no       | Default `{}` (counts all rows) |
| `schema` | string      | no       |                                |

**Output:**

```json
{ "count": 42 }
```

Cheaper than `query` for large tables — uses `head: true` so no rows are transferred.

---

#### `rpc` — call a Postgres stored procedure / function

| Input        | Type        | Required | Description                               |
| ------------ | ----------- | -------- | ----------------------------------------- |
| `rpc-name`   | string      | yes      | Function name                             |
| `rpc-params` | JSON string | no       | Parameters as a JSON object. Default `{}` |
| `schema`     | string      | no       |                                           |

**Output:**

```json
{ "result": <whatever the function returns> }
```

Useful for atomic multi-statement operations or expensive aggregations you've encapsulated in SQL.

### Auth

Manage users and validate sessions. JWT-based.

---

#### `auth-sign-up` — register a new user

| Input           | Type        | Required | Description                                  |
| --------------- | ----------- | -------- | -------------------------------------------- |
| `email`         | string      | yes      |                                              |
| `password`      | string      | yes      |                                              |
| `user-metadata` | JSON string | no       | Per-user metadata, stored on the user record |
| `redirect-to`   | string      | no       | URL for the email confirmation flow          |

**Output:**

```json
{ "user": {...}, "session": {...} }
```

`session` is `null` if email confirmation is required by your project settings.

Typically used with the **anon** key (client-style flow).

---

#### `auth-sign-in-password` — sign in with email + password

| Input      | Type   | Required | Description |
| ---------- | ------ | -------- | ----------- |
| `email`    | string | yes      |             |
| `password` | string | yes      |             |

**Output:**

```json
{ "user": {...}, "session": { "access_token": "...", "refresh_token": "...", "expires_in": 3600 } }
```

Use the **anon** key.

---

#### `auth-sign-in-otp` — send magic-link / OTP email

| Input         | Type   | Required | Description                                        |
| ------------- | ------ | -------- | -------------------------------------------------- |
| `email`       | string | yes      |                                                    |
| `redirect-to` | string | no       | Where the magic link sends the user after clicking |

**Output:** `{ "sent": true, "email": "..." }`

Use the **anon** key.

---

#### `auth-sign-out` — invalidate a JWT session

| Input | Type   | Required | Description                    |
| ----- | ------ | -------- | ------------------------------ |
| `jwt` | string | yes      | The access token to invalidate |

**Output:** `{ "signedOut": true }`

Use the **service-role** key — this calls the admin API.

---

#### `auth-get-user` — fetch user from a JWT

| Input | Type   | Required | Description |
| ----- | ------ | -------- | ----------- |
| `jwt` | string | yes      |             |

**Output:**

```json
{ "user": { "id": "...", "email": "...", "user_metadata": {...}, "app_metadata": {...} } }
```

`app_metadata.role` (or wherever your role lives) is the usual place to branch on for authorization gates — see the [auth-gate example](examples/auth-gate.yml).

---

#### `auth-update-user` — change email, password, or metadata

| Input           | Type        | Required | Description                              |
| --------------- | ----------- | -------- | ---------------------------------------- |
| `jwt`           | string      | yes      | Identifies which user to update          |
| `email`         | string      | no       | New email                                |
| `password`      | string      | no       | New password                             |
| `user-metadata` | JSON string | no       | Replaces (merges into) existing metadata |

At least one of `email`, `password`, `user-metadata` must be present — otherwise raises `NO_UPDATES`.

**Output:** `{ "user": {...} }`

---

#### `auth-verify-jwt` — validate a JWT

| Input | Type   | Required | Description |
| ----- | ------ | -------- | ----------- |
| `jwt` | string | yes      |             |

**Output (success):** `{ "valid": true, "user": {...} }`

**Errors:**

- `JWT_EXPIRED` — token's exp claim is in the past
- `JWT_INVALID` — signature mismatch, malformed token, revoked session
- Other auth errors fall under `JWT_VERIFY_FAILED`

Use this as the first step in any workflow triggered by an authenticated user.

---

#### `auth-reset-password` — send password reset email

| Input         | Type   | Required | Description                          |
| ------------- | ------ | -------- | ------------------------------------ |
| `email`       | string | yes      |                                      |
| `redirect-to` | string | no       | URL the reset link sends the user to |

**Output:** `{ "sent": true, "email": "..." }`

### Storage

Object storage (S3-compatible under the hood) organized into buckets. File contents flow through the action as base64 strings.

---

#### `storage-upload`

| Input          | Type   | Required | Description                                             |
| -------------- | ------ | -------- | ------------------------------------------------------- |
| `bucket`       | string | yes      | Bucket name (create it in the Supabase dashboard first) |
| `path`         | string | yes      | Path within the bucket, e.g. `user-123/avatar.png`      |
| `file-content` | string | yes      | Base64-encoded file content                             |
| `content-type` | string | no       | Default `application/octet-stream`                      |

**Output:** `{ "path": "...", "fullPath": "...", "id": "..." }`

`path` is the relative path within the bucket; `fullPath` includes the bucket prefix. Both are returned by Supabase.

Defaults to `upsert: true` — re-uploading to the same path overwrites.

---

#### `storage-download`

| Input    | Type   | Required | Description |
| -------- | ------ | -------- | ----------- |
| `bucket` | string | yes      |             |
| `path`   | string | yes      |             |

**Output:**

```json
{ "path": "...", "contentType": "...", "byteSize": 12345, "contentBase64": "..." }
```

The content comes back base64-encoded — decode in your next step. For files larger than a few MB, prefer `storage-get-signed-url` and let the consumer fetch directly.

---

#### `storage-list`

| Input    | Type   | Required | Description               |
| -------- | ------ | -------- | ------------------------- |
| `bucket` | string | yes      |                           |
| `path`   | string | no       | Path prefix to list under |
| `limit`  | string | no       | Max items                 |
| `offset` | string | no       | Items to skip             |

**Output:** `{ "files": [...] }` — each entry includes name, id, metadata, etc.

---

#### `storage-delete`

| Input    | Type   | Required | Description |
| -------- | ------ | -------- | ----------- |
| `bucket` | string | yes      |             |
| `path`   | string | yes      |             |

**Output:** `{ "deleted": [...] }`

Single-file delete. For batch deletes, call multiple times or use a `rpc` to a stored procedure.

---

#### `storage-get-signed-url`

| Input        | Type             | Required | Description             |
| ------------ | ---------------- | -------- | ----------------------- |
| `bucket`     | string           | yes      |                         |
| `path`       | string           | yes      |                         |
| `expires-in` | string (seconds) | no       | Default `3600` (1 hour) |

**Output:** `{ "signedUrl": "...", "expiresIn": 3600 }`

The URL is single-use-ish (Supabase enforces the time limit; the link itself can be hit multiple times within the window). Pair with [artifact-storage example](examples/artifact-storage.yml).

---

#### `storage-get-public-url`

| Input    | Type   | Required | Description |
| -------- | ------ | -------- | ----------- |
| `bucket` | string | yes      |             |
| `path`   | string | yes      |             |

**Output:** `{ "publicUrl": "..." }`

Works only for buckets configured as **public** in the Supabase dashboard. No expiration, no auth.

---

#### `storage-move`

| Input              | Type   | Required | Description |
| ------------------ | ------ | -------- | ----------- |
| `bucket`           | string | yes      |             |
| `path`             | string | yes      | Source path |
| `destination-path` | string | yes      | Target path |

**Output:** `{ "from": "...", "to": "...", "message": "..." }`

Atomic rename (same bucket only).

---

#### `storage-copy`

Same inputs as `storage-move`; doesn't remove the source. Output: `{ "from", "to", "path" }`.

### Edge Functions

---

#### `invoke-function`

| Input              | Type        | Required | Description                             |
| ------------------ | ----------- | -------- | --------------------------------------- |
| `function-name`    | string      | yes      | Name of the deployed function           |
| `function-body`    | JSON string | no       | Body to POST                            |
| `function-headers` | JSON string | no       | Custom headers as `{ "name": "value" }` |

**Output:** `{ "response": <function return> }`

The function's response body becomes `response`. JSON responses are parsed; non-JSON comes back as a string.

## Filter syntax

Filters are JSON objects keyed by column. Each value is either:

- **A scalar literal** — shorthand for `eq`:

  ```json
  { "status": "active" }
  ```

  Equivalent to `WHERE status = 'active'`.

- **A `{ operator: value }` map** — for any other operator:
  ```json
  { "amount": { "gte": 100 }, "status": { "in": ["a", "b"] } }
  ```

Combine multiple columns with implicit AND. There is no OR at this layer; for OR, use a `rpc` to a SQL function.

### Supported operators

| Operator                                                          | SQL equivalent            | Example                                                            |
| ----------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `eq`                                                              | `=`                       | `{ "id": { "eq": 5 } }`                                            |
| `neq`                                                             | `<>`                      | `{ "status": { "neq": "deleted" } }`                               |
| `gt` / `gte` / `lt` / `lte`                                       | numeric comparisons       | `{ "amount": { "gte": 100 } }`                                     |
| `like` / `ilike`                                                  | `LIKE` / case-insensitive | `{ "name": { "ilike": "%alice%" } }`                               |
| `is`                                                              | `IS` (null check)         | `{ "deleted_at": { "is": null } }`                                 |
| `in`                                                              | `IN (...)`                | `{ "currency": { "in": ["USD", "EUR"] } }`                         |
| `contains`                                                        | `@>` (arrays/jsonb)       | `{ "tags": { "contains": ["urgent"] } }`                           |
| `containedBy`                                                     | `<@`                      | `{ "tags": { "containedBy": ["a","b","c"] } }`                     |
| `overlaps`                                                        | `&&`                      | `{ "valid_period": { "overlaps": ["2026-01-01", "2026-12-31"] } }` |
| `textSearch`                                                      | full-text search          | `{ "body": { "textSearch": "needle" } }`                           |
| `rangeGt` / `rangeGte` / `rangeLt` / `rangeLte` / `rangeAdjacent` | range operators           | for `tstzrange` and friends                                        |

Unknown operators raise `INVALID_FILTER`.

## Error codes

All errors surface to the workflow step as `<CODE>: <message>` and fail the step. Codes you can pattern-match on:

| Code                                                      | When                                                                                   |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `MISSING_INPUT`                                           | A required input was empty                                                             |
| `MISSING_URL` / `MISSING_KEY`                             | Action-level config missing                                                            |
| `INVALID_JSON`                                            | A JSON input couldn't be parsed                                                        |
| `INVALID_FILTER`                                          | Filter operator not in the supported list                                              |
| `INVALID_ORDER`                                           | `order` entry missing `column`                                                         |
| `NOT_FOUND`                                               | Postgres reported no rows / Storage path missing                                       |
| `PERMISSION_DENIED`                                       | RLS or table grant denied. Often signals "you used anon when you needed service-role." |
| `UNIQUE_VIOLATION`                                        | Insert collided with a unique constraint                                               |
| `FOREIGN_KEY_VIOLATION`                                   | Insert/delete violated a foreign key                                                   |
| `UNAUTHORIZED` / `FORBIDDEN`                              | HTTP 401 / 403 from the API                                                            |
| `AUTH_INVALID_CREDENTIALS`                                | Wrong email/password on `auth-sign-in-password`                                        |
| `AUTH_USER_NOT_FOUND`                                     | User lookup failed                                                                     |
| `AUTH_EMAIL_NOT_CONFIRMED`                                | Project requires confirmation; user hasn't completed it                                |
| `JWT_EXPIRED` / `JWT_INVALID`                             | `auth-verify-jwt` rejected the token                                                   |
| `UNSAFE_UPDATE` / `UNSAFE_DELETE`                         | Empty filter on update/delete                                                          |
| `NO_UPDATES`                                              | `auth-update-user` called with no fields to change                                     |
| `STORAGE_UPLOAD_FAILED` / `STORAGE_DOWNLOAD_FAILED` / ... | Per-storage-operation failure                                                          |
| `FUNCTION_INVOKE_FAILED`                                  | Edge Function returned an error                                                        |
| `QUERY_FAILED` / `INSERT_FAILED` / `UPDATE_FAILED` / ...  | Per-command catch-all when Postgres returned an unmapped error                         |

Originals from Supabase / PostgreSQL come through in the `details` field of the error when available.

## Common patterns

See the [examples directory](examples/) for runnable workflow files.

| Pattern                                      | Example                                               |
| -------------------------------------------- | ----------------------------------------------------- |
| Sync data into Supabase                      | [data-pipeline.yml](examples/data-pipeline.yml)       |
| Verify a caller's JWT before privileged work | [auth-gate.yml](examples/auth-gate.yml)               |
| Generate + share an artifact                 | [artifact-storage.yml](examples/artifact-storage.yml) |
| Audit every workflow run                     | [audit-log.yml](examples/audit-log.yml)               |
| Enrich via Edge Function                     | [edge-function.yml](examples/edge-function.yml)       |

## Gotchas

- **Service-role key is god-mode.** Never expose it client-side. Always store as a secret. If you write a workflow that echoes the key to logs, the secret-masking the W3 runtime applies will catch most cases — don't rely on it as a safety net.
- **RLS isn't optional with anon.** If you use the anon key on a database operation and get `PERMISSION_DENIED`, you almost certainly need RLS policies on the table, or you should switch to service-role.
- **`update` / `delete` require a filter.** This is intentional. If you want to operate on all rows, pass `{"id":{"neq":null}}` explicitly.
- **`now()` and other Postgres functions** can be passed as strings in `data` payloads — PostgREST passes them through to the planner. Example: `{"shipped_at": "now()"}`.
- **Storage `path` is relative to the bucket.** Don't prefix it with the bucket name.
- **Large files (>10 MB) should not flow through this action.** Base64-encoded transit is slow and memory-hungry; for big files, generate a signed URL with `storage-get-signed-url` and have the producer/consumer go direct.
- **Edge Function JSON responses are parsed automatically.** If your function returns plain text, it'll come through as a string.

## See also

- [README](../README.md) — quick-start
- [`w3-action.yaml`](../w3-action.yaml) — registry metadata (drives MCP discovery)
- [Supabase docs](https://supabase.com/docs)
- [PostgREST filter reference](https://postgrest.org/en/stable/references/api/tables_views.html#operators)
