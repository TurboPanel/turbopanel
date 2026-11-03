import { setColocatedCredentialsDirForTesting } from '../client/authn/colocated-credentials-dir.ts'

/**
 * Point the co-located daemon credential readers and writers at a fresh temp
 * dir. Every test that reaches `completeInstanceInstall`,
 * `persistColocatedLicenseCredentials`, `clearColocatedDaemonIdentityFiles` or
 * the self-repair writes must use this and call `restore()` in its `finally`,
 * which resets the override and removes the dir. Without it the writers refuse
 * to run (`assertColocatedCredentialsDirWritable`).
 */
export async function useColocatedCredentialsTempDir(): Promise<{
  dir: string
  restore: () => Promise<void>
}> {
  const dir = await Deno.makeTempDir({ dir: '/tmp', prefix: 'tp-colocated-credentials-' })
  setColocatedCredentialsDirForTesting(dir)
  return {
    dir,
    restore: async () => {
      setColocatedCredentialsDirForTesting(null)
      await Deno.remove(dir, { recursive: true }).catch(() => {})
    },
  }
}
