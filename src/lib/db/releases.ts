/**
 * Git-backed **release** reads for one environment.
 *
 * A release is not a deploy. `deployment` is upsert-per-`(environment, server)`
 * current state, and even the append-only `command` history is grouped by
 * `context.generation` — one row per host in a deploy fan-out. A release exists
 * *per service*: one deploy may publish a release for `web` and none for
 * `worker`, and a later rollback re-promotes a release without producing a new
 * one at all. So the read model here is keyed by `context.releases[].releaseId`
 * rather than by generation, over the same append-only `command` scan
 * `deployment-history.ts` uses — no new table, and no parse of the
 * secret-bearing `dispatch` payload (which is deleted at terminal state anyway).
 *
 * **Two lanes, one read model.** A native release is identified by its commit
 * and a promoted directory; a Railpack release is identified by the OCI image
 * tag it produced, and rolling one back means redeploying that tag. The commit
 * half comes from `context.releases[]` (written at enqueue time); the image half
 * can only come from the daemon's own deploy result in `command.result_summary`,
 * because at enqueue time no image exists yet. Both are folded onto the same
 * record here so callers never have to ask which lane a release belongs to —
 * they read {@link ServiceReleaseRecord.imageTag} and find out.
 *
 * **One release, not one release per host.** A deploy of an environment spread
 * over several servers writes one `command` row per server, each carrying the
 * same `context.releases[]` entry — because the release id is allocated once for
 * the whole fan-out (`createReleaseIdAllocator`). This module folds those rows
 * back into a single environment-scoped record whose status is the *aggregate*
 * over every participating host, which is the only status a rollback can act on:
 * promoting a release means promoting it everywhere, so a release that failed on
 * one of three servers is not a release the operator may be offered.
 *
 * Environment scoping goes through `context->>'environmentId'`, backed by the
 * same partial expression index `idx_command_deploy_environment_created`.
 */

import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import { type CommandContextRelease, normalizeContextReleases } from '../commands/context.ts'
import { command } from './schema.ts'

/** The only command type that publishes or promotes a release. */
const DEPLOY_COMMAND_NAME = 'environment.deploy'

/** Hard cap on how far back a releases read walks. */
export const SERVICE_RELEASES_MAX_LIMIT = 100

/** Default page size for `GET /environments/:id/releases`. */
export const SERVICE_RELEASES_DEFAULT_LIMIT = 25

/** One host's attempt at a release — the fan-out row behind the folded record. */
export type ServiceReleaseAttempt = {
  /** `command.id` of the deploy that published (or re-promoted) it on this host. */
  commandId: string
  serverId: string
  status: string
}

/**
 * One release of one compose service, as the control plane can see it.
 *
 * **Environment-scoped, not host-scoped.** `attempts[]` names every server the
 * deploy fanned this release out to, and `status` is the aggregate over them:
 * `failed` the moment any host failed it, `succeeded` only when every host
 * finished it, and otherwise the in-flight status. A release row for a `failed`
 * command is a release that was *attempted*, and the rollback route refuses to
 * target one — the tree may never have been sealed on the hosts.
 *
 * `commandId` / `serverId` stay on the record as the representative attempt (the
 * newest one) so a single build transcript can be opened for the release;
 * anything reasoning about *coverage* must use `attempts[]` instead.
 */
export type ServiceReleaseRecord = {
  /** Representative attempt's command — the transcript the UI opens. */
  commandId: string
  /** Representative attempt's server. See {@link ServiceReleaseRecord.attempts}. */
  serverId: string
  /** Every host this release was dispatched to, newest attempt first. */
  attempts: ServiceReleaseAttempt[]
  composeServiceName: string
  releaseId: string
  sourceId: string
  commitSha: string
  /** Commit subject / author, when the source provider resolved them. */
  commitMessage?: string
  commitAuthor?: string
  /**
   * Railpack lane only: the OCI image this release resolved to, and the pinned
   * build inputs that produced it.
   *
   * A Railpack release has **no promoted directory** — its identity is the image
   * tag, and rolling one back is "redeploy this tag", not "re-point `current`".
   * So a release list that only ever showed a commit could not tell an operator
   * which image a historical release actually ran. Absent on every native
   * (directory) release, which is how the two lanes are told apart.
   */
  imageTag?: string
  railpackFrontendVersion?: string
  railpackPlanVersion?: string
  /** Aggregate status across every host in {@link ServiceReleaseRecord.attempts}. */
  status: string
  queuedAt: string | null
  finishedAt: string | null
  /**
   * True for the release this service is currently believed to be running.
   *
   * **Resolution rule:** the most recent *succeeded* release per
   * `composeServiceName`. The daemon does not report its on-host `current` back
   * over the wire today, so this is derived from history rather than observed.
   * It is correct for every path that goes through this control plane —
   * including a rollback, which enqueues a fresh `environment.deploy` and
   * therefore becomes the newest succeeded row itself. A future readback of the
   * host's `current` symlink (or of `deployment.json`'s `releases[]`) could
   * tighten it; nothing here assumes that readback exists.
   */
  isLive: boolean
  /**
   * Set when this row is a rollback: the already-published release it promoted.
   * Its `releaseId` equals this value, so a rollback does not invent a new
   * release — it re-lives an existing one.
   */
  rollbackToReleaseId?: string
}

export type ListServiceReleasesParams = {
  /** Restrict to one compose service; omit to list every sourced service. */
  composeServiceName?: string
  /** Command rows to scan (not release rows). Clamped to the max. */
  limit?: number
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? SERVICE_RELEASES_DEFAULT_LIMIT, 1), SERVICE_RELEASES_MAX_LIMIT)
}

/** `context->>'environmentId' = :id` — matches the partial expression index. */
function environmentContextFilter(environmentId: string) {
  return sql`${command.context} ->> 'environmentId' = ${environmentId}`
}

function contextBag(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/**
 * Railpack image identity for one release, as the daemon reported it.
 *
 * It cannot come from `context.releases[]`: that array is written when the
 * command is *enqueued*, and none of these values exist yet — the image is not
 * built and the frontend/plan versions are whatever the host had vendored at
 * build time. The daemon returns them on the deploy result instead, which
 * lands verbatim in `command.result_summary` and survives the deletion of the
 * secret-bearing `dispatch` payload. Merging the two here keeps a single
 * release read model spanning both lanes.
 */
export type RailpackReleaseIdentity = {
  imageTag?: string
  railpackFrontendVersion?: string
  railpackPlanVersion?: string
}

/** Non-empty string, else `undefined`. */
function resultField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * `(composeServiceName, releaseId)` → Railpack identity, off one deploy result.
 *
 * Unlike {@link normalizeContextReleases} a malformed entry is skipped rather
 * than dropping the whole map: this is display metadata layered onto a release
 * row that already exists, so a bad entry costs a caption, never a rollback
 * target. Entries carrying no Railpack fields at all — every native release —
 * are simply absent.
 */
export function railpackIdentitiesFromResult(
  result: unknown
): Map<string, RailpackReleaseIdentity> {
  const identities = new Map<string, RailpackReleaseIdentity>()
  const releases = contextBag(result).releases
  if (!Array.isArray(releases)) return identities
  for (const entry of releases) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const composeServiceName = resultField(record, 'composeServiceName')
    const releaseId = resultField(record, 'releaseId')
    if (!composeServiceName || !releaseId) continue
    const imageTag = resultField(record, 'imageTag')
    const railpackFrontendVersion = resultField(record, 'railpackFrontendVersion')
    const railpackPlanVersion = resultField(record, 'railpackPlanVersion')
    if (!imageTag && !railpackFrontendVersion && !railpackPlanVersion) continue
    identities.set(releaseKey(composeServiceName, releaseId), {
      ...(imageTag === undefined ? {} : { imageTag }),
      ...(railpackFrontendVersion === undefined ? {} : { railpackFrontendVersion }),
      ...(railpackPlanVersion === undefined ? {} : { railpackPlanVersion }),
    })
  }
  return identities
}

/**
 * The fan-out key: one release of one service, however many servers ran it.
 * Keying on the service name as well as the id keeps two services that somehow
 * share an id from merging into one nonsensical row.
 */
function releaseKey(composeServiceName: string, releaseId: string): string {
  return `${composeServiceName} ${releaseId}`
}

/**
 * Fill in whatever this host's result knew that the record does not yet.
 *
 * Rows arrive newest-first and every host of one fan-out reports the same
 * image, but a host whose result was truncated (or a pre-Railpack row) simply
 * has nothing to say — so the first host that *does* answer wins, rather than
 * the first row seen.
 */
function mergeRailpackIdentity(
  release: ServiceReleaseRecord,
  identity: RailpackReleaseIdentity | undefined
): void {
  if (!identity) return
  if (release.imageTag === undefined && identity.imageTag !== undefined) {
    release.imageTag = identity.imageTag
  }
  if (
    release.railpackFrontendVersion === undefined &&
    identity.railpackFrontendVersion !== undefined
  ) {
    release.railpackFrontendVersion = identity.railpackFrontendVersion
  }
  if (release.railpackPlanVersion === undefined && identity.railpackPlanVersion !== undefined) {
    release.railpackPlanVersion = identity.railpackPlanVersion
  }
}

/** Terminal statuses that mean this host did not publish the release. */
const FAILED_COMMAND_STATUSES: ReadonlySet<string> = new Set(['failed', 'timed_out', 'cancelled'])

/** Statuses a host will not move on from. Mirrors `TERMINAL_COMMAND_STATUSES`. */
const TERMINAL_ATTEMPT_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  ...FAILED_COMMAND_STATUSES,
])

/**
 * Fold every host's status for one release into the release's own status.
 *
 * The rule is deliberately pessimistic, because the consumer is a rollback
 * picker: a release only counts as `succeeded` when **every** host that was
 * asked for it finished it, and any host failing it fails the release outright.
 * Anything in between reports an in-flight status, so a fan-out still running
 * reads as running rather than as a half-truth.
 */
export function aggregateReleaseStatus(attempts: readonly ServiceReleaseAttempt[]): string {
  if (attempts.length === 0) return 'queued'
  const failed = attempts.find((attempt) => FAILED_COMMAND_STATUSES.has(attempt.status))
  if (failed) return failed.status
  const pending = attempts.find((attempt) => attempt.status !== 'succeeded')
  return pending ? pending.status : 'succeeded'
}

/** The later of two optional ISO instants; `null` means "not yet". */
function laterTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return a >= b ? a : b
}

/**
 * Releases for one environment, newest first.
 *
 * Authorization is the caller's job — this helper does no visibility filtering.
 * Rows are ordered by the owning command (UUIDv7 ids are time-ordered), and
 * within one command by the payload's own `sourceMaterial[]` order, so a
 * multi-service deploy reads back in a stable order rather than a hash order.
 * Command rows belonging to the same release — the servers of one fan-out — are
 * folded together at the position of the newest of them.
 */
export async function listServiceReleases(
  db: Db,
  environmentId: string,
  params: ListServiceReleasesParams = {}
): Promise<ServiceReleaseRecord[]> {
  const rows = await db
    .select({
      id: command.id,
      serverId: command.serverId,
      status: command.status,
      context: command.context,
      // The daemon's own deploy result. `context.releases[]` is written at
      // enqueue time and cannot know an image that had not been built yet, so
      // the Railpack identity of a release is only readable from here.
      resultSummary: command.resultSummary,
      queuedAt: command.queuedAt,
      finishedAt: command.finishedAt,
    })
    .from(command)
    .where(and(eq(command.name, DEPLOY_COMMAND_NAME), environmentContextFilter(environmentId)))
    .orderBy(desc(command.createdAt), desc(command.id))
    .limit(clampLimit(params.limit))

  const folded = new Map<string, ServiceReleaseRecord>()
  const order: string[] = []
  for (const row of rows) {
    const releases = normalizeContextReleases(contextBag(row.context).releases)
    if (!releases) continue
    const identities = railpackIdentitiesFromResult(row.resultSummary)
    for (const release of releases) {
      if (
        params.composeServiceName !== undefined &&
        release.composeServiceName !== params.composeServiceName
      ) {
        continue
      }
      const key = releaseKey(release.composeServiceName, release.releaseId)
      const identity = identities.get(key)
      const attempt: ServiceReleaseAttempt = {
        commandId: row.id,
        serverId: row.serverId,
        status: row.status,
      }
      const existing = folded.get(key)
      if (existing) {
        foldReleaseAttempt(existing, attempt, identity, row.queuedAt ?? null, row.finishedAt ?? null)
        continue
      }
      order.push(key)
      folded.set(
        key,
        newReleaseRecord(release, attempt, identity, row.queuedAt ?? null, row.finishedAt ?? null)
      )
    }
  }

  return markLiveReleases(order.map((key) => withSettledFinishedAt(folded.get(key) as ServiceReleaseRecord)))
}

/** Fold one more host's attempt into the release record it belongs to. */
function foldReleaseAttempt(
  existing: ServiceReleaseRecord,
  attempt: ServiceReleaseAttempt,
  identity: RailpackReleaseIdentity | undefined,
  queuedAt: string | null,
  finishedAt: string | null
): void {
  mergeRailpackIdentity(existing, identity)
  existing.attempts.push(attempt)
  existing.status = aggregateReleaseStatus(existing.attempts)
  // The release finished when its *last* host did — and rows arrive in command
  // order, not finish order, so take the maximum rather than the last one seen.
  // It was queued when its first (oldest) host was, which is the row still
  // being folded in.
  existing.finishedAt = laterTimestamp(existing.finishedAt, finishedAt)
  existing.queuedAt = queuedAt ?? existing.queuedAt
}

/**
 * Seed a release record from the first (newest) attempt seen for it. Rows
 * arrive newest-first, so that attempt becomes the representative transcript.
 */
function newReleaseRecord(
  release: CommandContextRelease,
  attempt: ServiceReleaseAttempt,
  identity: RailpackReleaseIdentity | undefined,
  queuedAt: string | null,
  finishedAt: string | null
): ServiceReleaseRecord {
  return {
    commandId: attempt.commandId,
    serverId: attempt.serverId,
    attempts: [attempt],
    composeServiceName: release.composeServiceName,
    releaseId: release.releaseId,
    sourceId: release.sourceId,
    commitSha: release.commitSha,
    ...(release.commitMessage === undefined ? {} : { commitMessage: release.commitMessage }),
    ...(release.commitAuthor === undefined ? {} : { commitAuthor: release.commitAuthor }),
    // Railpack identity rides in from the deploy result, not the context.
    ...identity,
    status: aggregateReleaseStatus([attempt]),
    queuedAt,
    finishedAt,
    // Filled in by markLiveReleases — liveness is a property of the whole list,
    // not of one row, so it cannot be decided while the list is still building.
    isLive: false,
    ...(release.rollbackToReleaseId === undefined
      ? {}
      : { rollbackToReleaseId: release.rollbackToReleaseId }),
  }
}

/**
 * A release with a host still working on it has not finished, whatever its
 * finished peers recorded — reporting the peer's timestamp would show an
 * in-flight release as already done.
 */
function withSettledFinishedAt(release: ServiceReleaseRecord): ServiceReleaseRecord {
  return release.attempts.every((attempt) => TERMINAL_ATTEMPT_STATUSES.has(attempt.status))
    ? release
    : { ...release, finishedAt: null }
}

/**
 * Mark the newest succeeded release of each service live.
 *
 * Exported for host-free coverage of the rule — see
 * {@link ServiceReleaseRecord.isLive} for why it is history-derived. The input
 * must already be newest-first; the first succeeded row per service wins.
 * `status` here is the folded, environment-wide status, so a release that
 * succeeded on only some of its hosts is never marked live.
 */
export function markLiveReleases(
  releases: readonly ServiceReleaseRecord[]
): ServiceReleaseRecord[] {
  const claimed = new Set<string>()
  return releases.map((release) => {
    if (release.status !== 'succeeded' || claimed.has(release.composeServiceName)) {
      return release
    }
    claimed.add(release.composeServiceName)
    return { ...release, isLive: true }
  })
}

/**
 * Every server this release actually reached, for coverage checks.
 *
 * A rollback applies one release id to *every* server in the deploy target set,
 * so it may only offer a release each of those servers already published. This
 * is the set to compare that against.
 */
export function releaseServerIds(release: ServiceReleaseRecord): Set<string> {
  return new Set(release.attempts.map((attempt) => attempt.serverId))
}

/**
 * Is this release materialized on every server the next deploy will target?
 *
 * `targetServerIds` is the environment's current deploy target set. A release
 * published while the environment ran on fewer servers is *not* a rollback
 * target: the deploy would hand the same release id to a host that never built
 * it, and the daemon's `promoteExistingRelease()` would fail on a directory it
 * has never seen — halfway through the fan-out, with the other hosts already cut
 * over.
 */
export function isReleaseMaterializedEverywhere(
  release: ServiceReleaseRecord,
  targetServerIds: Iterable<string>
): boolean {
  const covered = releaseServerIds(release)
  for (const serverId of targetServerIds) {
    if (!covered.has(serverId)) return false
  }
  return true
}
