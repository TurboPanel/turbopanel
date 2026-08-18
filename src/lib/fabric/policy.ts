/**
 * TurboFabric relay-transport policy stored in existing `fabric.options` /
 * `relay.options` jsonb (no migration). A relay may only tighten org policy.
 */

/** Same cap convention as advertised CIDRs on a relay PATCH. */
export const PREFERRED_GATEWAY_IDS_MAX = 32

export type FabricPolicy = {
  allowRelay: boolean
}

export type RelayPolicy = {
  allowRelay: boolean | null
  preferredGatewayIds: string[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Org policy. `allowRelay` defaults **false** (relay transport is opt-in).
 */
export function parseFabricPolicy(options: unknown): FabricPolicy {
  if (!isPlainObject(options)) return { allowRelay: false }
  return { allowRelay: options.allowRelay === true }
}

function parsePreferredGatewayIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== "string") continue
    const id = entry.trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= PREFERRED_GATEWAY_IDS_MAX) break
  }
  return ids
}

/**
 * Relay policy. Missing/invalid `allowRelay` → `null` (inherit org).
 * `preferredGatewayIds` are non-empty strings, deduped, order preserved, capped.
 */
export function parseRelayPolicy(options: unknown): RelayPolicy {
  if (!isPlainObject(options)) {
    return { allowRelay: null, preferredGatewayIds: [] }
  }
  return {
    allowRelay: typeof options.allowRelay === "boolean"
      ? options.allowRelay
      : null,
    preferredGatewayIds: parsePreferredGatewayIds(options.preferredGatewayIds),
  }
}

/**
 * Effective relay transport: org must enable it, then the relay may only
 * tighten (`false`) or inherit (`null`). A relay cannot enable what the org
 * has disabled.
 */
export function resolveEffectiveAllowRelay(
  orgAllowRelay: boolean,
  relayAllowRelay: boolean | null,
): boolean {
  return orgAllowRelay && (relayAllowRelay ?? true)
}

/**
 * Read-modify-write merge so a PATCH never clobbers unrelated `relay.options`
 * keys (mirrors `mergeRelayMetadata`).
 */
export function mergeRelayPolicyOptions(
  existing: unknown,
  patch: Partial<RelayPolicy>,
): Record<string, unknown> {
  const next: Record<string, unknown> = isPlainObject(existing)
    ? { ...existing }
    : {}
  if (patch.allowRelay !== undefined) {
    next.allowRelay = patch.allowRelay
  }
  if (patch.preferredGatewayIds !== undefined) {
    next.preferredGatewayIds = patch.preferredGatewayIds
  }
  return next
}
