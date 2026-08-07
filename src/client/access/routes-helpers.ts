export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

export function ownerRemovalConflictMessage(err: unknown): string | null {
  if (!(err instanceof Error)) return null
  if (err.message === 'Cannot remove the last owner of an organization') {
    return err.message
  }
  if (err.message === 'Cannot remove the last owner of a team') {
    return err.message
  }
  return null
}
