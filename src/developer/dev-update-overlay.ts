/**
 * Dev-only daemon update target and overlay rebuild backed by the local daemon
 * checkout. Registered from `deno-dev.ts` when the instance host has a daemon
 * source checkout.
 *
 * - `setUpdateManifestProvider`: the daemon target is the BUILT overlay
 *   identity (`dist/manifest.json`, commit `<sha>+<unix>`), or null when
 *   nothing was built yet, whatever channel the instance is set to. A checkout
 *   that changed since the last build does not invent a target: development
 *   never updates on its own, so the status only names what was built.
 * - `ensureDevOverlayCurrent`: rebuilds the overlay (`deno task release:dev`)
 *   when the checkout changed since the last build, or on request. The manual
 *   Build and Push Daemon action (`development-updates-routes.ts`) calls it
 *   and then sends the `update` command to the connected remote servers,
 *   which install from this checkout's `dist/` via their `TURBOPANEL_DL_BASE`
 *   (served by the dev Caddyfile).
 *
 * Deno-only: shells out to `git` and the `deno` binary and reads the daemon
 * working tree — never imported by `deno.ts` or the Workers build.
 */
import { basename, dirname, join } from '@std/path'
import { encodeHex } from '@std/encoding/hex'
import { getDaemonRepoPath } from '../daemon/version.ts'
import {
  setUpdateManifestProvider,
  type UpdateManifestTarget,
} from '../features/update/manifest.ts'
import { logError, logInfo } from '../lib/logger.ts'

const LOG_COMPONENT = 'dev-update-overlay'

/** Fingerprints are cheap (a few git forks) but polled; cache briefly. */
const DEV_TARGET_CACHE_MS = 5_000

/** Overlay rebuild ceiling: three `deno compile` targets + packaging. */
const REBUILD_TIMEOUT_MS = 600_000

export type CommandOutput = {
  success: boolean
  stdout: Uint8Array
  stderr: Uint8Array
}

export type RebuildOutput = {
  success: boolean
  code: number
  output: string
  /** Standard error alone, when the runner keeps it apart from `output`. */
  stderr?: string
}

/** Most lines of build output a failure carries back to the caller. */
export const REBUILD_TAIL_LINES = 15

/** The overlay build failed; `tail` is the last lines of its error output. */
export class DevOverlayRebuildError extends Error {
  readonly code: number
  readonly tail: string
  constructor(code: number, tail: string) {
    super(`daemon overlay rebuild failed (deno task release:dev exited ${code})`)
    this.name = 'DevOverlayRebuildError'
    this.code = code
    this.tail = tail
  }
}

/** The last {@link REBUILD_TAIL_LINES} lines of `text`, trimmed. */
export function rebuildOutputTail(text: string): string {
  return text.trim().split('\n').slice(-REBUILD_TAIL_LINES).join('\n')
}

export type DevOverlayHooks = {
  repoPath?: () => string
  runGit?: (repo: string, args: string[]) => Promise<CommandOutput>
  readManifestText?: (repo: string) => Promise<string>
  runRebuild?: (repo: string) => Promise<RebuildOutput>
}

function defaultRunGit(repo: string, args: string[]): Promise<CommandOutput> {
  return new Deno.Command('git', {
    args: ['-C', repo, ...args],
    stdout: 'piped',
    stderr: 'piped',
  }).output()
}

function defaultReadManifestText(repo: string): Promise<string> {
  return Deno.readTextFile(join(repo, 'dist', 'manifest.json'))
}

export type DenoBinaryDeps = {
  /** Path of the running executable; `Deno.execPath()` by default. */
  execPath?: () => string
  /** Whether this process may run `command`; asks the permission set by default. */
  mayRun?: (command: string) => boolean
}

function defaultMayRun(command: string): boolean {
  return Deno.permissions.querySync({ name: 'run', command }).state === 'granted'
}

/**
 * The `deno` to spawn for the overlay rebuild: the first spelling of this
 * runtime that the process is allowed to run.
 *
 * `--allow-run` is matched against the path as spawned, and symlinks are not
 * followed. The unit starts `<vendor>/deno/current/deno` and allows that same
 * path, while `Deno.execPath()` reports the versioned file the link points at
 * (`<vendor>/deno/<version>/deno`), which the allow-list does not name. So the
 * choice is made by asking the permission set, never by assuming one spelling:
 * the executable path, the `current` and `bin` links next to its version
 * folder, then `deno` on PATH. With none allowed the executable path is
 * returned, so the rebuild fails with a message that names it.
 *
 * A compiled control plane binary must not re-exec itself as "deno": it only
 * ever tries `deno` on PATH.
 */
export function resolveDenoBinary(deps?: DenoBinaryDeps): string {
  const execPath = deps?.execPath ? deps.execPath() : Deno.execPath()
  if (basename(execPath) !== 'deno') return 'deno'
  const mayRun = deps?.mayRun ?? defaultMayRun
  const runtimeRoot = dirname(dirname(execPath))
  const candidates = [
    execPath,
    join(runtimeRoot, 'current', 'deno'),
    join(runtimeRoot, 'bin', 'deno'),
    'deno',
  ]
  return candidates.find((candidate) => mayRun(candidate)) ?? execPath
}

async function defaultRunRebuild(repo: string): Promise<RebuildOutput> {
  const result = await new Deno.Command(resolveDenoBinary(), {
    args: ['task', 'release:dev'],
    cwd: repo,
    stdout: 'piped',
    stderr: 'piped',
    signal: AbortSignal.timeout(REBUILD_TIMEOUT_MS),
  }).output()
  const decoder = new TextDecoder()
  const stderr = decoder.decode(result.stderr)
  return {
    success: result.success,
    code: result.code,
    output: `${decoder.decode(result.stdout)}${stderr}`,
    stderr,
  }
}

async function gitOutput(
  runGit: NonNullable<DevOverlayHooks['runGit']>,
  repo: string,
  args: string[]
): Promise<string> {
  const result = await runGit(repo, args)
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim()
    throw new Error(`git ${args[0]} failed: ${stderr}`)
  }
  return new TextDecoder().decode(result.stdout)
}

/**
 * Content fingerprint of the daemon checkout. Must match the daemon repo's
 * `scripts/source-fingerprint.ts`, which stamps the same value into
 * `dist/manifest.json` (`source`) at overlay build time — keep in sync.
 *
 * Clean tree → the full lowercase HEAD sha. Dirty tree →
 * `<head>+dirty.<12 hex>` over `git diff HEAD` plus untracked-file blob hashes.
 */
export async function computeDaemonSourceFingerprint(
  repo: string,
  runGit: NonNullable<DevOverlayHooks['runGit']> = defaultRunGit
): Promise<string> {
  const head = (await gitOutput(runGit, repo, ['rev-parse', 'HEAD'])).trim().toLowerCase()
  const diff = await gitOutput(runGit, repo, ['diff', 'HEAD'])
  const untrackedRaw = (
    await gitOutput(runGit, repo, ['ls-files', '--others', '--exclude-standard'])
  ).trim()
  const untracked = untrackedRaw ? untrackedRaw.split('\n') : []

  let untrackedSection = ''
  if (untracked.length > 0) {
    const hashes = (await gitOutput(runGit, repo, ['hash-object', '--', ...untracked]))
      .trim()
      .split('\n')
    untrackedSection = untracked.map((path, i) => `${path}:${hashes[i] ?? ''}`).join('\n')
  }

  if (diff.trim() === '' && untrackedSection === '') {
    return head
  }

  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${diff}\0${untrackedSection}`)
  )
  const dirtyHash = encodeHex(new Uint8Array(digest)).slice(0, 12)
  return `${head}+dirty.${dirtyHash}`
}

export type DevOverlayIdentity = {
  commit: string
  buildId: string
  builtAt: string
  source?: string
}

/** Read the overlay catalog identity; null when absent or malformed. */
export async function readDevOverlayIdentity(
  repo: string,
  readManifestText: NonNullable<DevOverlayHooks['readManifestText']> = defaultReadManifestText
): Promise<DevOverlayIdentity | null> {
  let raw: unknown
  try {
    raw = JSON.parse(await readManifestText(repo))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { commit, buildId, builtAt, source } = raw as Record<string, unknown>
  if (
    typeof commit !== 'string' ||
    !commit ||
    typeof buildId !== 'string' ||
    !buildId ||
    typeof builtAt !== 'string' ||
    !builtAt
  ) {
    return null
  }
  return {
    commit,
    buildId,
    builtAt,
    ...(typeof source === 'string' && source ? { source } : {}),
  }
}

let cachedTarget: { value: UpdateManifestTarget | null; expiresAt: number } | null = null
let inflightTarget: Promise<UpdateManifestTarget | null> | null = null

export function resetDevOverlayCacheForTests(): void {
  cachedTarget = null
  inflightTarget = null
}

async function resolveDevTrunkManifestUncached(
  hooks: DevOverlayHooks
): Promise<UpdateManifestTarget | null> {
  const repo = (hooks.repoPath ?? getDaemonRepoPath)()
  const identity = await readDevOverlayIdentity(
    repo,
    hooks.readManifestText ?? defaultReadManifestText
  )
  // The built overlay is the only target. A checkout changed since that build
  // is reported by the development status route, never as a target:
  // development installs update only by the manual Build and Push Daemon.
  if (!identity) return null
  return {
    commit: identity.commit,
    buildId: identity.buildId,
    builtAt: identity.builtAt,
    channel: 'trunk',
    manifestUrl: join(repo, 'dist', 'manifest.json'),
  }
}

export type DevOverlayState = {
  /** The last overlay build, or null when none was built. */
  built: DevOverlayIdentity | null
  /** The checkout's content fingerprint right now. */
  sourceFingerprint: string
  /** True when the checkout differs from what was built (or nothing was). */
  sourceChanged: boolean
}

/** What was built and whether the daemon checkout changed since. */
export async function readDevOverlayState(hooks: DevOverlayHooks = {}): Promise<DevOverlayState> {
  const repo = (hooks.repoPath ?? getDaemonRepoPath)()
  const [sourceFingerprint, built] = await Promise.all([
    computeDaemonSourceFingerprint(repo, hooks.runGit ?? defaultRunGit),
    readDevOverlayIdentity(repo, hooks.readManifestText ?? defaultReadManifestText),
  ])
  return {
    built,
    sourceFingerprint,
    sourceChanged: built?.source !== sourceFingerprint,
  }
}

/** Trunk target from the local daemon checkout; briefly cached + coalesced. */
export function resolveDevTrunkManifest(
  hooks: DevOverlayHooks = {}
): Promise<UpdateManifestTarget | null> {
  const now = Date.now()
  if (cachedTarget && now < cachedTarget.expiresAt) {
    return Promise.resolve(cachedTarget.value)
  }
  if (inflightTarget) return inflightTarget

  inflightTarget = resolveDevTrunkManifestUncached(hooks)
    .then((value) => {
      cachedTarget = { value, expiresAt: Date.now() + DEV_TARGET_CACHE_MS }
      return value
    })
    .finally(() => {
      inflightTarget = null
    })
  return inflightTarget
}

let inflightRebuild: Promise<void> | null = null

/**
 * Rebuild the dev overlay when the checkout changed since the last build, or
 * always with `force`. Single-flight: concurrent callers share one build.
 * Rejects with {@link DevOverlayRebuildError} when the build fails.
 */
export function ensureDevOverlayCurrent(
  hooks: DevOverlayHooks = {},
  options: { force?: boolean } = {}
): Promise<void> {
  if (inflightRebuild) return inflightRebuild

  inflightRebuild = (async () => {
    const repo = (hooks.repoPath ?? getDaemonRepoPath)()
    const state = await readDevOverlayState(hooks)
    if (!state.sourceChanged && options.force !== true) return

    logInfo(LOG_COMPONENT, `rebuilding daemon overlay for source ${state.sourceFingerprint}`)
    const result = await (hooks.runRebuild ?? defaultRunRebuild)(repo)
    // The next status read must see the fresh catalog.
    cachedTarget = null
    if (!result.success) {
      const tail = rebuildOutputTail(result.stderr ?? result.output)
      logError(LOG_COMPONENT, `daemon overlay rebuild exited ${result.code}:\n${tail}`)
      throw new DevOverlayRebuildError(result.code, tail)
    }
    logInfo(LOG_COMPONENT, 'daemon overlay rebuilt')
  })().finally(() => {
    inflightRebuild = null
  })
  return inflightRebuild
}

/**
 * Install the dev overlay seams when this host has a daemon source checkout.
 * Without one (managed install) the trunk target stays on the public CDN.
 */
export function registerDevUpdateOverlay(): boolean {
  const repo = getDaemonRepoPath()
  try {
    Deno.statSync(join(repo, 'main.ts'))
  } catch {
    logInfo(LOG_COMPONENT, `no daemon checkout at ${repo}; trunk updates stay on the public CDN`)
    return false
  }
  setUpdateManifestProvider(() => resolveDevTrunkManifest())
  logInfo(LOG_COMPONENT, `trunk updates resolve from the local daemon overlay at ${repo}`)
  return true
}
