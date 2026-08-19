import { isManagedEngineCode, type ManagedEngineSpec } from '../../lib/managed/index.ts'
import type { ManagedSslMode } from '../../lib/managed/ssl.ts'
import {
  type ManagedConnectionInfo,
  type ManagedEngineCode,
  parseManagedStatus,
} from '../../lib/managed/types.ts'

export type ManagedResidualMetadata = {
  rootPrincipalId?: string
  rootUsername?: string
  host?: string
  port?: number
  error?: string
}

export function parseManagedResidual(value: unknown): ManagedResidualMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {}
  }
  const record = value as Record<string, unknown>
  return {
    ...(typeof record.rootPrincipalId === 'string'
      ? { rootPrincipalId: record.rootPrincipalId }
      : {}),
    ...(typeof record.rootUsername === 'string' ? { rootUsername: record.rootUsername } : {}),
    ...(typeof record.host === 'string' ? { host: record.host } : {}),
    ...(typeof record.port === 'number' ? { port: record.port } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  }
}

export function serializeManagedRow(
  row: {
    id: string
    environmentId: string | null
    displayName: string | null
    engine: string | null
    status: string | null
    metadata: unknown
    options: unknown
    createdAt: string
    updatedAt: string
  },
  serverId: string | null,
  listener?: Readonly<{ host: string | null; port: number | null }>,
) {
  const residual = parseManagedResidual(row.metadata)
  const engine = row.engine && isManagedEngineCode(row.engine)
    ? (row.engine as ManagedEngineCode)
    : null
  const status = parseManagedStatus(row.status) ?? 'provisioning'

  const metadata: Record<string, unknown> = {
    ...(residual.rootPrincipalId ? { rootPrincipalId: residual.rootPrincipalId } : {}),
    ...(residual.rootUsername ? { rootUsername: residual.rootUsername } : {}),
    ...(residual.error ? { error: residual.error } : {}),
  }

  const host = listener ? listener.host : (residual.host ?? null)
  const port = listener ? listener.port : (residual.port ?? null)

  return {
    id: row.id,
    environmentId: row.environmentId,
    displayName: row.displayName,
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
  },
): ManagedConnectionInfo {
  return spec.buildConnectionInfo({
    host: params.host,
    port: params.port,
    database: params.database,
    username: params.username,
    sslMode: params.sslMode,
  })
}
