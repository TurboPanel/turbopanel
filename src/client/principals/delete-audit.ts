import type { AuditEntry } from '../../features/audit/audit-records.ts'

/**
 * The audit entry for deleting a Hosting Account (a principal). `username` is
 * the account's short name; `appliedUsername` is the Linux user on the servers.
 * A null actor is the removal sweep, which deletes the row on nobody's behalf.
 */
export function principalDeleteAuditEntry(
  who: { organizationId: string; actorUserId: string | null; actorEmail: string | null },
  principalId: string,
  account: {
    username: string
    appliedUsername: string
    serverIds: readonly string[]
    projectId?: string
  }
): AuditEntry {
  return {
    ...who,
    action: 'principal.delete',
    targetType: 'principal',
    targetId: principalId,
    context: {
      username: account.username,
      appliedUsername: account.appliedUsername,
      serverIds: [...account.serverIds],
      ...(account.projectId ? { projectId: account.projectId } : {}),
    },
  }
}
