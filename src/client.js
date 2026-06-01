/**
 * Supabase API client — wraps @supabase/supabase-js with one method per command.
 *
 * Design notes:
 *   - Inputs that are JSON (filter, data, user-metadata, etc.) come in as
 *     strings and are parsed here so the main.js handlers stay thin.
 *   - All public methods return plain objects/arrays ready for setJsonOutput.
 *   - Errors throw SupabaseError so downstream consumers can pattern-match
 *     on err.code. Supabase's own errors get translated into typed codes.
 */

import { Buffer } from 'node:buffer'

import { createClient } from '@supabase/supabase-js'
import { W3ActionError } from '@w3-io/action-core'

export class SupabaseError extends W3ActionError {
  constructor(code, message, { statusCode, details } = {}) {
    super(code, message, { statusCode, details })
    this.name = 'SupabaseError'
  }
}

// Map common Supabase / PostgREST error codes to our typed codes.
function translateError(err, fallbackCode = 'SUPABASE_ERROR') {
  if (!err) return new SupabaseError(fallbackCode, 'Unknown error')

  const code = err.code || err.status || err.statusCode
  const message = err.message || String(err)
  const details = err.details || err.hint || err.body || undefined

  // PostgREST and PostgreSQL error codes
  if (code === 'PGRST116') return new SupabaseError('NOT_FOUND', message, { details })
  if (code === '42501' || code === '42P01') {
    return new SupabaseError('PERMISSION_DENIED', message, { details })
  }
  if (code === '23505') return new SupabaseError('UNIQUE_VIOLATION', message, { details })
  if (code === '23503') return new SupabaseError('FOREIGN_KEY_VIOLATION', message, { details })

  // Auth errors
  if (code === 'invalid_grant') return new SupabaseError('AUTH_INVALID_CREDENTIALS', message, { details })
  if (code === 'user_not_found') return new SupabaseError('AUTH_USER_NOT_FOUND', message, { details })
  if (code === 'email_not_confirmed') return new SupabaseError('AUTH_EMAIL_NOT_CONFIRMED', message, { details })

  // HTTP-style
  if (code === 401 || code === '401') return new SupabaseError('UNAUTHORIZED', message, { statusCode: 401, details })
  if (code === 403 || code === '403') return new SupabaseError('FORBIDDEN', message, { statusCode: 403, details })
  if (code === 404 || code === '404') return new SupabaseError('NOT_FOUND', message, { statusCode: 404, details })

  return new SupabaseError(fallbackCode, message, { details })
}

function parseJsonInput(name, raw, { allowEmpty = false, defaultValue } = {}) {
  if (!raw || raw === '') {
    if (allowEmpty) return defaultValue
    throw new SupabaseError('MISSING_INPUT', `'${name}' is required`)
  }
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new SupabaseError('INVALID_JSON', `'${name}' is not valid JSON: ${err.message}`)
  }
}

function requireInput(name, value) {
  if (!value || value === '') {
    throw new SupabaseError('MISSING_INPUT', `'${name}' is required`)
  }
  return value
}

// Apply PostgREST filters to a query builder.
//   filter = { id: { eq: 5 }, status: { in: ["a", "b"] }, created_at: { gte: "2026-01-01" } }
const FILTER_OPS = new Set([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike',
  'is', 'in', 'contains', 'containedBy', 'rangeGt', 'rangeGte',
  'rangeLt', 'rangeLte', 'rangeAdjacent', 'overlaps', 'textSearch',
])

function applyFilter(query, filter) {
  if (!filter || Object.keys(filter).length === 0) return query
  for (const [column, ops] of Object.entries(filter)) {
    if (ops === null || typeof ops !== 'object') {
      query = query.eq(column, ops)
      continue
    }
    for (const [op, value] of Object.entries(ops)) {
      if (!FILTER_OPS.has(op)) {
        throw new SupabaseError(
          'INVALID_FILTER',
          `Unsupported filter operator '${op}' on column '${column}'. Allowed: ${Array.from(FILTER_OPS).join(', ')}`
        )
      }
      query = query[op](column, value)
    }
  }
  return query
}

function applyOrder(query, order) {
  if (!order) return query
  const orderList = Array.isArray(order) ? order : [order]
  for (const spec of orderList) {
    if (!spec.column) {
      throw new SupabaseError('INVALID_ORDER', "order entries require a 'column' field")
    }
    query = query.order(spec.column, {
      ascending: spec.ascending !== false,
      nullsFirst: spec.nullsFirst === true,
    })
  }
  return query
}

export class SupabaseSdkClient {
  constructor({ url, key, schema = 'public' } = {}) {
    if (!url) throw new SupabaseError('MISSING_URL', "'url' is required")
    if (!key) throw new SupabaseError('MISSING_KEY', "'key' is required")
    this.client = createClient(url, key, {
      db: { schema },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    this.url = url
  }

  // ─────────────────────────── Database ───────────────────────────

  async query({ table, schema = 'public', filter, select = '*', order, limit, offset }) {
    requireInput('table', table)
    let q = this.client.schema(schema).from(table).select(select)
    q = applyFilter(q, filter || {})
    q = applyOrder(q, order)
    if (limit !== undefined && limit !== '') q = q.limit(Number(limit))
    if (offset !== undefined && offset !== '') {
      const off = Number(offset)
      const lim = limit !== undefined && limit !== '' ? Number(limit) : 1000
      q = q.range(off, off + lim - 1)
    }
    const { data, error } = await q
    if (error) throw translateError(error, 'QUERY_FAILED')
    return { rows: data, count: data?.length ?? 0 }
  }

  async insert({ table, schema = 'public', data, returnRows = true }) {
    requireInput('table', table)
    const rows = data
    let q = this.client.schema(schema).from(table).insert(rows)
    if (returnRows) q = q.select('*')
    const { data: result, error } = await q
    if (error) throw translateError(error, 'INSERT_FAILED')
    return { rows: result, count: result?.length ?? 0 }
  }

  async upsert({ table, schema = 'public', data, onConflict, returnRows = true }) {
    requireInput('table', table)
    const opts = onConflict ? { onConflict } : undefined
    let q = this.client.schema(schema).from(table).upsert(data, opts)
    if (returnRows) q = q.select('*')
    const { data: result, error } = await q
    if (error) throw translateError(error, 'UPSERT_FAILED')
    return { rows: result, count: result?.length ?? 0 }
  }

  async update({ table, schema = 'public', filter, data, returnRows = true }) {
    requireInput('table', table)
    if (!filter || Object.keys(filter).length === 0) {
      throw new SupabaseError(
        'UNSAFE_UPDATE',
        'update requires a non-empty filter. To update all rows intentionally, pass {"id":{"neq":null}} or similar.'
      )
    }
    let q = this.client.schema(schema).from(table).update(data)
    q = applyFilter(q, filter)
    if (returnRows) q = q.select('*')
    const { data: result, error } = await q
    if (error) throw translateError(error, 'UPDATE_FAILED')
    return { rows: result, count: result?.length ?? 0 }
  }

  async delete({ table, schema = 'public', filter, returnRows = true }) {
    requireInput('table', table)
    if (!filter || Object.keys(filter).length === 0) {
      throw new SupabaseError(
        'UNSAFE_DELETE',
        'delete requires a non-empty filter. To delete all rows intentionally, pass {"id":{"neq":null}} or similar.'
      )
    }
    let q = this.client.schema(schema).from(table).delete()
    q = applyFilter(q, filter)
    if (returnRows) q = q.select('*')
    const { data: result, error } = await q
    if (error) throw translateError(error, 'DELETE_FAILED')
    return { rows: result, count: result?.length ?? 0 }
  }

  async count({ table, schema = 'public', filter }) {
    requireInput('table', table)
    let q = this.client
      .schema(schema)
      .from(table)
      .select('*', { count: 'exact', head: true })
    q = applyFilter(q, filter || {})
    const { count, error } = await q
    if (error) throw translateError(error, 'COUNT_FAILED')
    return { count }
  }

  async rpc({ schema = 'public', name, params }) {
    requireInput('rpc-name', name)
    const { data, error } = await this.client.schema(schema).rpc(name, params || {})
    if (error) throw translateError(error, 'RPC_FAILED')
    return { result: data }
  }

  // ──────────────────────────── Auth ────────────────────────────

  async authSignUp({ email, password, userMetadata, redirectTo }) {
    requireInput('email', email)
    requireInput('password', password)
    const { data, error } = await this.client.auth.signUp({
      email,
      password,
      options: {
        data: userMetadata || {},
        ...(redirectTo ? { emailRedirectTo: redirectTo } : {}),
      },
    })
    if (error) throw translateError(error, 'AUTH_SIGN_UP_FAILED')
    return { user: data.user, session: data.session }
  }

  async authSignInPassword({ email, password }) {
    requireInput('email', email)
    requireInput('password', password)
    const { data, error } = await this.client.auth.signInWithPassword({ email, password })
    if (error) throw translateError(error, 'AUTH_SIGN_IN_FAILED')
    return { user: data.user, session: data.session }
  }

  async authSignInOtp({ email, redirectTo }) {
    requireInput('email', email)
    const { data, error } = await this.client.auth.signInWithOtp({
      email,
      options: redirectTo ? { emailRedirectTo: redirectTo } : undefined,
    })
    if (error) throw translateError(error, 'AUTH_OTP_FAILED')
    return { sent: true, email, ...data }
  }

  async authSignOut({ jwt }) {
    requireInput('jwt', jwt)
    // Use a request-scoped client so we sign out the specific session, not the global one.
    const { error } = await this.client.auth.admin.signOut(jwt)
    if (error) throw translateError(error, 'AUTH_SIGN_OUT_FAILED')
    return { signedOut: true }
  }

  async authGetUser({ jwt }) {
    requireInput('jwt', jwt)
    const { data, error } = await this.client.auth.getUser(jwt)
    if (error) throw translateError(error, 'AUTH_GET_USER_FAILED')
    return { user: data.user }
  }

  async authUpdateUser({ jwt, email, password, userMetadata }) {
    requireInput('jwt', jwt)
    if (!email && !password && (!userMetadata || Object.keys(userMetadata).length === 0)) {
      throw new SupabaseError(
        'NO_UPDATES',
        'auth-update-user requires at least one of: email, password, user-metadata'
      )
    }
    // Set the JWT on the client so updateUser updates the right user.
    await this.client.auth.setSession({ access_token: jwt, refresh_token: '' })
    const updates = {}
    if (email) updates.email = email
    if (password) updates.password = password
    if (userMetadata && Object.keys(userMetadata).length > 0) updates.data = userMetadata
    const { data, error } = await this.client.auth.updateUser(updates)
    if (error) throw translateError(error, 'AUTH_UPDATE_USER_FAILED')
    return { user: data.user }
  }

  async authVerifyJwt({ jwt }) {
    requireInput('jwt', jwt)
    const { data, error } = await this.client.auth.getUser(jwt)
    if (error) {
      // Distinguish "expired" vs "invalid" vs other for clearer downstream branching.
      const message = error.message || ''
      if (message.toLowerCase().includes('expired')) {
        throw new SupabaseError('JWT_EXPIRED', message)
      }
      if (message.toLowerCase().includes('invalid')) {
        throw new SupabaseError('JWT_INVALID', message)
      }
      throw translateError(error, 'JWT_VERIFY_FAILED')
    }
    return { valid: true, user: data.user }
  }

  async authResetPassword({ email, redirectTo }) {
    requireInput('email', email)
    const { data, error } = await this.client.auth.resetPasswordForEmail(email, {
      ...(redirectTo ? { redirectTo } : {}),
    })
    if (error) throw translateError(error, 'AUTH_RESET_PASSWORD_FAILED')
    return { sent: true, email, ...data }
  }

  // ───────────────────────────── Storage ─────────────────────────────

  async storageUpload({ bucket, path, fileContentBase64, contentType }) {
    requireInput('bucket', bucket)
    requireInput('path', path)
    requireInput('file-content', fileContentBase64)
    const bytes = Buffer.from(fileContentBase64, 'base64')
    const { data, error } = await this.client.storage
      .from(bucket)
      .upload(path, bytes, {
        contentType: contentType || 'application/octet-stream',
        upsert: true,
      })
    if (error) throw translateError(error, 'STORAGE_UPLOAD_FAILED')
    return { path: data.path, fullPath: data.fullPath, id: data.id }
  }

  async storageDownload({ bucket, path }) {
    requireInput('bucket', bucket)
    requireInput('path', path)
    const { data, error } = await this.client.storage.from(bucket).download(path)
    if (error) throw translateError(error, 'STORAGE_DOWNLOAD_FAILED')
    const arrayBuf = await data.arrayBuffer()
    const base64 = Buffer.from(arrayBuf).toString('base64')
    return {
      path,
      contentType: data.type,
      byteSize: arrayBuf.byteLength,
      contentBase64: base64,
    }
  }

  async storageList({ bucket, path = '', limit, offset }) {
    requireInput('bucket', bucket)
    const opts = {}
    if (limit !== undefined && limit !== '') opts.limit = Number(limit)
    if (offset !== undefined && offset !== '') opts.offset = Number(offset)
    const { data, error } = await this.client.storage.from(bucket).list(path, opts)
    if (error) throw translateError(error, 'STORAGE_LIST_FAILED')
    return { files: data }
  }

  async storageDelete({ bucket, path }) {
    requireInput('bucket', bucket)
    requireInput('path', path)
    const { data, error } = await this.client.storage.from(bucket).remove([path])
    if (error) throw translateError(error, 'STORAGE_DELETE_FAILED')
    return { deleted: data }
  }

  async storageGetSignedUrl({ bucket, path, expiresIn = 3600 }) {
    requireInput('bucket', bucket)
    requireInput('path', path)
    const { data, error } = await this.client.storage
      .from(bucket)
      .createSignedUrl(path, Number(expiresIn))
    if (error) throw translateError(error, 'STORAGE_SIGNED_URL_FAILED')
    return { signedUrl: data.signedUrl, expiresIn: Number(expiresIn) }
  }

  async storageGetPublicUrl({ bucket, path }) {
    requireInput('bucket', bucket)
    requireInput('path', path)
    const { data } = this.client.storage.from(bucket).getPublicUrl(path)
    return { publicUrl: data.publicUrl }
  }

  async storageMove({ bucket, path, destinationPath }) {
    requireInput('bucket', bucket)
    requireInput('path', path)
    requireInput('destination-path', destinationPath)
    const { data, error } = await this.client.storage.from(bucket).move(path, destinationPath)
    if (error) throw translateError(error, 'STORAGE_MOVE_FAILED')
    return { from: path, to: destinationPath, message: data?.message }
  }

  async storageCopy({ bucket, path, destinationPath }) {
    requireInput('bucket', bucket)
    requireInput('path', path)
    requireInput('destination-path', destinationPath)
    const { data, error } = await this.client.storage.from(bucket).copy(path, destinationPath)
    if (error) throw translateError(error, 'STORAGE_COPY_FAILED')
    return { from: path, to: destinationPath, path: data?.path }
  }

  // ─────────────────────────── Functions ───────────────────────────

  async invokeFunction({ name, body, headers }) {
    requireInput('function-name', name)
    const { data, error } = await this.client.functions.invoke(name, {
      body: body !== undefined ? body : undefined,
      headers: headers || undefined,
    })
    if (error) throw translateError(error, 'FUNCTION_INVOKE_FAILED')
    return { response: data }
  }
}

// Helper used by main.js — accept raw input strings and build a typed args object.
export { parseJsonInput, requireInput }
