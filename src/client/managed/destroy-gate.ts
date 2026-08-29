/**
 * The replica-before-primary sequencing gate for `managed.destroy` fan-out.
 *
 * A multi-member destroy has an ordering requirement: each replica's side
 * effects (container rows, ProxySQL ingress teardown, member-row deletion) must
 * land before the primary's `deleteAfterDestroy` removes the `managed` row they
 * are keyed on. That ordering is expressed as command metadata and resolved by
 * the command consumer — never by an HTTP handler blocking on a poll loop —
 * mirroring `pendingStandbyApplies`.
 *
 * The shape lives in its own module because both ends need it: the route side
 * (`./apply-prepare.ts`, which builds it) and the consumer
 * (`src/lib/commands/consumer.ts`, which acts on it). Keeping it here spares the
 * consumer a static import of the Hono-flavoured route helpers.
 */

/** Command metadata key carrying the gate; present on every gated replica command. */
export const MANAGED_DESTROY_GATE_METADATA_KEY = 'managedDestroyGate'

/**
 * One-shot claim key, taken on a single deterministic command of the gate so
 * simultaneous replica completions cannot each enqueue the primaries.
 */
export const MANAGED_DESTROY_GATE_CLAIM_KEY = 'managedDestroyGateClaimedAt'

/** One deferred `managed.destroy`, held in metadata until the gate opens. */
export type PendingManagedDestroy = {
  serverId: string
  memberId: string
  payload: Record<string, unknown>
}

/**
 * `gateId` groups the replica commands of one fan-out and `memberIds` says how
 * many must succeed before `followups` are enqueued.
 *
 * Member ids rather than command ids because they are known before any row
 * exists, so the whole gate is stamped at insert time — a gate written *after*
 * enqueue could be missed by a replica that finished in between.
 */
export type ManagedDestroyGate = {
  gateId: string
  memberIds: string[]
  followups: PendingManagedDestroy[]
}

/**
 * Parse a {@link ManagedDestroyGate} off untrusted command metadata.
 *
 * Metadata is jsonb the consumer re-reads much later, so nothing is trusted: a
 * malformed gate yields `null` and the follow-up is skipped rather than
 * enqueuing a half-formed destroy. The `payload` bag stays opaque here — the
 * consumer runs it through `parseManagedDestroyPayload` before it becomes a
 * command.
 */
export function parseManagedDestroyGate(
  value: unknown,
): ManagedDestroyGate | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  const raw = value as Record<string, unknown>
  const { gateId, memberIds, followups } = raw
  if (typeof gateId !== 'string' || gateId.length === 0) return null
  if (!Array.isArray(memberIds) || memberIds.length === 0) return null
  if (!memberIds.every((id): id is string => typeof id === 'string')) return null
  if (!Array.isArray(followups)) return null

  const parsedFollowups: PendingManagedDestroy[] = []
  for (const entry of followups) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return null
    }
    const followup = entry as Record<string, unknown>
    if (
      typeof followup.serverId !== 'string' ||
      typeof followup.memberId !== 'string' ||
      typeof followup.payload !== 'object' ||
      followup.payload === null ||
      Array.isArray(followup.payload)
    ) {
      return null
    }
    parsedFollowups.push({
      serverId: followup.serverId,
      memberId: followup.memberId,
      payload: followup.payload as Record<string, unknown>,
    })
  }
  return { gateId, memberIds, followups: parsedFollowups }
}
