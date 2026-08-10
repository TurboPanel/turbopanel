import type { PostgresConfigMeta } from '../db-url.ts'

export type DatabaseStatus = {
  configured: boolean
  connected: boolean
  transport: 'socket' | 'tcp' | null
  user: string | null
  database: string | null
  version: string | null
  error: string | null
}

export function buildUnconfiguredDatabaseStatus(
  meta: PostgresConfigMeta,
  error: string,
): DatabaseStatus {
  return {
    ...meta,
    connected: false,
    version: null,
    error,
  }
}

export function buildDatabaseClientUnavailableStatus(
  meta: PostgresConfigMeta,
): DatabaseStatus {
  return buildUnconfiguredDatabaseStatus(meta, 'database client failed to initialize')
}

export function buildConnectedDatabaseStatus(
  meta: PostgresConfigMeta,
  row: { version?: string; database?: string } | undefined,
): DatabaseStatus {
  return {
    ...meta,
    database: row?.database ?? meta.database,
    connected: true,
    version: row?.version ?? null,
    error: null,
  }
}

export function buildDatabaseQueryErrorStatus(
  meta: PostgresConfigMeta,
  message: string,
): DatabaseStatus {
  return {
    ...meta,
    connected: false,
    version: null,
    error: message,
  }
}

export function buildDatabaseStudioProbeResponse(status: {
  running: boolean
  browserUrl: string
  port: number
}): { running: boolean; browserUrl: string; port: number } {
  return {
    running: status.running,
    browserUrl: status.browserUrl,
    port: status.port,
  }
}
