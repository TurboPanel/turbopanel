import { ENVELOPE_PREFIX_DAEMON } from '../../lib/secrets/data-encryption.ts'

/**
 * `server.tunnel.connectors`: start or stop the connectors of organization
 * tunnels on one server.
 *
 * Each entry names a tunnel by the id the provider gave it (the id the
 * connector service is named for on the server). A run token travels only as a
 * `tpdaemon.` envelope sealed for that server's daemon. Installing a tunnel
 * whose connector already runs changes nothing, so a resend is harmless;
 * removing one that is gone is a no-op too. The instance's own tunnel is never
 * named here. Must stay in sync with the daemon twin in
 * `src/contracts/commands-contracts.ts`.
 */

const MAX_TUNNEL_CONNECTORS = 64
/** A sealed run token is a few hundred characters; this leaves a wide margin. */
const MAX_TOKEN_ENVELOPE_LENGTH = 8192
const TUNNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type TunnelConnectorInstall = {
  /** The provider's tunnel id (lower-case UUID). */
  tunnelId: string
  /** `tpdaemon.` envelope holding the run token. */
  tokenEnvelope: string
}

export type TunnelConnectorsCommandPayload = {
  install: TunnelConnectorInstall[]
  remove: string[]
}

export type TunnelConnectorsCommandResult = {
  /** Ids whose connector was installed by this command. */
  installed: string[]
  /** Ids whose connector already ran, left as it was. */
  unchanged: string[]
  /** Ids whose connector was removed (or was not there). */
  removed: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTunnelId(value: unknown): value is string {
  return typeof value === 'string' && TUNNEL_ID_RE.test(value)
}

function parseInstall(value: unknown): TunnelConnectorInstall {
  if (
    !isRecord(value) ||
    !isTunnelId(value.tunnelId) ||
    typeof value.tokenEnvelope !== 'string' ||
    !value.tokenEnvelope.startsWith(ENVELOPE_PREFIX_DAEMON) ||
    value.tokenEnvelope.length === ENVELOPE_PREFIX_DAEMON.length ||
    value.tokenEnvelope.length > MAX_TOKEN_ENVELOPE_LENGTH
  ) {
    throw new TypeError('Invalid server.tunnel.connectors install entry')
  }
  return { tunnelId: value.tunnelId, tokenEnvelope: value.tokenEnvelope }
}

function parseIdList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_TUNNEL_CONNECTORS || !value.every(isTunnelId)) {
    throw new TypeError(`Invalid server.tunnel.connectors ${label}`)
  }
  return value
}

export function parseTunnelConnectorsPayload(value: unknown): TunnelConnectorsCommandPayload {
  if (!isRecord(value)) throw new TypeError('Invalid server.tunnel.connectors payload')
  if (!Array.isArray(value.install) || value.install.length > MAX_TUNNEL_CONNECTORS) {
    throw new TypeError('Invalid server.tunnel.connectors install')
  }
  const install = value.install.map(parseInstall)
  const remove = parseIdList(value.remove, 'remove')
  const named = [...install.map((entry) => entry.tunnelId), ...remove]
  if (named.length === 0 || new Set(named).size !== named.length) {
    throw new TypeError('Invalid server.tunnel.connectors: name each tunnel once, at least one')
  }
  return { install, remove }
}

export function parseTunnelConnectorsResult(value: unknown): TunnelConnectorsCommandResult {
  if (
    !isRecord(value) ||
    !Array.isArray(value.installed) ||
    !value.installed.every(isTunnelId) ||
    !Array.isArray(value.unchanged) ||
    !value.unchanged.every(isTunnelId) ||
    !Array.isArray(value.removed) ||
    !value.removed.every(isTunnelId)
  ) {
    throw new TypeError('Invalid server.tunnel.connectors result')
  }
  return {
    installed: value.installed as string[],
    unchanged: value.unchanged as string[],
    removed: value.removed as string[],
  }
}
