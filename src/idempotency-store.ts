import type { Store } from './db/store.js'

export interface IdempotencyScope {
  key: string
  apiKeyHash: string
  method: string
  path: string
  requestHash: string
}

export type IdempotencyLookup =
  | { status: 'miss' }
  | { status: 'hit-match'; body: string; responseStatus: number }
  | { status: 'hit-mismatch' }

type StoredRow = {
  request_hash: string
  response_status: number
  response_body: string
}

function assertApiKeyHash(scope: IdempotencyScope): void {
  if (scope.apiKeyHash === '') {
    throw new Error(
      'idempotency-store: apiKeyHash must be non-empty — callers must skip idempotency for unauthenticated requests (REST decision #22, MCP decision #16)',
    )
  }
}

export function lookupIdempotencyRecord(store: Store, scope: IdempotencyScope): IdempotencyLookup {
  assertApiKeyHash(scope)
  const row = store.db
    .prepare(
      `SELECT request_hash, response_status, response_body
         FROM idempotency_keys
        WHERE key = ? AND api_key_hash = ? AND method = ? AND path = ?`,
    )
    .get(scope.key, scope.apiKeyHash, scope.method, scope.path) as StoredRow | undefined

  if (!row) return { status: 'miss' }
  if (row.request_hash !== scope.requestHash) return { status: 'hit-mismatch' }
  return {
    status: 'hit-match',
    body: row.response_body,
    responseStatus: row.response_status,
  }
}

export function recordIdempotencyResponse(
  store: Store,
  scope: IdempotencyScope,
  body: string,
  responseStatus: number,
): void {
  assertApiKeyHash(scope)
  store.db
    .prepare(
      `INSERT INTO idempotency_keys
         (key, api_key_hash, method, path, request_hash, response_status, response_body)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      scope.key,
      scope.apiKeyHash,
      scope.method,
      scope.path,
      scope.requestHash,
      responseStatus,
      body,
    )
}
