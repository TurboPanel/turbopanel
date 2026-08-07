import type { Context } from 'hono'
import {
  isValidIpAddress,
  parseIpVersion,
} from '../../lib/ip-address.ts'

export type IpScopeFks = {
  datacenterId?: string | null
  networkId?: string | null
  serverId?: string | null
  vpnId?: string | null
}

function isPostgresUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null &&
    'code' in err && (err as { code: string }).code === '23505'
}

export function isIpAddressUniqueViolation(err: unknown): boolean {
  if (!isPostgresUniqueViolation(err)) return false
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('uniq_ip_org_address') ||
    message.includes('uniq_ip_vpn_address')
}

export function parseCreateIpAddress(
  c: Context,
  body: Record<string, unknown>,
): { address: string } | Response {
  const addressRaw = body.address
  if (typeof addressRaw !== 'string' || !isValidIpAddress(addressRaw)) {
    return c.json({ error: 'Invalid request' }, 400)
  }
  const address = addressRaw.trim()
  if (parseIpVersion(address) === null) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  if (body.version !== undefined) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  return { address }
}

export function assertIpScopeFkRules(
  c: Context,
  scope: string,
  scopeFks: IpScopeFks,
): Response | null {
  const hasVpn = scopeFks.vpnId !== undefined && scopeFks.vpnId !== null
  const hasServer = scopeFks.serverId !== undefined && scopeFks.serverId !== null
  const hasNetwork = scopeFks.networkId !== undefined && scopeFks.networkId !== null
  const hasDatacenter =
    scopeFks.datacenterId !== undefined && scopeFks.datacenterId !== null

  if (scope === 'vpn') {
    if (!hasVpn) {
      return c.json({ error: 'Invalid request' }, 400)
    }
  } else if (hasVpn) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  if (hasDatacenter && (hasNetwork || hasServer || hasVpn)) {
    return c.json({ error: 'Invalid request' }, 400)
  }

  return null
}
