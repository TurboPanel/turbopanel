/**
 * The audit rows for the host-level Compose approval (see "Who may deploy
 * host-level content" in `features/compose/AGENTS.md`).
 *
 * The approval itself lives on `environment.metadata.composeHostAccessApproval`
 * and is overwritten by the next approval, so these rows are its history:
 *
 * - `compose.host_access.approve` — a manager's or owner's deploy recorded a
 *   new fingerprint. Written by the planner right after that metadata write.
 * - `compose.host_access.use` — an automated deploy (no person behind it) ran
 *   host-level content under a recorded approval. Written by the deploy route
 *   once the deploy's rows were persisted, with what started it (`trigger`).
 *   A hostings-only run writes none: it rewrites the web server config and
 *   certificates and never brings Compose up, so it uses no approval.
 *
 * Context holds identifiers, the fingerprint and the paths of what reaches the
 * host, never the values at those paths: a path names a field, a value can be
 * anything the author typed.
 */
import type { AuditEntry } from '../audit/audit-records.ts'
import { normalizeBranchName } from '../git/environment-branch-tracking.ts'

/** Paths kept per row; the full count rides along as `pathCount`. */
export const HOST_ACCESS_AUDIT_MAX_PATHS = 20
/** Longest path kept; a longer one is cut, never dropped. */
export const HOST_ACCESS_AUDIT_MAX_PATH_LENGTH = 200

/** Longest branch name kept on a use row. */
export const HOST_ACCESS_AUDIT_MAX_BRANCH_LENGTH = 200
/** Longest commit id kept on a use row (a SHA-256 object name is 64). */
export const HOST_ACCESS_AUDIT_MAX_COMMIT_LENGTH = 64

/**
 * What started an automated deploy that ran under a recorded approval.
 *
 * - `push` — a git push delivered by the repository webhook; the row also names
 *   the repository (`sourceId`), branch and commit.
 * - `system` — the control plane started it for any other reason.
 */
export type HostAccessUseTrigger =
  | { kind: 'push'; sourceId: string | null; branch: string | null; commitSha: string | null }
  | { kind: 'system' }

/**
 * The trigger of an automated deploy, from the source selection its caller
 * supplied. A push is the only automated deploy that names a ref or a commit
 * (the same rule the deployment history uses), so anything else is `system`.
 */
export function hostAccessUseTrigger(selection: {
  ref: string | null
  commitSha: string | null
  sourceId: string | null
}): HostAccessUseTrigger {
  const { ref, commitSha } = selection
  if (ref === null && commitSha === null) return { kind: 'system' }
  return {
    kind: 'push',
    sourceId: selection.sourceId,
    branch: ref === null ? null : (normalizeBranchName(ref) ?? ref),
    commitSha,
  }
}

function triggerContext(trigger: HostAccessUseTrigger): Record<string, string> {
  if (trigger.kind !== 'push') return { trigger: trigger.kind }
  return {
    trigger: trigger.kind,
    ...(trigger.sourceId ? { sourceId: trigger.sourceId } : {}),
    ...(trigger.branch
      ? { branch: trigger.branch.slice(0, HOST_ACCESS_AUDIT_MAX_BRANCH_LENGTH) }
      : {}),
    ...(trigger.commitSha
      ? { commitSha: trigger.commitSha.slice(0, HOST_ACCESS_AUDIT_MAX_COMMIT_LENGTH) }
      : {}),
  }
}

/** What the host-level gate decided that is worth a row. */
export type HostAccessAuditEvent = {
  action: 'compose.host_access.approve' | 'compose.host_access.use'
  fingerprint: string
  /** `hostAccessIssues(...)` of the merged document; only the paths are kept. */
  issues: ReadonlyArray<{ path: string }>
  /** The user id the approval names. */
  approvedBy: string
  approvedAt: string
}

/** Sorted, de-duplicated, bounded paths of what reaches the host. */
export function hostAccessAuditPaths(issues: ReadonlyArray<{ path: string }>): {
  paths: string[]
  pathCount: number
} {
  const unique = [...new Set(issues.map((issue) => issue.path))].sort((a, b) =>
    a < b ? -1 : Number(a > b)
  )
  return {
    paths: unique
      .slice(0, HOST_ACCESS_AUDIT_MAX_PATHS)
      .map((path) => path.slice(0, HOST_ACCESS_AUDIT_MAX_PATH_LENGTH)),
    pathCount: unique.length,
  }
}

/**
 * The audit entry for one host-level decision. `actor` is the person for an
 * approval; a use has no person, so it carries the id the deploy is attributed
 * to (`automatedActorId`) and what started it (`trigger`).
 */
export function hostAccessAuditEntry(
  event: HostAccessAuditEvent,
  target: { organizationId: string; environmentId: string; projectId: string },
  actor: {
    userId: string | null
    email: string | null
    automatedActorId?: string | null
    trigger?: HostAccessUseTrigger
  }
): AuditEntry {
  return {
    organizationId: target.organizationId,
    actorUserId: actor.userId,
    actorEmail: actor.email,
    action: event.action,
    targetType: 'environment',
    targetId: target.environmentId,
    context: {
      environmentId: target.environmentId,
      projectId: target.projectId,
      fingerprint: event.fingerprint,
      ...hostAccessAuditPaths(event.issues),
      approvedBy: event.approvedBy,
      approvedAt: event.approvedAt,
      ...(actor.automatedActorId ? { automatedActorId: actor.automatedActorId } : {}),
      ...(actor.trigger ? triggerContext(actor.trigger) : {}),
    },
  }
}
