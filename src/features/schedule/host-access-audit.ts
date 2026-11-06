/**
 * The audit rows for the host-level Compose approval (see "Who may deploy
 * host-level content" in `features/compose/AGENTS.md`).
 *
 * The approval itself lives on `environment.metadata.composeHostAccessApproval`
 * and is overwritten by the next approval, so these rows are its history:
 *
 * - `compose.host_access.approve` — a manager's or owner's deploy recorded a
 *   new fingerprint. Written by the planner right after that metadata write.
 * - `compose.host_access.use` — an automated deploy (the Git webhook) ran
 *   host-level content under a recorded approval. Written by the deploy route
 *   once the deploy's rows were persisted.
 *
 * Context holds identifiers, the fingerprint and the paths of what reaches the
 * host, never the values at those paths: a path names a field, a value can be
 * anything the author typed.
 */
import type { AuditEntry } from '../audit/audit-records.ts'

/** Paths kept per row; the full count rides along as `pathCount`. */
export const HOST_ACCESS_AUDIT_MAX_PATHS = 20
/** Longest path kept; a longer one is cut, never dropped. */
export const HOST_ACCESS_AUDIT_MAX_PATH_LENGTH = 200

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
 * approval and the automated trigger (no user) for a use.
 */
export function hostAccessAuditEntry(
  event: HostAccessAuditEvent,
  target: { organizationId: string; environmentId: string; projectId: string },
  actor: { userId: string | null; email: string | null; automatedActorId?: string | null }
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
    },
  }
}
