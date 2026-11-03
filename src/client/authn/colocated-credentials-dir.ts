/**
 * Where the control plane reads and writes the co-located daemon's enrollment
 * files (license id, license token and server id, and the daemon key files a
 * fresh install clears), and the guard that keeps test runs out of it.
 *
 * A test that reached these writers once replaced a running daemon's real
 * credentials with ones from a throwaway database and took the daemon offline.
 * So every writer goes through {@link assertColocatedCredentialsDirWritable}:
 * under `deno test` a directory outside `/tmp` (or `/var/tmp`) is refused
 * with an error, whatever the environment says.
 */

/** File names in the credentials dir; the daemon uses the same names. */
export const COLOCATED_LICENSE_ID_FILE = 'license.id'
export const COLOCATED_LICENSE_TOKEN_FILE = 'license.token'
export const COLOCATED_SERVER_ID_FILE = 'server.id'
export const COLOCATED_SERVER_KEY_FILE = 'server-key.json'
export const COLOCATED_SERVER_KEY_ID_FILE = 'server-key-id'

/** Production FHS state dir for persistent daemon identity (dev and managed). */
export const DEFAULT_DAEMON_STATE_DIR = '/var/lib/turbopanel'

let dirOverrideForTesting: string | null = null

function stripTrailingSlash(path: string): string {
  let end = path.length
  while (end > 0 && (path.codePointAt(end - 1) ?? 0) === 47) {
    end--
  }
  return end === 0 ? '/' : path.slice(0, end)
}

/**
 * Point every co-located credential reader and writer at `dir` (a fresh temp
 * dir) for the rest of the test, or back to the normal resolution with `null`.
 */
export function setColocatedCredentialsDirForTesting(dir: string | null): void {
  dirOverrideForTesting = dir === null ? null : stripTrailingSlash(dir)
}

/**
 * Resolve the directory that holds co-located daemon enrollment credentials.
 *
 * Mirrors the daemon's `resolveServerIdentityDir` precedence: honor
 * `TURBOPANEL_DAEMON_STATE_DIR` (injected by `instance-launch`), then
 * `TURBOPANEL_STATE_DIR`, else the FHS default (`/var/lib/turbopanel`). A test
 * override set with {@link setColocatedCredentialsDirForTesting} wins.
 */
export function resolveColocatedLicenseCredentialsDir(): string {
  if (dirOverrideForTesting !== null) return dirOverrideForTesting
  if (typeof Deno !== 'undefined') {
    const daemonStateOverride = Deno.env.get('TURBOPANEL_DAEMON_STATE_DIR')?.trim()
    if (daemonStateOverride) return stripTrailingSlash(daemonStateOverride)

    const stateOverride = Deno.env.get('TURBOPANEL_STATE_DIR')?.trim()
    if (stateOverride) return stripTrailingSlash(stateOverride)
  }
  return DEFAULT_DAEMON_STATE_DIR
}

const TEST_MODULE_PATTERN = /[._]test\.(?:ts|tsx|mts|js|mjs)$/

/**
 * True when this process is a `deno test` run: the main module is a test file.
 * A compiled control plane and `src/deno.ts` never match.
 */
export function isDenoTestRun(mainModule: string | undefined = denoMainModule()): boolean {
  return typeof mainModule === 'string' && TEST_MODULE_PATTERN.test(mainModule)
}

function denoMainModule(): string | undefined {
  if (typeof Deno === 'undefined') return undefined
  try {
    // Structural read: the Workers type shim for `Deno` has no `mainModule`.
    return (Deno as { mainModule?: string }).mainModule
  } catch {
    return undefined
  }
}

/**
 * Temp roots a test may write credentials under. Fixed paths, not `TMPDIR`:
 * the control plane reads no env var its compiled `--allow-env` list lacks,
 * and the fixture creates its dirs under `/tmp` explicitly.
 */
const TEST_TEMP_ROOTS = ['/tmp', '/var/tmp'] as const

/** True when `dir` is strictly inside `root`, with no `.` or `..` segment. */
export function isStrictlyInside(dir: string, root: string): boolean {
  const normalizedRoot = stripTrailingSlash(root)
  const normalizedDir = stripTrailingSlash(dir)
  if (!normalizedDir.startsWith(`${normalizedRoot}/`)) return false
  const rest = normalizedDir.slice(normalizedRoot.length + 1)
  return rest.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/**
 * Throw when a test run is about to write daemon credentials outside `/tmp`
 * or `/var/tmp`. Production runs pass through untouched.
 */
export function assertColocatedCredentialsDirWritable(
  dir: string,
  opts: { testRun?: boolean; tempRoot?: string } = {}
): void {
  const testRun = opts.testRun ?? isDenoTestRun()
  if (!testRun) return
  const roots = opts.tempRoot ? [opts.tempRoot] : TEST_TEMP_ROOTS
  if (roots.some((root) => isStrictlyInside(dir, root))) return
  throw new Error(
    `refusing to write co-located daemon credentials to ${dir} from a test run; ` +
      'call setColocatedCredentialsDirForTesting with a fresh temp dir'
  )
}
