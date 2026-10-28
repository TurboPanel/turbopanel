/**
 * `server.tunnel.status`: what every tunnel connector on a server is doing and
 * which connector version it runs, plus the version the daemon moves them to.
 * Read-only and takes no input. Must stay in sync with the daemon twin in
 * `src/contracts/commands-contracts.ts`.
 */

export type TunnelStatusConnectorState =
  'not-installed' | 'connected' | 'connecting' | 'stopped' | 'failed'

export type TunnelStatusLastUpdate = {
  outcome: 'updated' | 'rolled-back'
  /** ISO-8601 time of the attempt. */
  at: string
  /** Why a rolled-back attempt stopped (at most 300 characters). */
  reason?: string
}

export type TunnelStatusConnector = {
  /** The provider's tunnel id (a lower-case UUID), or `instance` / `default` for the instance's own tunnel. */
  tunnelId: string
  status: TunnelStatusConnectorState
  /** Connector program version the carrying unit runs. */
  version: string
  /** Which of the tunnel's two units carries it (the other exists only during an update). */
  slot: 'a' | 'b'
  /** How the last connector update ended; absent before any attempt. */
  lastUpdate?: TunnelStatusLastUpdate
}

export type TunnelStatusCommandPayload = Record<string, never>

export type TunnelStatusCommandResult = {
  /** The connector version the daemon moves every tunnel to. */
  pinnedVersion: string
  connectors: TunnelStatusConnector[]
}

const STATUS_VALUES = new Set<string>([
  'not-installed',
  'connected',
  'connecting',
  'stopped',
  'failed',
])
/** The metrics band on a server (20300 to 20899) holds 600 connectors. */
const MAX_CONNECTORS = 600
const MAX_REASON_LENGTH = 300
const VERSION_RE = /^[0-9]+(?:\.[0-9]+){0,4}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A strict ISO-8601 timestamp with a time zone, as `Date.toISOString` writes it. */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isConnectorVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 && VERSION_RE.test(value)
}

/** The id of a tunnel as the daemon names it. */
export function isTunnelStatusId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value === 'instance' || value === 'default' || UUID_RE.test(value))
  )
}

export function parseTunnelStatusPayload(value: unknown): TunnelStatusCommandPayload {
  if (!isRecord(value) || Object.keys(value).length > 0) {
    throw new TypeError('Invalid server.tunnel.status payload')
  }
  return {}
}

function parseLastUpdate(value: unknown): TunnelStatusLastUpdate {
  if (
    !isRecord(value) ||
    (value.outcome !== 'updated' && value.outcome !== 'rolled-back') ||
    typeof value.at !== 'string' ||
    !ISO_TIMESTAMP_RE.test(value.at) ||
    (value.reason !== undefined &&
      (typeof value.reason !== 'string' || value.reason.length > MAX_REASON_LENGTH))
  ) {
    throw new TypeError('Invalid server.tunnel.status lastUpdate')
  }
  return {
    outcome: value.outcome,
    at: value.at,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  }
}

function parseConnector(value: unknown): TunnelStatusConnector {
  if (
    !isRecord(value) ||
    !isTunnelStatusId(value.tunnelId) ||
    typeof value.status !== 'string' ||
    !STATUS_VALUES.has(value.status) ||
    !isConnectorVersion(value.version) ||
    (value.slot !== 'a' && value.slot !== 'b')
  ) {
    throw new TypeError('Invalid server.tunnel.status connector')
  }
  return {
    tunnelId: value.tunnelId,
    status: value.status as TunnelStatusConnectorState,
    version: value.version,
    slot: value.slot,
    ...(value.lastUpdate === undefined ? {} : { lastUpdate: parseLastUpdate(value.lastUpdate) }),
  }
}

export function parseTunnelStatusResult(value: unknown): TunnelStatusCommandResult {
  if (
    !isRecord(value) ||
    !isConnectorVersion(value.pinnedVersion) ||
    !Array.isArray(value.connectors) ||
    value.connectors.length > MAX_CONNECTORS
  ) {
    throw new TypeError('Invalid server.tunnel.status result')
  }
  return { pinnedVersion: value.pinnedVersion, connectors: value.connectors.map(parseConnector) }
}
