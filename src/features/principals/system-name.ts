/**
 * Collision-safe system-name derivation shared by every principal create path
 * (project/SFTP/SSH users, compose aliases, managed-engine logins).
 *
 * The scheme math lives in `lib/principal-name-scheme.ts`; this adds the
 * "probe for a free name" retry that needs a database.
 */

import { firstSequential } from '../../lib/sequential.ts'
import {
  deriveSystemNameCandidate,
  type SystemNameCandidates,
} from '../../lib/principal-name-scheme.ts'

const MAX_PROBES = 3

/**
 * A system name for `input` that `isTaken` reports free. `plain` returns the
 * typed name untouched — the caller owns plain collision handling (refuse, or
 * for compose fall back to a suffix). `partial` and `random` redraw up to
 * three times; 36^11 odds make a fourth miss unreachable, so the last draw is
 * returned unprobed rather than throwing mid-deploy.
 */
export async function deriveFreeSystemName(
  input: SystemNameCandidates,
  isTaken: (candidate: string) => Promise<boolean>
): Promise<string> {
  if (input.scheme === 'plain') return input.typed
  const attempts = Array.from({ length: MAX_PROBES }, (_, index) => index)
  const free = await firstSequential(attempts, async () => {
    const candidate = deriveSystemNameCandidate(input)
    return (await isTaken(candidate)) ? undefined : candidate
  })
  return free ?? deriveSystemNameCandidate(input)
}
