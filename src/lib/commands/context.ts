/**
 * `command.context` — the small, non-secret identifier bag kept on the permanent
 * command row so UI reads, projections, and error attribution never need the
 * daemon execution payload (which lives in `dispatch` and is deleted
 * shortly after the command reaches a terminal state).
 *
 * Extraction is an **allowlist**: only the identifier keys below — plus the
 * strictly-shaped `replicaCounts` map and `releases[]` list — are copied. Never
 * widen this list with secret-bearing fields (compose YAML, credential
 * envelopes, TLS material, connection strings).
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
 * deploy ask for" long after the payload row is deleted. `releases[]` is on the
 * row for exactly the same reason — see {@link CommandContextRelease}.
 */
export type CommandContextReplicaCounts = Record<string, number>

/**
 * One Git-backed release an `environment.deploy` command published (or, for a
 * rollback, re-promoted), kept on the permanent row for the same reason
 * `replicaCounts` is.
 *
 * `deployment` is upsert-per-target and `dispatch.payload` is deleted at
 * terminal state, so without this there is nowhere left to read "which releases
 * has this service ever had" from — and that list is what a rollback picker is.
 * Every field is a non-secret identifier already visible in the UI; the clone
 * credential and build plan stay in the payload where they belong.
 *
 * **Not here: Railpack image identity.** This row is written when the command is
 * *enqueued*, and a Railpack release's image tag, frontend version, and plan
 * version do not exist until the host has built it. They come back on the deploy
 * *result* (`command.result_summary`) instead, and
 * `lib/db/releases.ts` folds them onto the same release record — putting
 * placeholder keys here would only invite a reader to trust a value that was
 * never filled in.
 */
export type CommandContextRelease = {
  composeServiceName: string
  releaseId: string
  sourceId: string
  commitSha: string
  /**
   * Commit subject and author, for the same reason the SHA is here: the release
   * list is read off this row long after the payload is gone, and "which commit"
   * is not an answer an operator can act on without "which change, by whom".
   *
   * Optional — a provider that cannot resolve them omits them, and a release
   * published before they were recorded reads back without them. Unlike the
   * required fields, a missing one does **not** drop the whole array: it costs
   * a caption, not a rollback target.
   */
  commitMessage?: string
  commitAuthor?: string
  /** Present only for a rollback — the already-published release it promoted. */
  rollbackToReleaseId?: string
}

export type CommandContext = Partial<Record<ContextKey, string | number>> & {
  replicaCounts?: CommandContextReplicaCounts
  releases?: CommandContextRelease[]
}

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

/** Non-empty string, else `undefined` — every release field is required. */
function releaseField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Accept only fully-formed release rows. Like {@link normalizeReplicaCounts},
 * a malformed entry drops the **whole** array rather than persisting a partial
 * read model — a releases list with holes in it would silently offer the
 * operator a rollback target that was never actually built.
 */
export function normalizeContextReleases(value: unknown): CommandContextRelease[] | undefined {
  if (!Array.isArray(value)) return undefined
  const releases: CommandContextRelease[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
    const record = entry as Record<string, unknown>
    const composeServiceName = releaseField(record, 'composeServiceName')
    const releaseId = releaseField(record, 'releaseId')
    const sourceId = releaseField(record, 'sourceId')
    const commitSha = releaseField(record, 'commitSha')
    if (!composeServiceName || !releaseId || !sourceId || !commitSha) return undefined
    const rollbackToReleaseId = releaseField(record, 'rollbackToReleaseId')
    // Display-only, so a malformed value is dropped on its own rather than
    // taking the release row (and with it a rollback target) down with it.
    const commitMessage = releaseField(record, 'commitMessage')
    const commitAuthor = releaseField(record, 'commitAuthor')
    releases.push({
      composeServiceName,
      releaseId,
      sourceId,
      commitSha,
      ...(commitMessage === undefined ? {} : { commitMessage }),
      ...(commitAuthor === undefined ? {} : { commitAuthor }),
      ...(rollbackToReleaseId === undefined ? {} : { rollbackToReleaseId }),
    })
  }
  return releases.length > 0 ? releases : undefined
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
