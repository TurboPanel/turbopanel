/**
 * Organization firewall policy, stored in the existing `organization.options`
 * jsonb under `firewall` (no migration). Defaults are observe-friendly: the
 * default input policy accepts, IPv6 mirrors IPv4, and SSH is open to anyone
 * (the 2026-09-19 decision: safe against a first-enable lockout; an
 * organization narrows it later).
 */

import { parseFirewallAddress } from '../../contracts/commands/schemas.ts'
import { MAX_FIREWALL_RULE_ADDRESSES } from './vocabulary.ts'

export type FirewallOrgPolicy = {
  inputDefault: 'accept' | 'drop'
  ipv6: 'mirror' | 'skip'
  /** `any`, or CIDRs the host's SSH port is open to. */
  sshSources: string[]
}

export const DEFAULT_FIREWALL_ORG_POLICY: FirewallOrgPolicy = {
  inputDefault: 'accept',
  ipv6: 'mirror',
  sshSources: ['any'],
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSshSources(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_FIREWALL_ORG_POLICY.sshSources]
  const parsed: string[] = []
  for (const entry of value) {
    const address = parseFirewallAddress(entry)
    if (address !== null && !parsed.includes(address)) parsed.push(address)
  }
  return parsed.length > 0 ? parsed : [...DEFAULT_FIREWALL_ORG_POLICY.sshSources]
}

/** Read the stored policy; anything missing or malformed falls back to the defaults. */
export function parseFirewallOrgPolicy(options: unknown): FirewallOrgPolicy {
  const stored = isPlainObject(options) && isPlainObject(options.firewall) ? options.firewall : {}
  return {
    inputDefault: stored.inputDefault === 'drop' ? 'drop' : 'accept',
    ipv6: stored.ipv6 === 'skip' ? 'skip' : 'mirror',
    sshSources: readSshSources(stored.sshSources),
  }
}

export type FirewallPolicyPatch = Partial<FirewallOrgPolicy>

export type FirewallPolicyParse =
  { ok: true; patch: FirewallPolicyPatch } | { ok: false; error: string }

function parseSshSourcesInput(value: unknown): string[] | string {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FIREWALL_RULE_ADDRESSES) {
    return `sshSources must list 1 to ${MAX_FIREWALL_RULE_ADDRESSES} entries`
  }
  const parsed: string[] = []
  for (const entry of value) {
    const address = parseFirewallAddress(entry)
    if (address === null) return 'sshSources entries must be "any", an IP address or a CIDR'
    if (!parsed.includes(address)) parsed.push(address)
  }
  if (parsed.includes('any') && parsed.length > 1) {
    return 'sshSources "any" cannot be combined with other entries'
  }
  return parsed
}

/** Validate a PUT body; only the fields present are changed. */
export function parseFirewallPolicyPatch(body: unknown): FirewallPolicyParse {
  if (!isPlainObject(body)) return { ok: false, error: 'Invalid request' }
  const patch: FirewallPolicyPatch = {}
  if (body.inputDefault !== undefined) {
    if (body.inputDefault !== 'accept' && body.inputDefault !== 'drop') {
      return { ok: false, error: 'inputDefault must be accept or drop' }
    }
    patch.inputDefault = body.inputDefault
  }
  if (body.ipv6 !== undefined) {
    if (body.ipv6 !== 'mirror' && body.ipv6 !== 'skip') {
      return { ok: false, error: 'ipv6 must be mirror or skip' }
    }
    patch.ipv6 = body.ipv6
  }
  if (body.sshSources !== undefined) {
    const sources = parseSshSourcesInput(body.sshSources)
    if (typeof sources === 'string') return { ok: false, error: sources }
    patch.sshSources = sources
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'Nothing to change' }
  return { ok: true, patch }
}

/** The options object with `firewall` replaced by the merged policy; other keys untouched. */
export function mergeFirewallPolicyIntoOptions(
  options: unknown,
  patch: FirewallPolicyPatch
): Record<string, unknown> {
  const base = isPlainObject(options) ? options : {}
  const next: FirewallOrgPolicy = { ...parseFirewallOrgPolicy(options), ...patch }
  return { ...base, firewall: next }
}
