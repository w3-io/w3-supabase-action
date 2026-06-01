/**
 * Unit tests for SupabaseSdkClient and its helpers.
 *
 * Strategy:
 *   - Helpers (parseJsonInput, requireInput, applyFilter, applyOrder,
 *     translateError) are pure — test them directly.
 *   - SupabaseSdkClient error paths (UNSAFE_UPDATE, MISSING_INPUT, etc.)
 *     are tested by passing minimal arguments — the validation throws
 *     before any Supabase SDK call.
 *   - Deep SDK orchestration (chained .from().select().eq()... await) is
 *     covered by integration tests against a real Supabase instance,
 *     not here. See AGENTS.md test strategy.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  SupabaseSdkClient,
  SupabaseError,
  parseJsonInput,
  requireInput,
  applyFilter,
  applyOrder,
  translateError,
  FILTER_OPS,
} from '../src/client.js'

const TEST_URL = 'https://test.supabase.co'
const TEST_KEY = 'test-key'

// ─────────────────── parseJsonInput ───────────────────

describe('parseJsonInput', () => {
  it('parses valid JSON', () => {
    assert.deepEqual(parseJsonInput('x', '{"a":1}'), { a: 1 })
    assert.deepEqual(parseJsonInput('x', '[1,2,3]'), [1, 2, 3])
    assert.deepEqual(parseJsonInput('x', '"hello"'), 'hello')
  })

  it('returns default when raw is empty and allowEmpty is true', () => {
    assert.deepEqual(parseJsonInput('x', '', { allowEmpty: true, defaultValue: {} }), {})
    assert.equal(parseJsonInput('x', '', { allowEmpty: true, defaultValue: null }), null)
    assert.equal(parseJsonInput('x', '', { allowEmpty: true }), undefined)
  })

  it('throws MISSING_INPUT when raw is empty and allowEmpty is false', () => {
    assert.throws(
      () => parseJsonInput('table', ''),
      (err) =>
        err instanceof SupabaseError &&
        err.code === 'MISSING_INPUT' &&
        err.message.includes("'table'"),
    )
  })

  it('throws INVALID_JSON when parsing fails', () => {
    assert.throws(
      () => parseJsonInput('filter', '{not json'),
      (err) =>
        err instanceof SupabaseError &&
        err.code === 'INVALID_JSON' &&
        err.message.includes("'filter'"),
    )
  })
})

// ─────────────────── requireInput ───────────────────

describe('requireInput', () => {
  it('returns the value when present', () => {
    assert.equal(requireInput('table', 'orders'), 'orders')
    assert.equal(requireInput('limit', 100), 100)
  })

  it('throws on empty string', () => {
    assert.throws(
      () => requireInput('table', ''),
      (err) => err instanceof SupabaseError && err.code === 'MISSING_INPUT',
    )
  })

  it('throws on null / undefined', () => {
    assert.throws(() => requireInput('jwt', null), SupabaseError)
    assert.throws(() => requireInput('jwt', undefined), SupabaseError)
  })
})

// ─────────────────── applyFilter ───────────────────

describe('applyFilter', () => {
  // A chainable mock that records calls and returns itself.
  function makeMockQuery() {
    const calls = []
    const builder = {}
    const ops = [
      'eq',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
      'like',
      'ilike',
      'is',
      'in',
      'contains',
      'containedBy',
      'rangeGt',
      'rangeGte',
      'rangeLt',
      'rangeLte',
      'rangeAdjacent',
      'overlaps',
      'textSearch',
    ]
    for (const op of ops) {
      builder[op] = (...args) => {
        calls.push([op, ...args])
        return builder
      }
    }
    return { builder, calls }
  }

  it('returns the query unchanged when filter is empty or undefined', () => {
    const { builder, calls } = makeMockQuery()
    const result = applyFilter(builder, {})
    assert.equal(result, builder)
    assert.equal(calls.length, 0)

    const r2 = applyFilter(builder, undefined)
    assert.equal(r2, builder)
  })

  it('applies eq for scalar values (shorthand)', () => {
    const { builder, calls } = makeMockQuery()
    applyFilter(builder, { status: 'active' })
    assert.deepEqual(calls, [['eq', 'status', 'active']])
  })

  it('applies the named operator when given a {op: value} map', () => {
    const { builder, calls } = makeMockQuery()
    applyFilter(builder, { amount: { gte: 100 }, status: { in: ['a', 'b'] } })
    assert.deepEqual(calls, [
      ['gte', 'amount', 100],
      ['in', 'status', ['a', 'b']],
    ])
  })

  it('throws INVALID_FILTER on unsupported operator', () => {
    const { builder } = makeMockQuery()
    assert.throws(
      () => applyFilter(builder, { id: { bogus: 5 } }),
      (err) =>
        err instanceof SupabaseError &&
        err.code === 'INVALID_FILTER' &&
        err.message.includes('bogus'),
    )
  })

  it('supports all documented operators', () => {
    const { builder, calls } = makeMockQuery()
    const everyOp = {}
    for (const op of FILTER_OPS) {
      everyOp[`col_${op}`] = { [op]: 'v' }
    }
    applyFilter(builder, everyOp)
    assert.equal(calls.length, FILTER_OPS.size)
  })
})

// ─────────────────── applyOrder ───────────────────

describe('applyOrder', () => {
  function makeMockQuery() {
    const calls = []
    const builder = {
      order(...args) {
        calls.push(args)
        return builder
      },
    }
    return { builder, calls }
  }

  it('returns the query unchanged when order is undefined', () => {
    const { builder, calls } = makeMockQuery()
    const r = applyOrder(builder, undefined)
    assert.equal(r, builder)
    assert.equal(calls.length, 0)
  })

  it('accepts a single order spec', () => {
    const { builder, calls } = makeMockQuery()
    applyOrder(builder, { column: 'created_at', ascending: false })
    assert.deepEqual(calls, [['created_at', { ascending: false, nullsFirst: false }]])
  })

  it('accepts an array of order specs', () => {
    const { builder, calls } = makeMockQuery()
    applyOrder(builder, [
      { column: 'priority' },
      { column: 'created_at', ascending: false, nullsFirst: true },
    ])
    assert.deepEqual(calls, [
      ['priority', { ascending: true, nullsFirst: false }],
      ['created_at', { ascending: false, nullsFirst: true }],
    ])
  })

  it('throws INVALID_ORDER when column is missing', () => {
    const { builder } = makeMockQuery()
    assert.throws(
      () => applyOrder(builder, { ascending: true }),
      (err) => err instanceof SupabaseError && err.code === 'INVALID_ORDER',
    )
  })
})

// ─────────────────── translateError ───────────────────

describe('translateError', () => {
  it('maps PostgreSQL 42501 (insufficient privilege) to PERMISSION_DENIED', () => {
    const err = translateError({ code: '42501', message: 'denied' })
    assert.equal(err.code, 'PERMISSION_DENIED')
  })

  it('maps 23505 (unique violation) to UNIQUE_VIOLATION', () => {
    const err = translateError({ code: '23505', message: 'dup' })
    assert.equal(err.code, 'UNIQUE_VIOLATION')
  })

  it('maps 23503 (foreign key violation) to FOREIGN_KEY_VIOLATION', () => {
    const err = translateError({ code: '23503', message: 'fk' })
    assert.equal(err.code, 'FOREIGN_KEY_VIOLATION')
  })

  it('maps PostgREST PGRST116 (no rows) to NOT_FOUND', () => {
    const err = translateError({ code: 'PGRST116', message: 'nope' })
    assert.equal(err.code, 'NOT_FOUND')
  })

  it('maps Supabase auth invalid_grant to AUTH_INVALID_CREDENTIALS', () => {
    const err = translateError({ code: 'invalid_grant', message: 'bad' })
    assert.equal(err.code, 'AUTH_INVALID_CREDENTIALS')
  })

  it('maps HTTP 401 to UNAUTHORIZED', () => {
    const err = translateError({ code: 401, message: 'auth' })
    assert.equal(err.code, 'UNAUTHORIZED')
    assert.equal(err.statusCode, 401)
  })

  it('maps HTTP 403 to FORBIDDEN', () => {
    const err = translateError({ code: 403, message: 'denied' })
    assert.equal(err.code, 'FORBIDDEN')
  })

  it('falls back to the supplied fallbackCode for unknown errors', () => {
    const err = translateError({ message: 'wat' }, 'CUSTOM_FALLBACK')
    assert.equal(err.code, 'CUSTOM_FALLBACK')
    assert.equal(err.message, 'wat')
  })

  it('passes details through', () => {
    const err = translateError({ code: '42501', message: 'm', details: 'hint here' })
    assert.deepEqual(err.details, 'hint here')
  })

  it('handles null/undefined input', () => {
    const err = translateError(null)
    assert.equal(err.code, 'SUPABASE_ERROR')
  })
})

// ─────────────────── SupabaseSdkClient construction ───────────────────

describe('SupabaseSdkClient construction', () => {
  it('throws MISSING_URL when url is not provided', () => {
    assert.throws(
      () => new SupabaseSdkClient({ key: TEST_KEY }),
      (err) => err instanceof SupabaseError && err.code === 'MISSING_URL',
    )
  })

  it('throws MISSING_KEY when key is not provided', () => {
    assert.throws(
      () => new SupabaseSdkClient({ url: TEST_URL }),
      (err) => err instanceof SupabaseError && err.code === 'MISSING_KEY',
    )
  })

  it('constructs successfully with url + key', () => {
    const c = new SupabaseSdkClient({ url: TEST_URL, key: TEST_KEY })
    assert.equal(c.url, TEST_URL)
    assert.ok(c.client)
  })
})

// ─────────────────── client method input validation ───────────────────

describe('SupabaseSdkClient input validation (no SDK calls)', () => {
  // These tests verify that input validation throws BEFORE any SDK call.

  const client = new SupabaseSdkClient({ url: TEST_URL, key: TEST_KEY })

  it('query: throws MISSING_INPUT when table is empty', async () => {
    await assert.rejects(
      () => client.query({ table: '' }),
      (err) => err instanceof SupabaseError && err.code === 'MISSING_INPUT',
    )
  })

  it('update: throws UNSAFE_UPDATE when filter is empty', async () => {
    await assert.rejects(
      () => client.update({ table: 'orders', filter: {}, data: { x: 1 } }),
      (err) => err instanceof SupabaseError && err.code === 'UNSAFE_UPDATE',
    )
  })

  it('delete: throws UNSAFE_DELETE when filter is empty', async () => {
    await assert.rejects(
      () => client.delete({ table: 'orders', filter: {} }),
      (err) => err instanceof SupabaseError && err.code === 'UNSAFE_DELETE',
    )
  })

  it('rpc: throws MISSING_INPUT when name is empty', async () => {
    await assert.rejects(
      () => client.rpc({ name: '' }),
      (err) => err instanceof SupabaseError && err.code === 'MISSING_INPUT',
    )
  })

  it('authSignUp: throws MISSING_INPUT when email is empty', async () => {
    await assert.rejects(
      () => client.authSignUp({ email: '', password: 'p' }),
      (err) => err instanceof SupabaseError && err.code === 'MISSING_INPUT',
    )
  })

  it('authSignUp: throws MISSING_INPUT when password is empty', async () => {
    await assert.rejects(
      () => client.authSignUp({ email: 'a@b.com', password: '' }),
      (err) => err instanceof SupabaseError && err.code === 'MISSING_INPUT',
    )
  })

  it('authUpdateUser: throws NO_UPDATES when no fields to update', async () => {
    await assert.rejects(
      () => client.authUpdateUser({ jwt: 'x' }),
      (err) => err instanceof SupabaseError && err.code === 'NO_UPDATES',
    )
  })

  it('storageUpload: throws MISSING_INPUT when bucket is empty', async () => {
    await assert.rejects(
      () => client.storageUpload({ bucket: '', path: 'p', fileContentBase64: 'YQ==' }),
      (err) => err instanceof SupabaseError && err.code === 'MISSING_INPUT',
    )
  })

  it('storageGetSignedUrl: throws MISSING_INPUT when path is empty', async () => {
    await assert.rejects(
      () => client.storageGetSignedUrl({ bucket: 'b', path: '' }),
      (err) => err instanceof SupabaseError && err.code === 'MISSING_INPUT',
    )
  })

  it('storageMove: throws MISSING_INPUT when destinationPath is empty', async () => {
    await assert.rejects(
      () => client.storageMove({ bucket: 'b', path: 'p', destinationPath: '' }),
      (err) => err instanceof SupabaseError && err.code === 'MISSING_INPUT',
    )
  })

  it('invokeFunction: throws MISSING_INPUT when name is empty', async () => {
    await assert.rejects(
      () => client.invokeFunction({ name: '' }),
      (err) => err instanceof SupabaseError && err.code === 'MISSING_INPUT',
    )
  })
})

// ─────────────────── SupabaseError construction ───────────────────

describe('SupabaseError', () => {
  it('has the expected code and message', () => {
    const err = new SupabaseError('TEST_CODE', 'test message')
    assert.equal(err.code, 'TEST_CODE')
    assert.equal(err.message, 'test message')
    assert.equal(err.name, 'SupabaseError')
  })

  it('carries statusCode and details when provided', () => {
    const err = new SupabaseError('TEST', 'm', { statusCode: 500, details: 'oops' })
    assert.equal(err.statusCode, 500)
    assert.equal(err.details, 'oops')
  })
})
