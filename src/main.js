import * as core from '@actions/core'
import { createCommandRouter, setJsonOutput, handleError } from '@w3-io/action-core'
import { SupabaseSdkClient, SupabaseError, parseJsonInput } from './client.js'

// Mask any session tokens before they hit $GITHUB_OUTPUT or run logs.
// Without this, downstream `run:` steps that echo outputs.result would
// leak the access_token AND the long-lived refresh_token.
function maskSession(session) {
  if (!session) return
  if (session.access_token) core.setSecret(session.access_token)
  if (session.refresh_token) core.setSecret(session.refresh_token)
}

/**
 * W3 Supabase Action — command dispatch.
 *
 * Each handler:
 *   1. Reads typed inputs via @actions/core
 *   2. Parses JSON inputs where needed
 *   3. Calls the matching SupabaseSdkClient method
 *   4. Sets the JSON output via setJsonOutput
 *
 * Adding a command:
 *   1. Add the handler here
 *   2. Add a matching method on SupabaseSdkClient in client.js
 *   3. Document in action.yml, w3-action.yaml, README.md
 */

const VALID_KEY_TYPES = new Set(['service-role', 'anon', ''])

function getClient() {
  // key-type is informational today but we validate it now so typos
  // (e.g. "anonymous", "service") fail fast instead of being silently
  // ignored — caught at the start of the run, not at the API call.
  const keyType = core.getInput('key-type')
  if (!VALID_KEY_TYPES.has(keyType)) {
    throw new SupabaseError(
      'INVALID_KEY_TYPE',
      `key-type must be 'service-role' or 'anon' (got: ${keyType})`,
    )
  }
  return new SupabaseSdkClient({
    url: core.getInput('url', { required: true }),
    key: core.getInput('key', { required: true }),
    schema: core.getInput('schema') || 'public',
  })
}

function getString(name, { required = false, defaultValue = '' } = {}) {
  const v = core.getInput(name, { required })
  return v === '' && defaultValue !== '' ? defaultValue : v
}

// Boolean parser that accepts YAML-1.2 truthy/falsy variants. Raises on
// truly unexpected values rather than silently defaulting to false.
function getBool(name, defaultValue = false) {
  const raw = core.getInput(name)
  if (raw === '' || raw === undefined) return defaultValue
  const v = raw.toLowerCase()
  if (['true', 't', 'yes', 'y', '1', 'on'].includes(v)) return true
  if (['false', 'f', 'no', 'n', '0', 'off'].includes(v)) return false
  throw new SupabaseError(
    'INVALID_BOOL',
    `Input '${name}' must be a boolean (true/false), got: ${raw}`,
  )
}

const handlers = {
  // ───── Database ─────

  query: async () => {
    const client = getClient()
    const result = await client.query({
      table: getString('table', { required: true }),
      schema: getString('schema', { defaultValue: 'public' }),
      filter: parseJsonInput('filter', core.getInput('filter'), {
        allowEmpty: true,
        defaultValue: {},
      }),
      select: getString('select', { defaultValue: '*' }),
      order: parseJsonInput('order', core.getInput('order'), { allowEmpty: true }),
      limit: getString('limit'),
      offset: getString('offset'),
      singleRow: getBool('single-row', false),
    })
    setJsonOutput('result', result)
  },

  insert: async () => {
    const client = getClient()
    const result = await client.insert({
      table: getString('table', { required: true }),
      schema: getString('schema', { defaultValue: 'public' }),
      data: parseJsonInput('data', core.getInput('data')),
      returnRows: getBool('return-rows', true),
    })
    setJsonOutput('result', result)
  },

  upsert: async () => {
    const client = getClient()
    const result = await client.upsert({
      table: getString('table', { required: true }),
      schema: getString('schema', { defaultValue: 'public' }),
      data: parseJsonInput('data', core.getInput('data')),
      onConflict: getString('on-conflict') || undefined,
      returnRows: getBool('return-rows', true),
    })
    setJsonOutput('result', result)
  },

  update: async () => {
    const client = getClient()
    const result = await client.update({
      table: getString('table', { required: true }),
      schema: getString('schema', { defaultValue: 'public' }),
      filter: parseJsonInput('filter', core.getInput('filter'), {
        allowEmpty: true,
        defaultValue: {},
      }),
      data: parseJsonInput('data', core.getInput('data')),
      returnRows: getBool('return-rows', true),
    })
    setJsonOutput('result', result)
  },

  delete: async () => {
    const client = getClient()
    const result = await client.delete({
      table: getString('table', { required: true }),
      schema: getString('schema', { defaultValue: 'public' }),
      filter: parseJsonInput('filter', core.getInput('filter'), {
        allowEmpty: true,
        defaultValue: {},
      }),
      returnRows: getBool('return-rows', true),
    })
    setJsonOutput('result', result)
  },

  count: async () => {
    const client = getClient()
    const result = await client.count({
      table: getString('table', { required: true }),
      schema: getString('schema', { defaultValue: 'public' }),
      filter: parseJsonInput('filter', core.getInput('filter'), {
        allowEmpty: true,
        defaultValue: {},
      }),
    })
    setJsonOutput('result', result)
  },

  rpc: async () => {
    const client = getClient()
    const result = await client.rpc({
      schema: getString('schema', { defaultValue: 'public' }),
      name: getString('rpc-name', { required: true }),
      params: parseJsonInput('rpc-params', core.getInput('rpc-params'), {
        allowEmpty: true,
        defaultValue: {},
      }),
    })
    setJsonOutput('result', result)
  },

  // ───── Auth ─────

  'auth-sign-up': async () => {
    const client = getClient()
    const result = await client.authSignUp({
      email: getString('email', { required: true }),
      password: getString('password', { required: true }),
      userMetadata: parseJsonInput('user-metadata', core.getInput('user-metadata'), {
        allowEmpty: true,
        defaultValue: {},
      }),
      redirectTo: getString('redirect-to') || undefined,
    })
    maskSession(result.session)
    setJsonOutput('result', result)
  },

  'auth-sign-in-password': async () => {
    const client = getClient()
    const result = await client.authSignInPassword({
      email: getString('email', { required: true }),
      password: getString('password', { required: true }),
    })
    maskSession(result.session)
    setJsonOutput('result', result)
  },

  'auth-sign-in-otp': async () => {
    const client = getClient()
    const result = await client.authSignInOtp({
      email: getString('email', { required: true }),
      redirectTo: getString('redirect-to') || undefined,
    })
    setJsonOutput('result', result)
  },

  'auth-sign-out': async () => {
    const client = getClient()
    const result = await client.authSignOut({
      jwt: getString('jwt', { required: true }),
    })
    setJsonOutput('result', result)
  },

  'auth-get-user': async () => {
    const client = getClient()
    const result = await client.authGetUser({
      jwt: getString('jwt', { required: true }),
    })
    setJsonOutput('result', result)
  },

  'auth-update-user': async () => {
    const client = getClient()
    const result = await client.authUpdateUser({
      jwt: getString('jwt', { required: true }),
      email: getString('email') || undefined,
      password: getString('password') || undefined,
      userMetadata: parseJsonInput('user-metadata', core.getInput('user-metadata'), {
        allowEmpty: true,
        defaultValue: {},
      }),
    })
    setJsonOutput('result', result)
  },

  'auth-verify-jwt': async () => {
    const client = getClient()
    const result = await client.authVerifyJwt({
      jwt: getString('jwt', { required: true }),
    })
    setJsonOutput('result', result)
  },

  'auth-reset-password': async () => {
    const client = getClient()
    const result = await client.authResetPassword({
      email: getString('email', { required: true }),
      redirectTo: getString('redirect-to') || undefined,
    })
    setJsonOutput('result', result)
  },

  // ───── Storage ─────

  'storage-upload': async () => {
    const client = getClient()
    const result = await client.storageUpload({
      bucket: getString('bucket', { required: true }),
      path: getString('path', { required: true }),
      fileContentBase64: getString('file-content', { required: true }),
      contentType: getString('content-type', { defaultValue: 'application/octet-stream' }),
      upsert: getBool('storage-upsert', false),
    })
    setJsonOutput('result', result)
  },

  'storage-download': async () => {
    const client = getClient()
    const result = await client.storageDownload({
      bucket: getString('bucket', { required: true }),
      path: getString('path', { required: true }),
    })
    setJsonOutput('result', result)
  },

  'storage-list': async () => {
    const client = getClient()
    const result = await client.storageList({
      bucket: getString('bucket', { required: true }),
      path: getString('path'),
      limit: getString('limit'),
      offset: getString('offset'),
    })
    setJsonOutput('result', result)
  },

  'storage-delete': async () => {
    const client = getClient()
    const result = await client.storageDelete({
      bucket: getString('bucket', { required: true }),
      path: getString('path'),
      // `paths` is a JSON array; if absent, falls back to single `path`.
      paths: parseJsonInput('paths', core.getInput('paths'), {
        allowEmpty: true,
      }),
    })
    setJsonOutput('result', result)
  },

  'storage-get-signed-url': async () => {
    const client = getClient()
    const result = await client.storageGetSignedUrl({
      bucket: getString('bucket', { required: true }),
      path: getString('path', { required: true }),
      expiresIn: getString('expires-in', { defaultValue: '3600' }),
    })
    setJsonOutput('result', result)
  },

  'storage-get-public-url': async () => {
    const client = getClient()
    const result = await client.storageGetPublicUrl({
      bucket: getString('bucket', { required: true }),
      path: getString('path', { required: true }),
    })
    setJsonOutput('result', result)
  },

  'storage-move': async () => {
    const client = getClient()
    const result = await client.storageMove({
      bucket: getString('bucket', { required: true }),
      path: getString('path', { required: true }),
      destinationPath: getString('destination-path', { required: true }),
    })
    setJsonOutput('result', result)
  },

  'storage-copy': async () => {
    const client = getClient()
    const result = await client.storageCopy({
      bucket: getString('bucket', { required: true }),
      path: getString('path', { required: true }),
      destinationPath: getString('destination-path', { required: true }),
    })
    setJsonOutput('result', result)
  },

  // ───── Functions ─────

  'invoke-function': async () => {
    const client = getClient()
    // Edge Functions accept JSON or raw strings. If function-body parses
    // as JSON, send the parsed object; otherwise send the raw string.
    const rawBody = core.getInput('function-body')
    let body
    if (rawBody !== '' && rawBody !== undefined) {
      try {
        body = JSON.parse(rawBody)
      } catch {
        body = rawBody
      }
    }
    const result = await client.invokeFunction({
      name: getString('function-name', { required: true }),
      body,
      headers: parseJsonInput('function-headers', core.getInput('function-headers'), {
        allowEmpty: true,
        defaultValue: {},
      }),
    })
    setJsonOutput('result', result)
  },
}

const router = createCommandRouter(handlers)

export async function run() {
  try {
    await router()
  } catch (error) {
    if (error instanceof SupabaseError) {
      core.setFailed(`${error.code}: ${error.message}`)
    } else {
      handleError(error)
    }
  }
}

// Exported for unit tests — exercises the input-parsing layer without
// running through the full router/SDK stack.
export { getString, getBool, maskSession, handlers }
