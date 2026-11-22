import { isManagedEngineCode, type ManagedEngineSpec } from './index.ts'
import type { ManagedSslMode } from './ssl.ts'
import { type ManagedConnectionInfo, type ManagedEngineCode, parseManagedStatus } from './types.ts'

export type ManagedResidualMetadata = {
  rootLoginId?: string
  rootUsername?: string
  host?: string
  port?: number
  error?: string
  /** Counter of primary moves (`primary-epoch.ts`); kept when metadata is rewritten. */
  primaryEpoch?: number
}

export function parseManagedResidual(value: unknown): ManagedResidualMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  const record = value as Record<string, unknown>
  return {
    ...(typeof record.rootLoginId === 'string' ? { rootLoginId: record.rootLoginId } : {}),
    ...(typeof record.rootUsername === 'string' ? { rootUsername: record.rootUsername } : {}),
    ...(typeof record.host === 'string' ? { host: record.host } : {}),
    ...(typeof record.port === 'number' ? { port: record.port } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
    ...(Number.isInteger(record.primaryEpoch) && (record.primaryEpoch as number) >= 0
      ? { primaryEpoch: record.primaryEpoch as number }
      : {}),
  }
}

/**
 * True for a cluster whose first apply never finished: still `provisioning`, or
 * `failed` before any apply reported a listener address. A successful primary
 * apply is the only thing that records `metadata.host`, so a failed row that
 * has one ran before and its data may exist; a failed row without one has
 * nothing running and is safe to retry from scratch.
 */
export function isManagedNeverProvisioned(row: {
  status: string | null
  metadata: unknown
}): boolean {
  if (row.status !== 'provisioning' && row.status !== 'failed') return false
  return parseManagedResidual(row.metadata).host === undefined
}

/** How long a retry that started in place counts as still running. */
export const MANAGED_RETRY_WINDOW_MS = 10 * 60 * 1000

/**
 * A retry in place marks the row it moves back to `provisioning` with
 * `metadata.retryStartedAt`. `running` while the marker is fresh (the row must
 * not be treated as an abandoned create); `stale` once it has outlived the
 * window (the retry died, so the row can be retried again); `null` otherwise.
 */
export function managedRetryState(
  row: { status: string | null; metadata: unknown },
  now: number
): 'running' | 'stale' | null {
  if (row.status !== 'provisioning') return null
  const marker =
    typeof row.metadata === 'object' && row.metadata !== null
      ? (row.metadata as Record<string, unknown>).retryStartedAt
      : undefined
  if (typeof marker !== 'string') return null
  const started = Date.parse(marker)
  if (Number.isNaN(started)) return 'stale'
  return now - started < MANAGED_RETRY_WINDOW_MS ? 'running' : 'stale'
}

export function serializeManagedRow(
  row: {
    id: string
    environmentId: string | null
    name: string | null
    engine: string | null
    status: string | null
    metadata: unknown
    options: unknown
    createdAt: string
    updatedAt: string
  },
  serverId: string | null,
  listener?: Readonly<{ host: string | null; port: number | null }>
) {
  const residual = parseManagedResidual(row.metadata)
  const engine =
    row.engine && isManagedEngineCode(row.engine) ? (row.engine as ManagedEngineCode) : null
  const status = parseManagedStatus(row.status) ?? 'provisioning'

  const metadata: Record<string, unknown> = {
    ...(residual.rootLoginId ? { rootLoginId: residual.rootLoginId } : {}),
    ...(residual.rootUsername ? { rootUsername: residual.rootUsername } : {}),
    ...(residual.error ? { error: residual.error } : {}),
  }

  const host = listener ? listener.host : (residual.host ?? null)
  const port = listener ? listener.port : (residual.port ?? null)

  return {
    id: row.id,
    environmentId: row.environmentId,
    name: row.name,
    engine,
    status,
    host,
    port,
    serverId,
    metadata,
    options: row.options,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function buildConnectionPayload(
  spec: ManagedEngineSpec,
  params: {
    host: string
    port: number
    database: string
    username: string
    /** Effective mode (service override → org default → platform). */
    sslMode: ManagedSslMode
  }
): ManagedConnectionInfo {
  return spec.buildConnectionInfo({
    host: params.host,
    port: params.port,
    database: params.database,
    username: params.username,
    sslMode: params.sslMode,
  })
}
