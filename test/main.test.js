/**
 * Unit tests for the dispatch layer in src/main.js.
 *
 * Scope:
 *   - getBool: YAML-1.2 truthy/falsy parsing + INVALID_BOOL on garbage
 *   - getString: required vs default vs raw
 *   - maskSession: invokes core.setSecret for access + refresh tokens
 *   - handlers: every command in action.yml has a matching handler
 *
 * SDK orchestration (chained query → response shape) is covered in
 * client.test.js and against a real Supabase instance later.
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { getString, getBool, maskSession, handlers } from '../src/main.js'
import { SupabaseError } from '../src/client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')

// ─────────────────── input mocking ───────────────────
// core.getInput reads from INPUT_<UPPERCASED_NAME> env vars. Tests set
// these directly — cheaper than module-level mocks and matches what the
// real action runtime does.

function setInput(name, value) {
  // @actions/core.getInput converts only spaces to underscores, NOT
  // hyphens — env var names can contain hyphens in Node's process.env.
  const envName = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`
  if (value === undefined) delete process.env[envName]
  else process.env[envName] = String(value)
}

function clearInputs(names) {
  for (const name of names) setInput(name, undefined)
}

// ─────────────────── getBool ───────────────────

describe('getBool', () => {
  const NAME = 'storage-upsert'

  afterEach(() => clearInputs([NAME]))

  it('returns the default when the input is unset', () => {
    assert.equal(getBool(NAME, false), false)
    assert.equal(getBool(NAME, true), true)
  })

  it('returns the default when the input is the empty string', () => {
    setInput(NAME, '')
    assert.equal(getBool(NAME, false), false)
    assert.equal(getBool(NAME, true), true)
  })

  it('accepts YAML-1.2 truthy variants', () => {
    for (const truthy of ['true', 'True', 'TRUE', 't', 'yes', 'YES', 'y', '1', 'on', 'ON']) {
      setInput(NAME, truthy)
      assert.equal(getBool(NAME, false), true, `expected '${truthy}' → true`)
    }
  })

  it('accepts YAML-1.2 falsy variants', () => {
    for (const falsy of ['false', 'False', 'FALSE', 'f', 'no', 'NO', 'n', '0', 'off', 'OFF']) {
      setInput(NAME, falsy)
      assert.equal(getBool(NAME, true), false, `expected '${falsy}' → false`)
    }
  })

  it('throws INVALID_BOOL on garbage values rather than silently defaulting', () => {
    setInput(NAME, 'maybe')
    assert.throws(
      () => getBool(NAME),
      (err) =>
        err instanceof SupabaseError &&
        err.code === 'INVALID_BOOL' &&
        err.message.includes(NAME) &&
        err.message.includes('maybe'),
    )
  })
})

// ─────────────────── getString ───────────────────

describe('getString', () => {
  const NAME = 'table'

  afterEach(() => clearInputs([NAME]))

  it('returns the raw value when present', () => {
    setInput(NAME, 'orders')
    assert.equal(getString(NAME), 'orders')
  })

  it('returns the default when value is empty', () => {
    setInput(NAME, '')
    assert.equal(getString(NAME, { defaultValue: 'public' }), 'public')
  })

  it('returns the raw value (not the default) when value is non-empty', () => {
    setInput(NAME, 'orders')
    assert.equal(getString(NAME, { defaultValue: 'public' }), 'orders')
  })

  it('returns empty string when value is empty and no default', () => {
    setInput(NAME, '')
    assert.equal(getString(NAME), '')
  })
})

// ─────────────────── maskSession ───────────────────

describe('maskSession', () => {
  // core.setSecret writes `::add-mask::<value>` to stdout in real runs.
  // Capture stdout to assert exactly what got masked.
  let captured
  let originalWrite

  beforeEach(() => {
    captured = []
    originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk, ...rest) => {
      captured.push(String(chunk))
      return originalWrite(chunk, ...rest)
    }
  })

  afterEach(() => {
    process.stdout.write = originalWrite
  })

  function maskedValues() {
    return captured
      .join('')
      .split('\n')
      .filter((line) => line.startsWith('::add-mask::'))
      .map((line) => line.replace(/^::add-mask::/, ''))
  }

  it('no-ops on null / undefined session', () => {
    maskSession(null)
    maskSession(undefined)
    assert.deepEqual(maskedValues(), [])
  })

  it('masks access_token when present', () => {
    maskSession({ access_token: 'jwt-abc' })
    assert.deepEqual(maskedValues(), ['jwt-abc'])
  })

  it('masks refresh_token when present', () => {
    maskSession({ refresh_token: 'refresh-xyz' })
    assert.deepEqual(maskedValues(), ['refresh-xyz'])
  })

  it('masks both access and refresh when both present', () => {
    maskSession({ access_token: 'a', refresh_token: 'r' })
    assert.deepEqual(maskedValues(), ['a', 'r'])
  })

  it('does not emit ::add-mask:: for falsy tokens', () => {
    maskSession({ access_token: '', refresh_token: null })
    assert.deepEqual(maskedValues(), [])
  })
})

// ─────────────────── handlers coverage ───────────────────

describe('handlers', () => {
  // The action.yml input doc enumerates commands as free-form text.
  // The w3-action.yaml manifest is the structured source of truth — it
  // lists every command under `commands:`. Confirm there is a handler
  // for each one.

  function readManifestCommands() {
    const text = readFileSync(join(REPO_ROOT, 'w3-action.yaml'), 'utf8')
    // Match `  - name: foo` (two-space indent under the `commands:` list).
    const matches = text.matchAll(/^\s{2}-\s+name:\s+([a-z][a-z0-9-]*)\s*$/gm)
    return Array.from(matches, (m) => m[1])
  }

  it('exposes one handler per command in w3-action.yaml', () => {
    const declared = readManifestCommands()
    assert.ok(declared.length >= 22, `expected >=22 commands, got ${declared.length}`)
    const missing = declared.filter((cmd) => typeof handlers[cmd] !== 'function')
    assert.deepEqual(missing, [], `commands missing handlers: ${missing.join(', ')}`)
  })

  it('does not export any handler that the manifest does not declare', () => {
    const declared = new Set(readManifestCommands())
    const extra = Object.keys(handlers).filter((cmd) => !declared.has(cmd))
    assert.deepEqual(extra, [], `handlers without manifest entry: ${extra.join(', ')}`)
  })
})
