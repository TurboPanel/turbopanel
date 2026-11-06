import type { EnvironmentDeployPrincipalMaterial } from '../../contracts/commands/schemas.ts'
import { mapSequential } from '../../lib/sequential.ts'

/**
 * Replace each Hosting Account's `passwordHash` with `passwordHashEnvelope`, a
 * `tpdaemon` envelope the daemon opens through `/secrets/decrypt` (which answers
 * sealed to its own key), so the hash never rides the command payload in the
 * clear. Entries without a hash pass through untouched.
 */
export function sealPrincipalPasswordHashes(
  material: readonly EnvironmentDeployPrincipalMaterial[],
  seal: (plaintext: string) => Promise<string>
): Promise<EnvironmentDeployPrincipalMaterial[]> {
  return mapSequential(material, async (entry) => {
    if (entry.passwordHash === undefined) return entry
    const { passwordHash, ...rest } = entry
    return { ...rest, passwordHashEnvelope: await seal(passwordHash) }
  })
}
