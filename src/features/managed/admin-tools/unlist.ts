/** Taking a database off the admin tool logins' lists for a drop. Injected steps keep it testable. */

export type Unlisting = { restore: () => Promise<void> }

/**
 * Unlists a database from each login with `unlist`; `restore` puts every list
 * back (used when the drop's apply cannot be queued).
 */
export async function unlistFromLogins(
  loginIds: readonly string[],
  unlist: (loginId: string) => Promise<Unlisting | null>
): Promise<Unlisting> {
  const unlistings = await Promise.all(loginIds.map((id) => unlist(id)))
  return {
    restore: async () => {
      await Promise.all(unlistings.flatMap((entry) => (entry ? [entry.restore()] : [])))
    },
  }
}
