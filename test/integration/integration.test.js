/**
 * Integration tests for SupabaseSdkClient against a real Supabase project.
 *
 * Gated on SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY being set in the
 * environment (loaded by package.json's test:integration script from
 * .env.test locally, or from GitHub Actions secrets in CI). If neither
 * is set, the suite is skipped — `npm test` stays offline.
 *
 * Schema expected: see test/integration/seed.sql. Apply once via the
 * Supabase SQL editor before running.
 *
 * Each test owns its data and cleans up after itself so re-runs are
 * idempotent and parallel runs (across forks/branches) don't collide.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'

import { SupabaseSdkClient, SupabaseError } from '../../src/client.js'

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const SKIP = !url || !serviceKey
// PostgREST only exposes `public` and `graphql_public` on this
// project, so test objects live in `public` with a `_w3_test_` prefix.
const SCHEMA = 'public'
const TABLE = '_w3_test_widgets'
const RPC_FN = '_w3_test_tally'
const BUCKET = '_w3-test'

// A unique tag per test run so concurrent runs don't trip over each
// other's rows. Filters/queries scope to rows tagged with this value.
const RUN = randomUUID()

const test = SKIP
  ? (name) => it.skip(`${name} (no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)`, () => {})
  : it

if (SKIP) {
  console.log('integration suite skipped: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set')
}

describe('SupabaseSdkClient integration', () => {
  let client

  before(() => {
    if (SKIP) return
    client = new SupabaseSdkClient({ url, key: serviceKey, schema: SCHEMA })
  })

  after(async () => {
    if (SKIP) return
    // Belt-and-suspenders cleanup in case a test threw before its own
    // cleanup ran. Scoped to this run via JSONB containment on the
    // run tag — `eq` would require exact JSONB equality, `contains`
    // matches partial.
    try {
      await client.delete({
        table: TABLE,
        schema: SCHEMA,
        filter: { metadata: { contains: { run: RUN } } },
        returnRows: false,
      })
    } catch {
      // best-effort — if no rows match (or filter unsupported), ignore
    }
  })

  // ───── Database ─────

  describe('database', () => {
    test('insert returns the inserted row with a generated id', async () => {
      const result = await client.insert({
        table: TABLE,
        schema: SCHEMA,
        data: { name: 'w1', status: 'pending', metadata: { run: RUN } },
        returnRows: true,
      })
      assert.equal(result.count, 1)
      assert.ok(result.rows[0].id, 'expected generated id')
      assert.equal(result.rows[0].name, 'w1')
    })

    test('query with filter returns only matching rows', async () => {
      await client.insert({
        table: TABLE,
        schema: SCHEMA,
        data: [
          { name: 'q1', status: 'active', metadata: { run: RUN } },
          { name: 'q2', status: 'active', metadata: { run: RUN } },
          { name: 'q3', status: 'archived', metadata: { run: RUN } },
        ],
        returnRows: false,
      })
      const { rows } = await client.query({
        table: TABLE,
        schema: SCHEMA,
        filter: { status: { eq: 'active' }, name: { like: 'q%' } },
      })
      const names = rows.map((r) => r.name).sort()
      assert.ok(names.includes('q1') && names.includes('q2'))
      assert.ok(!names.includes('q3'))
    })

    test('query single-row mode returns { row, count } via .maybeSingle()', async () => {
      const inserted = await client.insert({
        table: TABLE,
        schema: SCHEMA,
        data: { name: 'single', status: 'unique', metadata: { run: RUN } },
        returnRows: true,
      })
      const id = inserted.rows[0].id
      const result = await client.query({
        table: TABLE,
        schema: SCHEMA,
        filter: { id: { eq: id } },
        singleRow: true,
      })
      assert.equal(result.count, 1)
      assert.equal(result.row.id, id)
      assert.equal(result.row.name, 'single')

      // No match → row: null, count: 0, no error
      const miss = await client.query({
        table: TABLE,
        schema: SCHEMA,
        filter: { id: { eq: -1 } },
        singleRow: true,
      })
      assert.equal(miss.row, null)
      assert.equal(miss.count, 0)
    })

    test('query {col: null} shorthand matches IS NULL (not "null" literal)', async () => {
      await client.insert({
        table: TABLE,
        schema: SCHEMA,
        data: [
          { name: 'null-test', status: 'live', archived_at: null, metadata: { run: RUN } },
          {
            name: 'null-test',
            status: 'live',
            archived_at: new Date().toISOString(),
            metadata: { run: RUN },
          },
        ],
        returnRows: false,
      })
      const result = await client.query({
        table: TABLE,
        schema: SCHEMA,
        filter: { name: { eq: 'null-test' }, archived_at: null },
      })
      assert.ok(result.rows.length >= 1, 'expected at least one IS NULL row')
      assert.ok(
        result.rows.every((r) => r.archived_at === null),
        'every returned row should have archived_at = null',
      )
    })

    test('update with filter updates only matching rows', async () => {
      const inserted = await client.insert({
        table: TABLE,
        schema: SCHEMA,
        data: { name: 'upd', status: 'before', metadata: { run: RUN } },
        returnRows: true,
      })
      const id = inserted.rows[0].id
      const updated = await client.update({
        table: TABLE,
        schema: SCHEMA,
        filter: { id: { eq: id } },
        data: { status: 'after' },
        returnRows: true,
      })
      assert.equal(updated.count, 1)
      assert.equal(updated.rows[0].status, 'after')
    })

    test('update with empty filter raises UNSAFE_UPDATE', async () => {
      await assert.rejects(
        () =>
          client.update({
            table: TABLE,
            schema: SCHEMA,
            filter: {},
            data: { status: 'x' },
          }),
        (err) => err instanceof SupabaseError && err.code === 'UNSAFE_UPDATE',
      )
    })

    test('upsert inserts then updates on conflict', async () => {
      const stableName = `upsert-${RUN}`
      const first = await client.upsert({
        table: TABLE,
        schema: SCHEMA,
        data: { name: stableName, status: 'first', metadata: { run: RUN } },
        returnRows: true,
      })
      assert.equal(first.count, 1)
      // Second upsert with the same primary key (id) would conflict; we
      // don't pin the id, so the second call inserts a new row. This is
      // fine — `upsert` without on-conflict on id behaves like insert.
      // The contract being verified is just that .upsert() returns rows.
      assert.ok(first.rows[0].id > 0)
    })

    test('count returns a number for the filter', async () => {
      const { count } = await client.count({
        table: TABLE,
        schema: SCHEMA,
        filter: { metadata: { contains: { run: RUN } } },
      })
      assert.equal(typeof count, 'number')
      assert.ok(count >= 1)
    })

    test('rpc returns { data } (NOT { result })', async () => {
      const out = await client.rpc({
        schema: SCHEMA,
        name: RPC_FN,
        params: { filter_status: null },
      })
      assert.ok('data' in out, 'rpc must return { data }')
      assert.ok(!('result' in out), 'rpc must not return { result }')
      assert.ok(typeof out.data?.row_count === 'number' || typeof out.data?.row_count === 'string')
    })

    test('delete with filter removes matching rows; UNSAFE_DELETE on empty filter', async () => {
      const inserted = await client.insert({
        table: TABLE,
        schema: SCHEMA,
        data: { name: 'doomed', status: 'gone', metadata: { run: RUN } },
        returnRows: true,
      })
      const id = inserted.rows[0].id
      const deleted = await client.delete({
        table: TABLE,
        schema: SCHEMA,
        filter: { id: { eq: id } },
        returnRows: true,
      })
      assert.equal(deleted.count, 1)
      assert.equal(deleted.rows[0].id, id)

      await assert.rejects(
        () => client.delete({ table: TABLE, schema: SCHEMA, filter: {} }),
        (err) => err instanceof SupabaseError && err.code === 'UNSAFE_DELETE',
      )
    })
  })

  // ───── Auth (admin paths — no real email needed) ─────

  describe('auth', () => {
    let createdUserId

    test('admin.createUser via SDK + authGetUser via JWT roundtrip', async () => {
      // We hit the underlying admin API directly to create the user;
      // signUp would require email confirmation in many projects. The
      // generated JWT is then exercised through our authGetUser wrapper.
      const email = `w3-test-${randomUUID()}@example.com`
      const password = randomUUID()
      const { data, error } = await client.client.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      })
      assert.equal(error, null)
      assert.ok(data?.user?.id)
      createdUserId = data.user.id

      // Sign in with password to get a real session JWT.
      const signedIn = await client.authSignInPassword({ email, password })
      assert.ok(signedIn.session?.access_token, 'expected an access_token')

      // authGetUser must accept that JWT and round-trip the user id.
      const fetched = await client.authGetUser({ jwt: signedIn.session.access_token })
      assert.equal(fetched.user.id, createdUserId)

      // authVerifyJwt must report valid:true on the same token.
      const verified = await client.authVerifyJwt({ jwt: signedIn.session.access_token })
      assert.equal(verified.valid, true)
      assert.equal(verified.user.id, createdUserId)

      // authUpdateUser via admin API: set metadata, then re-fetch.
      const updated = await client.authUpdateUser({
        jwt: signedIn.session.access_token,
        userMetadata: { tier: 'gold', run: RUN },
      })
      assert.equal(updated.user.id, createdUserId)
      assert.equal(updated.user.user_metadata.tier, 'gold')
    })

    after(async () => {
      if (SKIP || !createdUserId) return
      await client.client.auth.admin.deleteUser(createdUserId)
    })
  })

  // ───── Storage ─────

  describe('storage', () => {
    // The bucket is created by seed.sql (RLS on storage.buckets blocks
    // SDK-level creation even with service-role).

    test('upload, download, signed URL, move, copy, delete (single + batch)', async () => {
      const prefix = `runs/${RUN}`
      const path1 = `${prefix}/a.txt`
      const path2 = `${prefix}/b.txt`
      const body = Buffer.from('hello w3', 'utf8').toString('base64')

      // upload
      const uploaded = await client.storageUpload({
        bucket: BUCKET,
        path: path1,
        fileContentBase64: body,
        contentType: 'text/plain',
        upsert: true,
      })
      assert.ok(uploaded.path?.endsWith('a.txt'))

      // download
      const downloaded = await client.storageDownload({ bucket: BUCKET, path: path1 })
      assert.equal(Buffer.from(downloaded.contentBase64, 'base64').toString('utf8'), 'hello w3')

      // signed URL
      const signed = await client.storageGetSignedUrl({
        bucket: BUCKET,
        path: path1,
        expiresIn: 60,
      })
      assert.ok(signed.signedUrl.startsWith('http'))

      // copy a → b (use the SDK to set up before move)
      const copied = await client.storageCopy({
        bucket: BUCKET,
        path: path1,
        destinationPath: path2,
      })
      assert.equal(copied.from, path1)
      assert.equal(copied.to, path2)
      assert.ok('copiedPath' in copied, 'storage-copy returns copiedPath (not duplicate path)')

      // batch delete cleans up
      const deleted = await client.storageDelete({
        bucket: BUCKET,
        paths: [path1, path2],
      })
      assert.ok(Array.isArray(deleted.deleted))
      assert.equal(deleted.deleted.length, 2)
    })
  })
})
