import type { Context } from 'hono'
import type { Db } from '../db.ts'
import type { DaemonCellRegistry } from '../daemon/cell/contracts.ts'
import {
  generateDeliveryId,
  generateRequestId,
  type DaemonOutboundEnvelope,
} from '../daemon/cell/protocol.ts'
import { cellTrace } from '../logger.ts'
import type { ServerReportedIp } from '../server-addresses.ts'
import {
  getPublicUrls,
  parsePublicUrlEntries,
  setPublicUrls,
} from './public-urls.ts'
import {
  REENCRYPT_BATCH_SIZE,
  REENCRYPT_STAGES,
  type ReencryptCursor,
  type ReencryptStage,
} from './reencrypt-secrets.ts'

// Cert apply runs ansible + often a full Caddy restart (admin is off, so
// reload fails). Observed ~60s wall time; keep headroom above that.
const PUBLIC_URLS_APPLY_TIMEOUT_MS = 180_000

function nowTs(): string {
  return new Date().toISOString()
}

export const MAX_CELL_PURGE_BATCH_SIZE = 200

export function resolvePlatformEnv(
  c: Context,
  opts: { getEnv?: () => Record<string, string | undefined> },
): Record<string, string | undefined> {
  const fromContext = c.get('platformEnv')
  if (fromContext) return fromContext
  if (opts.getEnv) return opts.getEnv()
  return {}
}

export function extractAddresses(record: { status: string; result?: unknown }): ServerReportedIp[] {
  if (record.status !== 'done') {
    throw new Error(record.status === 'expired'
      ? 'timeout waiting for addresses'
      : 'failed to fetch addresses')
  }
  const result = record.result as { ips?: ServerReportedIp[] } | undefined
  if (!result?.ips) throw new Error('missing ips in daemon response')
  return result.ips
}

export type PublicUrlsApplyUrlsResult =
  | { ok: true; urls: string[] }
  | { ok: false; status: 400 | 422; body: unknown }

export async function resolvePublicUrlsForApply(
  db: Db,
  body: unknown,
  allowHttp: boolean,
): Promise<PublicUrlsApplyUrlsResult> {
  if (body && typeof body === 'object' && 'urls' in body) {
    const urlsBody = body as { urls: unknown }
    if (
      !Array.isArray(urlsBody.urls) ||
      !urlsBody.urls.every((u: unknown) => typeof u === 'string')
    ) {
      return {
        ok: false,
        status: 400,
        body: { ok: false, error: 'expected { urls?: string[] }' },
      }
    }
    const parsed = parsePublicUrlEntries(urlsBody.urls, { allowHttp })
    if (!parsed.ok) {
      return { ok: false, status: 422, body: parsed }
    }
    await setPublicUrls(db, parsed.urls)
    return { ok: true, urls: parsed.urls }
  }
  return { ok: true, urls: await getPublicUrls(db) }
}

export type ReencryptRequestParse =
  | { ok: true; cursor: ReencryptCursor | null; limit: number }
  | { ok: false; error: string }

export function isReencryptStage(value: unknown): value is ReencryptStage {
  return typeof value === 'string' &&
    (REENCRYPT_STAGES as readonly string[]).includes(value)
}

export function parseReencryptRequestBody(body: unknown): ReencryptRequestParse {
  if (body === null || body === undefined) {
    return { ok: true, cursor: null, limit: REENCRYPT_BATCH_SIZE }
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'expected { cursor?, limit? }' }
  }

  const record = body as Record<string, unknown>
  let limit = REENCRYPT_BATCH_SIZE
  if (record.limit !== undefined) {
    if (typeof record.limit !== 'number' || !Number.isInteger(record.limit) || record.limit < 1) {
      return { ok: false, error: 'limit must be a positive integer' }
    }
    // Cap to the server batch size so clients cannot request unbounded work.
    limit = Math.min(record.limit, REENCRYPT_BATCH_SIZE)
  }

  if (record.cursor === undefined || record.cursor === null) {
    return { ok: true, cursor: null, limit }
  }
  if (typeof record.cursor !== 'object' || Array.isArray(record.cursor)) {
    return { ok: false, error: 'cursor must be an object' }
  }

  const cursorObj = record.cursor as Record<string, unknown>
  if (!isReencryptStage(cursorObj.stage)) {
    return { ok: false, error: 'cursor.stage is required' }
  }

  const cursor: ReencryptCursor = { stage: cursorObj.stage }
  if (cursorObj.afterId !== undefined) {
    if (typeof cursorObj.afterId !== 'string' || cursorObj.afterId.length === 0) {
      return { ok: false, error: 'cursor.afterId must be a non-empty string' }
    }
    cursor.afterId = cursorObj.afterId
  }

  return { ok: true, cursor, limit }
}

export type PayloadBodyParse =
  | { ok: true; payload: unknown }
  | { ok: false; error: string }

export function parsePayloadBody(body: unknown): PayloadBodyParse {
  if (!body || typeof body !== 'object' || !('payload' in body)) {
    return { ok: false, error: 'expected { payload: unknown }' }
  }
  return { ok: true, payload: (body as { payload: unknown }).payload }
}

export type CellPurgeBatchParse =
  | { ok: true; serverIds: string[] }
  | { ok: false; error: string }

export function parseCellPurgeBatchBody(body: unknown): CellPurgeBatchParse {
  if (
    !body ||
    typeof body !== 'object' ||
    !Array.isArray((body as { serverIds?: unknown }).serverIds) ||
    (body as { serverIds: unknown[] }).serverIds.length === 0 ||
    !(body as { serverIds: unknown[] }).serverIds.every(
      (id: unknown) => typeof id === 'string' && id.length > 0,
    )
  ) {
    return { ok: false, error: 'expected { serverIds: string[] } with at least one id' }
  }
  const serverIds = (body as { serverIds: string[] }).serverIds
  if (serverIds.length > MAX_CELL_PURGE_BATCH_SIZE) {
    return {
      ok: false,
      error: `serverIds exceeds maximum batch size of ${MAX_CELL_PURGE_BATCH_SIZE}`,
    }
  }
  return { ok: true, serverIds }
}

export type SignupEnabledParse =
  | { ok: true; enabled: boolean }
  | { ok: false; error: string }

export function parseSignupEnabledBody(body: unknown): SignupEnabledParse {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'expected { enabled: boolean }' }
  }
  const enabled = (body as { enabled?: unknown }).enabled
  if (typeof enabled !== 'boolean') {
    return { ok: false, error: 'expected { enabled: boolean }' }
  }
  return { ok: true, enabled }
}

export function parseEmailSettingsUpdates(
  body: unknown,
): Record<string, string | null> | null {
  if (!body || typeof body !== 'object') {
    return null
  }
  const updates: Record<string, string | null> = {}
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === 'string' || value === null) updates[key] = value
  }
  return updates
}

export type GithubAppUpdates = {
  appId?: string
  appSlug?: string | null
  clientId?: string | null
  privateKeyPem?: string
  webhookSecret?: string | null
}

/**
 * Parse the GitHub App configuration payload. Only supplied keys are returned,
 * so a PUT that omits `privateKeyPem` keeps the stored (sealed) key.
 */
export function parseGithubAppUpdates(body: unknown): GithubAppUpdates | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const raw = body as Record<string, unknown>
  const updates: GithubAppUpdates = {}

  for (const key of ['appId', 'privateKeyPem'] as const) {
    if (!(key in raw)) continue
    if (typeof raw[key] !== 'string' || raw[key].trim().length === 0) return null
    updates[key] = raw[key] as string
  }

  for (const key of ['appSlug', 'clientId', 'webhookSecret'] as const) {
    if (!(key in raw)) continue
    const value = raw[key]
    if (value !== null && typeof value !== 'string') return null
    updates[key] = value as string | null
  }

  return Object.keys(updates).length > 0 ? updates : null
}

export type GitlabOauthUpdates = {
  clientId?: string
  clientSecret?: string
  redirectUri?: string | null
  baseUrl?: string | null
  webhookSecret?: string | null
}

/**
 * Parse the GitLab OAuth application payload. Same partial-update contract as
 * {@link parseGithubAppUpdates}: only supplied keys are returned, so a PUT that
 * omits `clientSecret` keeps the stored (sealed) one, and an explicit `null`
 * clears one of the nullable fields.
 *
 * `baseUrl` is the operator's GitLab origin — omitted or cleared, the config
 * layer falls back to `https://gitlab.com`. It is not validated here: URL
 * shape is `setGitlabOauthConfig`'s rule, and it reports a
 * `GitlabOauthConfigError` the route turns into a `400` with the real reason.
 */
export function parseGitlabOauthUpdates(body: unknown): GitlabOauthUpdates | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const raw = body as Record<string, unknown>
  const updates: GitlabOauthUpdates = {}

  for (const key of ['clientId', 'clientSecret'] as const) {
    if (!(key in raw)) continue
    if (typeof raw[key] !== 'string' || raw[key].trim().length === 0) return null
    updates[key] = raw[key] as string
  }

  for (const key of ['redirectUri', 'baseUrl', 'webhookSecret'] as const) {
    if (!(key in raw)) continue
    const value = raw[key]
    if (value !== null && typeof value !== 'string') return null
    updates[key] = value as string | null
  }

  return Object.keys(updates).length > 0 ? updates : null
}

export function resolvePerServerLimit(limitRaw: string | undefined): number {
  const limit = Number(limitRaw ?? 50)
  return Number.isFinite(limit) ? limit : 50
}

export type PublicUrlsApplyWaitResult =
  | { kind: 'done' }
  | { kind: 'failed'; error: string }
  | { kind: 'timeout' }
  | { kind: 'error'; error: string }

export type PublicUrlsApplyHttpResult =
  | { status: 200; body: { ok: true; applied: true } }
  | { status: 500; body: { ok: false; applied: false; error: string } }

export function publicUrlsApplyWaitToResponse(
  result: PublicUrlsApplyWaitResult,
): PublicUrlsApplyHttpResult {
  switch (result.kind) {
    case 'done':
      return { status: 200, body: { ok: true, applied: true } }
    case 'timeout':
      return {
        status: 500,
        body: { ok: false, applied: false, error: 'timeout waiting for daemon' },
      }
    case 'failed':
    case 'error':
      return {
        status: 500,
        body: { ok: false, applied: false, error: result.error },
      }
  }
}

/**
 * Ask the co-located daemon to apply public URLs and wait for a correlated reply.
 */
export async function waitForPublicUrlsApply(
  registry: DaemonCellRegistry,
  serverId: string,
  urls: string[],
): Promise<PublicUrlsApplyWaitResult> {
  const requestId = generateRequestId()
  cellTrace('request-start', {
    requestId,
    serverId,
    kind: 'public-urls-update',
  })
  const envelope: DaemonOutboundEnvelope = {
    kind: 'public-urls-update',
    deliveryId: generateDeliveryId(),
    requestId,
    at: nowTs(),
    urls,
  }
  cellTrace('request-enqueued', {
    requestId,
    serverId,
    kind: 'public-urls-update',
    deliveryId: envelope.deliveryId,
  })

  try {
    const record = await registry.getCell(serverId).createRequestAndWait(
      envelope,
      PUBLIC_URLS_APPLY_TIMEOUT_MS,
    )
    if (record.status === 'done') {
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'public-urls-update',
        pendingStatus: record.status,
        resultStatus: 'done',
      })
      return { kind: 'done' }
    }
    if (record.status === 'failed') {
      const error = record.error ?? 'daemon reported failure'
      cellTrace('request-result', {
        requestId,
        serverId,
        kind: 'public-urls-update',
        pendingStatus: record.status,
        resultStatus: 'failed',
        error,
      })
      return { kind: 'failed', error }
    }
    cellTrace('request-result', {
      requestId,
      serverId,
      kind: 'public-urls-update',
      pendingStatus: record.status,
      resultStatus: 'timeout',
      error: 'timeout waiting for daemon',
    })
    return { kind: 'timeout' }
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err)
    cellTrace('request-result', {
      requestId,
      serverId,
      kind: 'public-urls-update',
      resultStatus: 'error',
      error: errMessage,
    })
    return { kind: 'error', error: errMessage }
  }
}
