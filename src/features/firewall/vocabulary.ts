/**
 * Checked vocabularies for `edict` / `bulwark` (the managed host firewall).
 *
 * The `CHECK` lists in `src/db/schema.ts` are pinned to these arrays by
 * `src/db/enum-checks.test.ts`. Add a member in both places. Rule values that
 * reach a host (`scope`, `action`, `proto`) are the `server.firewall.reconcile`
 * contract's own words, so a stored rule maps onto the wire entry unchanged.
 */

/** Where a rule applies: the host's own listeners, or a port Docker publishes. */
export const FIREWALL_RULE_SCOPES = ['host', 'published'] as const

export type FirewallRuleScopeValue = (typeof FIREWALL_RULE_SCOPES)[number]

/** Allow, block, or block and tell the sender (the console's three words). */
export const FIREWALL_RULE_ACTIONS = ['accept', 'drop', 'reject'] as const

export type FirewallRuleActionValue = (typeof FIREWALL_RULE_ACTIONS)[number]

export const FIREWALL_RULE_PROTOS = ['tcp', 'udp', 'any'] as const

export type FirewallRuleProtoValue = (typeof FIREWALL_RULE_PROTOS)[number]

/**
 * Who a rule is about: anyone, the organization's other servers, this
 * server's datacenter, TurboFabric only, or an explicit address list.
 */
export const FIREWALL_SOURCE_KINDS = [
  'any',
  'servers',
  'datacenter',
  'fabric',
  'addresses',
] as const

export type FirewallSourceKind = (typeof FIREWALL_SOURCE_KINDS)[number]

/** `observe` computes and shows the ruleset but applies nothing (the default). */
export const FIREWALL_MODES = ['observe', 'managed', 'off'] as const

export type FirewallModeValue = (typeof FIREWALL_MODES)[number]

/** Where a server's last ruleset stands: no change pending, awaiting confirmation, kept, or undone. */
export const FIREWALL_STATES = ['idle', 'pending', 'confirmed', 'rolled_back'] as const

export type FirewallStateValue = (typeof FIREWALL_STATES)[number]

/** Bound on the rules one organization may type; derived rules are not counted. */
export const MAX_FIREWALL_RULES_PER_ORG = 200

/** Bound on one rule's explicit address list; matches the wire contract's per-rule limit. */
export const MAX_FIREWALL_RULE_ADDRESSES = 256

/** A rule's label is also its wire `comment`: 1-48 of letters, digits, space and `._:/-`. */
export const FIREWALL_LABEL_RE = /^[A-Za-z0-9 ._:/-]{1,48}$/
