/**
 * Derive one server's desired firewall rules from facts about that server.
 *
 * Pure: no database, no clock. The loader (`facts.ts`) gathers the facts, this
 * turns them into the `server.firewall.reconcile` rule list, and `preview.ts`
 * sends it. Everything the host would listen on is a `DerivedExposure` (a
 * hosting site, a ProxySQL listener, a compose `ports:` entry, TurboFabric's
 * WireGuard port, the HA Raft ports); everything an operator typed is an
 * `EdictFact`. Each becomes one wire rule.
 *
 * Rule ids carry the source and the port, never an organization id (one
 * organization owns a daemon host in 0.2.x, and a later delegated-hosting model
 * must be able to add rules from another origin without renaming these), and
 * `origin` stays `derived` / `user` so that extension is additive.
 *
 * A rule whose sources cannot be resolved for this server (no datacenter
 * recorded, no fabric) is NOT sent, with a note saying why: an unresolved
 * narrowing must never silently widen into `any`.
 */

import {
  type FirewallCommandPolicy,
  type FirewallCommandRule,
  type FirewallRuleAction,
  type FirewallRuleProto,
  type FirewallRuleScope,
  parseFirewallAddress,
} from '../../contracts/commands/schemas.ts'
import type { FirewallOrgPolicy } from './policy.ts'
import { type FirewallSourceKind, MAX_FIREWALL_RULE_ADDRESSES } from './vocabulary.ts'

/** Who may connect to a derived port. */
export type ExposureReach = 'public' | 'datacenter' | 'fabric' | 'servers'

export type DerivedExposure = {
  /** Which part of the system listens: `hosting`, `proxysql`, `fabric`, `ha`, `compose`, `control-plane`. */
  source: string
  scope: FirewallRuleScope
  proto: 'tcp' | 'udp'
  /** One port or an inclusive ascending range. */
  ports: string
  reach: ExposureReach
  /** Shown beside the rule on the host; sanitised to the wire alphabet and 48 characters here. */
  comment: string
  /** The single host address a published port is bound to, when it is not every address. */
  destination?: string
}

/** An operator-typed rule that applies to this server (already filtered to enabled ones). */
export type EdictFact = {
  id: string
  scope: FirewallRuleScope
  action: FirewallRuleAction
  proto: FirewallRuleProto
  ports: string | null
  sourceKind: FirewallSourceKind
  sourceAddresses: string[]
  label: string
}

/** Addresses behind the source words, for this server. Each list is CIDRs or bare addresses. */
export type FirewallSourceSets = {
  /** This organization's other servers. */
  servers: string[]
  /** Networks of the datacenter(s) this server is in. */
  datacenter: string[]
  /** The organization's TurboFabric host subnet(s). */
  fabric: string[]
}

export type FirewallDeriveInput = {
  policy: FirewallOrgPolicy
  /** The panel's belief about sshd's port (host defaults: server, datacenter, organization). */
  sshPortHint: number | null
  /** This server is the control plane's own host. */
  coLocated: boolean
  /** The control plane's entrypoint ports; used only when `coLocated`. */
  controlPlaneTcpPorts: number[]
  exposures: DerivedExposure[]
  edicts: EdictFact[]
  sources: FirewallSourceSets
}

export type FirewallDerivation = {
  policy: FirewallCommandPolicy
  rules: FirewallCommandRule[]
  controlPlane?: { tcpPorts: number[] }
  sshPorts?: number[]
  /** Plain-words facts the console shows next to the preview: what was skipped, and why. */
  notes: string[]
}

const COMMENT_UNSAFE = /[^A-Za-z0-9 ._:/-]/g
const ID_UNSAFE = /[^A-Za-z0-9_.:-]/g

export function sanitizeFirewallComment(text: string): string {
  const cleaned = text.replaceAll(COMMENT_UNSAFE, '_').trim().slice(0, 48)
  return cleaned === '' ? 'rule' : cleaned
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].toSorted((a, b) => a.localeCompare(b))
}

const REACH_WORDS: Record<
  Exclude<ExposureReach, 'public'>,
  { words: string; set: keyof FirewallSourceSets }
> = {
  datacenter: { words: 'this datacenter', set: 'datacenter' },
  fabric: { words: 'TurboFabric', set: 'fabric' },
  servers: { words: "the organization's other servers", set: 'servers' },
}

type Resolved = { sources: string[] } | { reason: string }

function resolveWords(reach: Exclude<ExposureReach, 'public'>, sets: FirewallSourceSets): Resolved {
  const { words, set } = REACH_WORDS[reach]
  const sources = uniqueSorted(sets[set])
  if (sources.length === 0) return { reason: `no addresses are known for ${words}` }
  if (sources.length > MAX_FIREWALL_RULE_ADDRESSES) {
    return { reason: `${words} has more than ${MAX_FIREWALL_RULE_ADDRESSES} addresses` }
  }
  return { sources }
}

function resolveReach(reach: ExposureReach, sets: FirewallSourceSets): Resolved {
  return reach === 'public' ? { sources: ['any'] } : resolveWords(reach, sets)
}

function resolveEdictSources(edict: EdictFact, sets: FirewallSourceSets): Resolved {
  if (edict.sourceKind === 'any') return { sources: ['any'] }
  if (edict.sourceKind === 'addresses') {
    const parsed = edict.sourceAddresses
      .map((address) => parseFirewallAddress(address))
      .filter((address): address is string => address !== null)
    return parsed.length === 0
      ? { reason: 'it names no valid addresses' }
      : { sources: uniqueSorted(parsed) }
  }
  return resolveWords(edict.sourceKind, sets)
}

function exposureRule(exposure: DerivedExposure, sources: string[]): FirewallCommandRule {
  const id =
    `d:${exposure.source}:${exposure.proto}:${exposure.ports}:${exposure.reach}`.replaceAll(
      ID_UNSAFE,
      '_'
    )
  return {
    id: id.slice(0, 64),
    scope: exposure.scope,
    action: 'accept',
    proto: exposure.proto,
    ports: exposure.ports,
    sources,
    ...(exposure.destination === undefined ? {} : { destinations: [exposure.destination] }),
    origin: 'derived',
    comment: sanitizeFirewallComment(exposure.comment),
  }
}

function derivedRules(
  exposures: readonly DerivedExposure[],
  sets: FirewallSourceSets,
  notes: string[]
): FirewallCommandRule[] {
  const byId = new Map<string, FirewallCommandRule>()
  for (const exposure of exposures) {
    const resolved = resolveReach(exposure.reach, sets)
    if ('reason' in resolved) {
      notes.push(
        `${exposure.comment} (${exposure.proto} ${exposure.ports}) is not sent: ${resolved.reason}`
      )
      continue
    }
    const rule = exposureRule(exposure, resolved.sources)
    if (!byId.has(rule.id)) byId.set(rule.id, rule)
  }
  return [...byId.values()].toSorted((a, b) => a.id.localeCompare(b.id))
}

function userRules(
  edicts: readonly EdictFact[],
  sets: FirewallSourceSets,
  notes: string[]
): FirewallCommandRule[] {
  const rules: FirewallCommandRule[] = []
  for (const edict of edicts) {
    const resolved = resolveEdictSources(edict, sets)
    if ('reason' in resolved) {
      notes.push(`Your rule "${edict.label}" is not sent: ${resolved.reason}`)
      continue
    }
    rules.push({
      id: `u:${edict.id}`.replaceAll(ID_UNSAFE, '_').slice(0, 64),
      scope: edict.scope,
      action: edict.action,
      proto: edict.proto,
      ...(edict.ports === null ? {} : { ports: edict.ports }),
      sources: resolved.sources,
      origin: 'user',
      comment: sanitizeFirewallComment(edict.label),
    })
  }
  return rules
}

export function deriveFirewall(input: FirewallDeriveInput): FirewallDerivation {
  const notes: string[] = []
  const rules = [
    ...derivedRules(input.exposures, input.sources, notes),
    ...userRules(input.edicts, input.sources, notes),
  ]
  if (input.policy.sshSources.length !== 1 || input.policy.sshSources[0] !== 'any') {
    notes.push(
      'The organization limits SSH to certain addresses, but that is not sent to hosts yet: SSH stays open to anyone until default-drop is enabled.'
    )
  }
  const derivation: FirewallDerivation = {
    policy: { inputDefault: input.policy.inputDefault, ipv6: input.policy.ipv6 },
    rules,
    notes,
  }
  if (input.coLocated && input.controlPlaneTcpPorts.length > 0) {
    derivation.controlPlane = {
      tcpPorts: [...new Set(input.controlPlaneTcpPorts)].toSorted((a, b) => a - b),
    }
  }
  if (input.sshPortHint !== null) derivation.sshPorts = [input.sshPortHint]
  return derivation
}
