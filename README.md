# W3 Supabase Action

Connect W3 workflows to Supabase. Run Postgres queries, manage Auth, upload/download files, invoke Edge Functions — all from a workflow step.

```yaml
- uses: w3-io/w3-supabase-action@v1
  with:
    command: query
    url: ${{ secrets.SUPABASE_URL }}
    key: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
    table: orders
    filter: '{"status":{"eq":"pending"}}'
```

## Quick start

1. **Get your Supabase URL and a key:**

   - Project URL — `https://YOUR_PROJECT.supabase.co`
   - **service-role key** (Settings → API) — for server-side workflows; **bypasses Row Level Security**, treat like a master password
   - **anon key** (Settings → API) — for client-style auth flows (sign-up, sign-in)

2. **Store them as W3 workflow secrets** (or GitHub repo secrets if running as a GHA).

3. **Pick a command** from below and call it.

## Picking the right key

Most workflow operations want the **service-role key** because workflows run server-side and need full table access (RLS bypass). Use the **anon key** only when you're acting on behalf of an end user (auth flows).

| Command family | Recommended key | Why |
|---|---|---|
| Database (`query`, `insert`, etc.) | service-role | Workflows usually need to read/write across all rows, ignoring RLS |
| `auth-sign-up`, `auth-sign-in-*`, `auth-reset-password` | anon | These are client-style flows; anon is what your app uses |
| `auth-sign-out`, `auth-update-user`, `auth-verify-jwt`, `auth-get-user` | service-role | Server-side admin operations on a user's session |
| Storage | service-role | Same RLS reasoning as Database |
| `invoke-function` | either | Whichever your function expects |

The `key-type` input is informational — Supabase itself enforces what each operation needs based on the key you pass.

## Examples

### Read pending orders

```yaml
- name: Read pending orders
  id: orders
  uses: w3-io/w3-supabase-action@v1
  with:
    command: query
    url: ${{ secrets.SUPABASE_URL }}
    key: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
    table: orders
    filter: '{"status":{"eq":"pending"},"created_at":{"gte":"2026-01-01"}}'
    select: "id,user_id,amount,currency"
    order: '[{"column":"created_at","ascending":false}]'
    limit: "100"
```

The `result` output is `{ "rows": [...], "count": N }` — use `${{ fromJSON(steps.orders.outputs.result).rows }}` in the next step.

### Insert a single row

```yaml
- uses: w3-io/w3-supabase-action@v1
  with:
    command: insert
    url: ${{ secrets.SUPABASE_URL }}
    key: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
    table: audit_log
    data: '{"event":"workflow_started","trigger":"cron","metadata":{"chain":"ethereum"}}'
```

### Upsert by email

```yaml
- uses: w3-io/w3-supabase-action@v1
  with:
    command: upsert
    url: ${{ secrets.SUPABASE_URL }}
    key: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
    table: contacts
    data: '[{"email":"alice@example.com","name":"Alice"},{"email":"bob@example.com","name":"Bob"}]'
    on-conflict: "email"
```

### Update rows matching a filter

```yaml
- uses: w3-io/w3-supabase-action@v1
  with:
    command: update
    url: ${{ secrets.SUPABASE_URL }}
    key: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
    table: orders
    filter: '{"id":{"eq":42}}'
    data: '{"status":"shipped","shipped_at":"now()"}'
```

Filter is **required** for `update` and `delete` — preventing accidental full-table operations.

### Verify a JWT from a workflow trigger

```yaml
- name: Verify caller's JWT
  uses: w3-io/w3-supabase-action@v1
  with:
    command: auth-verify-jwt
    url: ${{ secrets.SUPABASE_URL }}
    key: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
    jwt: ${{ inputs.user_jwt }}
```

Raises `JWT_EXPIRED` or `JWT_INVALID` on failure; returns `{ valid: true, user }` on success.

### Upload a generated PDF

```yaml
- uses: w3-io/w3-supabase-action@v1
  with:
    command: storage-upload
    url: ${{ secrets.SUPABASE_URL }}
    key: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
    bucket: reports
    path: ${{ inputs.user_id }}/${{ inputs.report_id }}.pdf
    file-content: ${{ steps.render.outputs.pdf_base64 }}
    content-type: application/pdf
```

Pair with `storage-get-signed-url` to share the artifact with an end user.

### Invoke an Edge Function

```yaml
- uses: w3-io/w3-supabase-action@v1
  with:
    command: invoke-function
    url: ${{ secrets.SUPABASE_URL }}
    key: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
    function-name: enrich-transaction
    function-body: '{"tx_hash":"${{ steps.signed.outputs.tx_hash }}"}'
```

## Command reference

### Database

| Command | Purpose |
|---|---|
| `query` | Select rows |
| `insert` | Add rows |
| `upsert` | Add or update rows on conflict |
| `update` | Modify rows matching a filter (filter required) |
| `delete` | Remove rows matching a filter (filter required) |
| `count` | Count rows matching a filter |
| `rpc` | Call a stored procedure / database function |

### Auth

| Command | Purpose |
|---|---|
| `auth-sign-up` | Register a new user |
| `auth-sign-in-password` | Sign in with email + password |
| `auth-sign-in-otp` | Send magic-link / OTP email |
| `auth-sign-out` | Invalidate a JWT session |
| `auth-get-user` | Get user from a JWT |
| `auth-update-user` | Change email, password, or metadata |
| `auth-verify-jwt` | Validate a JWT |
| `auth-reset-password` | Send password reset email |

### Storage

| Command | Purpose |
|---|---|
| `storage-upload` | Upload a file (base64) |
| `storage-download` | Download a file (base64) |
| `storage-list` | List files in a bucket/path |
| `storage-delete` | Delete a file |
| `storage-get-signed-url` | Generate a time-limited URL |
| `storage-get-public-url` | Get the public URL (public buckets only) |
| `storage-move` | Rename a file |
| `storage-copy` | Copy a file to a new path |

### Edge Functions

| Command | Purpose |
|---|---|
| `invoke-function` | Call a deployed Edge Function |

See [`docs/guide.md`](docs/guide.md) for the full input/output schema per command.

## Filter syntax

Filters are JSON objects keyed by column. Each value is either a literal (shorthand for `eq`) or a `{ operator: value }` map.

```json
{
  "status": "active",                      // shorthand → status = 'active'
  "amount": { "gte": 100 },
  "currency": { "in": ["USD", "EUR"] },
  "deleted_at": { "is": null },
  "name": { "ilike": "%alice%" }
}
```

Supported operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `is`, `in`, `contains`, `containedBy`, `overlaps`, `textSearch`, `rangeGt`, `rangeGte`, `rangeLt`, `rangeLte`, `rangeAdjacent`.

## Errors

All errors surface as `<CODE>: <message>` and fail the workflow step. Codes you can pattern-match on:

| Code | Meaning |
|---|---|
| `MISSING_INPUT` | A required input was empty |
| `INVALID_JSON` | A JSON input couldn't be parsed |
| `INVALID_FILTER` | Filter operator not supported |
| `NOT_FOUND` | No matching row / file |
| `PERMISSION_DENIED` | RLS or table grant denied; consider service-role key |
| `UNIQUE_VIOLATION` | Insert conflicted with a unique constraint |
| `FOREIGN_KEY_VIOLATION` | Insert/delete violated a foreign key |
| `JWT_EXPIRED` / `JWT_INVALID` | `auth-verify-jwt` failed |
| `AUTH_INVALID_CREDENTIALS` | Wrong email/password |
| `UNSAFE_UPDATE` / `UNSAFE_DELETE` | Filter was empty on update/delete |
| `STORAGE_*` | Per-storage-operation failures |
| `FUNCTION_INVOKE_FAILED` | Edge Function returned an error |

## License

MIT
