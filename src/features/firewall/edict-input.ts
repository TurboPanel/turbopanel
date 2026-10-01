/**
 * Validation of a firewall rule ("edict") typed by an operator. Port and
 * address parsing is the wire contract's own (`server.firewall.reconcile`), so
 * a stored rule can never be one the daemon would refuse.
 */

import { parseFirewallAddress, parseFirewallPortRange } from '../../contracts/commands/schemas.ts'
import {
  FIREWALL_LABEL_RE,
  FIREWALL_RULE_ACTIONS,
  FIREWALL_RULE_PROTOS,
  FIREWALL_RULE_SCOPES,
  FIREWALL_SOURCE_KINDS,
  type FirewallRuleActionValue,
  type FirewallRuleProtoValue,
  type FirewallRuleScopeValue,
  type FirewallSourceKind,
  MAX_FIREWALL_RULE_ADDRESSES,
} from './vocabulary.ts'

/**
 * Postgres `inet` prints a single host without its mask (`192.0.2.9`), but the
 * wire contract and the API speak `/32` and `/128`. Put the mask back.
 */
export function formatStoredAddress(address: string): string {
  if (address.includes('/')) return address
  return address.includes(':') ? `${address}/128` : `${address}/32`
}

export type EdictValues = {
  label: string
  scope: FirewallRuleScopeValue
  action: FirewallRuleActionValue
  proto: FirewallRuleProtoValue
  ports: string | null
  sourceKind: FirewallSourceKind
  sourceAddresses: string[]
  isEnabled: boolean
  serverId: string | null
}

export type EdictParse = { ok: true; values: EdictValues } | { ok: false; error: string }

export type EdictPatchParse =
  { ok: true; values: Partial<EdictValues> } | { ok: false; error: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null
}

function parsePorts(value: unknown): string | null | undefined {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const range = parseFirewallPortRange(value)
  if (!range) return undefined
  return range.from === range.to ? String(range.from) : `${range.from}-${range.to}`
}

function parseAddresses(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FIREWALL_RULE_ADDRESSES) {
    return null
  }
  const out: string[] = []
  for (const entry of value) {
    const address = parseFirewallAddress(entry)
    // "any" is its own source kind, never a list entry.
    if (address === null || address === 'any') return null
    if (!out.includes(address)) out.push(address)
  }
  return out
}

/** The cross-field rules the database also enforces, with plain messages. */
export function edictConsistencyError(values: EdictValues): string | null {
  if (values.ports !== null && values.proto === 'any') {
    return 'ports need a protocol of tcp or udp'
  }
  if (values.action === 'accept' && values.ports === null) {
    return 'an allow rule must name its ports'
  }
  if (values.sourceKind === 'addresses' && values.sourceAddresses.length === 0) {
    return 'sourceAddresses is required for the addresses source'
  }
  if (values.sourceKind !== 'addresses' && values.sourceAddresses.length > 0) {
    return 'sourceAddresses is only for the addresses source'
  }
  return null
}

type FieldReader = (body: Record<string, unknown>, out: Partial<EdictValues>) => string | null

const readLabel: FieldReader = (body, out) => {
  if (body.label === undefined) return null
  if (typeof body.label !== 'string' || !FIREWALL_LABEL_RE.test(body.label)) {
    return 'label must be 1-48 chars of letters, digits, space . _ : / -'
  }
  out.label = body.label
  return null
}

const readEnums: FieldReader = (body, out) => {
  const scope = body.scope === undefined ? undefined : oneOf(body.scope, FIREWALL_RULE_SCOPES)
  if (scope === null) return 'scope must be host or published'
  const action = body.action === undefined ? undefined : oneOf(body.action, FIREWALL_RULE_ACTIONS)
  if (action === null) return 'action must be accept, drop or reject'
  const proto = body.proto === undefined ? undefined : oneOf(body.proto, FIREWALL_RULE_PROTOS)
  if (proto === null) return 'proto must be tcp, udp or any'
  const kind =
    body.sourceKind === undefined ? undefined : oneOf(body.sourceKind, FIREWALL_SOURCE_KINDS)
  if (kind === null) return `sourceKind must be one of ${FIREWALL_SOURCE_KINDS.join(', ')}`
  if (scope) out.scope = scope
  if (action) out.action = action
  if (proto) out.proto = proto
  if (kind) out.sourceKind = kind
  return null
}

const readPorts: FieldReader = (body, out) => {
  if (body.ports === undefined) return null
  const ports = parsePorts(body.ports)
  if (ports === undefined) return 'ports must be one port or an ascending range, 1-65535'
  out.ports = ports
  return null
}

const readAddresses: FieldReader = (body, out) => {
  if (body.sourceAddresses === undefined) return null
  const addresses = parseAddresses(body.sourceAddresses)
  if (addresses === null) {
    return `sourceAddresses must list 1 to ${MAX_FIREWALL_RULE_ADDRESSES} IP addresses or CIDRs`
  }
  out.sourceAddresses = addresses
  return null
}

const readFlags: FieldReader = (body, out) => {
  if (body.isEnabled !== undefined) {
    if (typeof body.isEnabled !== 'boolean') return 'isEnabled must be true or false'
    out.isEnabled = body.isEnabled
  }
  if (body.serverId !== undefined) {
    if (body.serverId !== null && typeof body.serverId !== 'string')
      return 'serverId must be a string or null'
    out.serverId = body.serverId
  }
  return null
}

const READERS: readonly FieldReader[] = [readLabel, readEnums, readPorts, readAddresses, readFlags]

function readFields(body: unknown): { error: string } | { fields: Partial<EdictValues> } {
  if (!isPlainObject(body)) return { error: 'Invalid request' }
  const fields: Partial<EdictValues> = {}
  for (const read of READERS) {
    const error = read(body, fields)
    if (error) return { error }
  }
  return { fields }
}

/** A complete new rule. `sourceAddresses` defaults to none; `isEnabled` to true. */
export function parseEdictCreate(body: unknown): EdictParse {
  const read = readFields(body)
  if ('error' in read) return { ok: false, error: read.error }
  const f = read.fields
  if (!f.label || !f.scope || !f.action || !f.proto || !f.sourceKind) {
    return { ok: false, error: 'label, scope, action, proto and sourceKind are required' }
  }
  const values: EdictValues = {
    label: f.label,
    scope: f.scope,
    action: f.action,
    proto: f.proto,
    ports: f.ports ?? null,
    sourceKind: f.sourceKind,
    sourceAddresses: f.sourceAddresses ?? [],
    isEnabled: f.isEnabled ?? true,
    serverId: f.serverId ?? null,
  }
  const inconsistent = edictConsistencyError(values)
  return inconsistent ? { ok: false, error: inconsistent } : { ok: true, values }
}

/** Only the fields present; the caller merges them over the stored rule and re-checks consistency. */
export function parseEdictPatch(body: unknown): EdictPatchParse {
  const read = readFields(body)
  if ('error' in read) return { ok: false, error: read.error }
  if (Object.keys(read.fields).length === 0) return { ok: false, error: 'Nothing to change' }
  return { ok: true, values: read.fields }
}
