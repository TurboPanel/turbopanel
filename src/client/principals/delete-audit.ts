import type { AuditEntry } from '../../features/audit/audit-records.ts'

/**
 * The audit entry for deleting a Hosting Account (a principal). `username` is
 * the account's short name; `appliedUsername` is the Linux user on the servers.
 */
export function principalDeleteAuditEntry(
  who: { organizationId: string; actorUserId: string; actorEmail: string | null },
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
