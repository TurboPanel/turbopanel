import { isValidHostname } from './hostname.ts'
import { isValidCidr, isValidIpAddress, parseIpVersion } from '../ip-address.ts'

export const WIREGUARD_INTERFACE_MAX_LENGTH = 15

const WIREGUARD_INTERFACE_RE = /^[a-z0-9_-]{1,15}$/

const WIREGUARD_PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{43}=$/

const SHELL_METACHAR_RE = /[;|&$`()<>\\"'!*?{}]/

export function deriveWireguardInterfaceName(vpnId: string): string {
  const hex = vpnId.replaceAll('-', '').slice(0, 8).toLowerCase()
  return `tpwg${hex}`
}

export function isValidWireguardInterfaceName(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > WIREGUARD_INTERFACE_MAX_LENGTH) return false
  return WIREGUARD_INTERFACE_RE.test(value)
}

export function assertValidWireguardInterfaceName(value: unknown): asserts value is string {
  if (!isValidWireguardInterfaceName(value)) {
    throw new Error('Invalid WireGuard interface name')
  }
}

export function isValidWireguardPublicKey(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (/\s/.test(value)) return false
  if (SHELL_METACHAR_RE.test(value)) return false
  return WIREGUARD_PUBLIC_KEY_RE.test(value)
}

export function isValidWireguardListenPort(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return false
  return value >= 1 && value <= 65_535
}

export function isValidWireguardEndpoint(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > 255) return false
  if (/\s/.test(value)) return false
  if (SHELL_METACHAR_RE.test(value)) return false

  const colon = value.lastIndexOf(':')
  if (colon <= 0 || colon === value.length - 1) return false

  const host = value.slice(0, colon)
  const portPart = value.slice(colon + 1)
  if (!/^\d+$/.test(portPart)) return false
  const port = Number.parseInt(portPart, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return false

  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1)
    return isValidIpAddress(inner) && parseIpVersion(inner) === 6
  }

  if (isValidIpAddress(host)) return true
  return isValidHostname(host)
}

export function isValidWireguardAllowedIp(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return isValidCidr(value.trim())
}
