import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { isValidOwnerName } from '../contracts/directory-names.ts'
import { isReservedPrincipalUsername } from './naming.ts'

// The shared owner rule is the shape; the host's own account names are this
// repo's list. Together they must give the answers in the shared vectors, so
// the two reserved-name lists cannot drift from what the folder rules assume.
it('agrees with the shared owner vectors once the host account names are refused', () => {
  const vectors = JSON.parse(
    Deno.readTextFileSync(new URL('../contracts/layout-vectors.json', import.meta.url))
  ) as { owner: Array<{ value: string; valid: boolean }> }
  assertEquals(vectors.owner.length > 10, true)
  for (const row of vectors.owner) {
    const accepted = isValidOwnerName(row.value) && !isReservedPrincipalUsername(row.value)
    assertEquals(accepted, row.valid, JSON.stringify(row.value))
  }
})
