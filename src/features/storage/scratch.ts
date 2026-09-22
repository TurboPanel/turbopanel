/** Scratch storage copies exist for build/cache only and must not be mounted. */
export function scratchCopyNotMountable(role: string | null | undefined): boolean {
  return role === 'scratch'
}
