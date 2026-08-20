/**
 * Pure helpers for team list routes (extracted for host-free coverage).
 */

export type TeamListRow = {
  id: string
  name: string | null
  organizationId: string
  createdAt: string
  updatedAt: string
}

export function teamsListPayload(
  canManage: boolean,
  rows: readonly TeamListRow[],
): { teams: TeamListRow[] } {
  if (!canManage) {
    return { teams: [] }
  }
  return { teams: rows.map((row) => ({ ...row })) }
}
