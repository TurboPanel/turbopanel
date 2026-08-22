/**
 * `command.context` — the small, non-secret identifier bag kept on the permanent
 * command row so UI reads, projections, and error attribution never need the
 * daemon execution payload (which lives in `dispatch` and is deleted
 * shortly after the command reaches a terminal state).
 *
 * Extraction is an **allowlist**: only the identifier keys below — plus the
 * strictly-shaped `replicaCounts` map — are copied. Never widen this list with
 * secret-bearing fields (compose YAML, credential envelopes, TLS material,
 * connection strings).
 */

const CONTEXT_KEYS = [
  'managedId',
  'memberId',
  'memberRole',
  'engine',
  'environmentId',
  'generation',
  // sha256 of the compiled runtime compose for that server — non-secret, and
  // kept so deploy-history detail still renders after the `dispatch` payload
  // is deleted.
  'desiredHash',
  'projectId',
  'serverId',
  'fabricId',
  'backupId',
  'action',
] as const

type ContextKey = (typeof CONTEXT_KEYS)[number]

/**
 * Structured (non-scalar) context values. Kept deliberately tiny and strictly
 * shaped — `replicaCounts` is a `service name -> positive integer` map with no
 * user-supplied values beyond compose service keys, so it is safe to keep on
 * the permanent row. It lives here rather than in `dispatch.payload` alone
 * because deploy-history detail must still report "how many replicas did this
 * deploy ask for" long after the payload row is deleted.
 */
export type CommandContextReplicaCounts = Record<string, number>

export type CommandContext =
  & Partial<Record<ContextKey, string | number>>
  & { replicaCounts?: CommandContextReplicaCounts }

/**
 * Accept only `{ [serviceName: string]: positive integer }`. Anything else —
 * nested objects, non-finite numbers, empty keys — is dropped wholesale rather
 * than partially copied, so the durable row never carries half a map.
 */
export function normalizeReplicaCounts(value: unknown): CommandContextReplicaCounts | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  const counts: CommandContextReplicaCounts = {}
  for (const [name, count] of Object.entries(value as Record<string, unknown>)) {
    if (name.length === 0) return undefined
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return undefined
    counts[name] = count
  }
  return Object.keys(counts).length > 0 ? counts : undefined
}

/**
 * Copy the allowlisted identifiers out of a command payload. Returns `undefined`
 * when nothing identifying is present, so call sites can spread it away.
 */
export function commandContextFromPayload(payload: unknown): CommandContext | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return undefined
  }
  const source = payload as Record<string, unknown>
  const context: CommandContext = {}
  for (const key of CONTEXT_KEYS) {
    const value = source[key]
    if (typeof value === 'string' || typeof value === 'number') {
      context[key] = value
    }
  }
  const replicaCounts = normalizeReplicaCounts(source.replicaCounts)
  if (replicaCounts) {
    context.replicaCounts = replicaCounts
  }
  return Object.keys(context).length > 0 ? context : undefined
}
