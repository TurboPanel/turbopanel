import {
  validateHostnameSource,
  type InstanceHostnameRecord,
} from '../../../features/install/instance-hostnames.ts'
import { capabilitiesFor } from './capabilities.ts'
import type { PreflightCheck, PreflightResult } from './provider.ts'

export type HostnameFacts = Pick<InstanceHostnameRecord, 'host' | 'mode' | 'source' | 'publicPort'>

/** One preflight line; `detail` is the plain sentence the screens show. */
export function check(id: string, ok: boolean, detail: string): PreflightCheck {
  return { id, ok, detail }
}

function modeAvailable(hostname: HostnameFacts): PreflightCheck {
  const { implemented } = capabilitiesFor(hostname.mode)
  return check(
    'mode-available',
    implemented,
    implemented
      ? 'This connection mode is available.'
      : 'This connection mode is not available yet.'
  )
}

function sourceAllowed(hostname: HostnameFacts): PreflightCheck {
  const { allowedCertificateSources } = capabilitiesFor(hostname.mode)
  const ok = allowedCertificateSources.includes(hostname.source)
  return check(
    'certificate-source',
    ok,
    ok
      ? 'The certificate source fits this connection mode.'
      : `This connection mode cannot use the ${hostname.source} certificate source.`
  )
}

function sourceIssuable(hostname: HostnameFacts): PreflightCheck {
  const verdict = validateHostnameSource(hostname.host, hostname.source)
  return check(
    'certificate-issuable',
    verdict.ok,
    verdict.ok ? 'The certificate source can issue for this name.' : verdict.error
  )
}

function portMatches(hostname: HostnameFacts): PreflightCheck {
  const expected = capabilitiesFor(hostname.mode).defaultPublicPort
  const ok = hostname.publicPort === expected
  return check(
    'public-port',
    ok,
    ok ? `The name is published on port ${expected}.` : `This mode needs port ${expected}.`
  )
}

/**
 * Checks a hostname against the capability table of its mode. Pure, so the
 * providers and the unit test share one rule set. `portStrict` is for modes
 * the panel itself listens for, where the published port cannot differ.
 */
export function planHostname(hostname: HostnameFacts, portStrict: boolean): PreflightResult {
  const checks = [modeAvailable(hostname), sourceAllowed(hostname), sourceIssuable(hostname)]
  if (portStrict) checks.push(portMatches(hostname))
  return { ok: checks.every((item) => item.ok), checks }
}

/** Modes of the given hostnames, for the heartbeat loader. */
export function hostnameModes(
  hostnames: readonly Pick<InstanceHostnameRecord, 'mode'>[]
): string[] {
  return hostnames.map((hostname) => hostname.mode)
}
