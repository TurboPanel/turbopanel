/**
 * Which Node series a native (`serviceKind: node`) app gets, when its compose
 * service names none.
 *
 * The daemon has to know the series before it checks anything out: it installs
 * that Node and adds the site owner's Linux user to the series' group first.
 * So the answer is worked out here, from the repository at the exact commit
 * this deploy builds, and sent as the payload's `nodeVersion`:
 *
 * 1. `x-turbopanel.nodeVersion` on the service wins (except on a rollback,
 *    below); nothing is read.
 * 2. `package.json` `engines.node` (a range such as `>=26.7.0`, `^22`,
 *    `20 || 22`) → the newest offered series it allows.
 * 3. `.nvmrc`, then `.node-version` (a version such as `26` or `v24.1.0`).
 * 4. Nothing usable → left unset, and the daemon uses its default (24).
 *
 * Files are read from the service's `subdirectory` first and, when it has one,
 * from the repository root after that, so a monorepo that keeps `.nvmrc` at
 * the top still counts. A `.nvmrc` / `.node-version` value that is not a
 * version (`lts/*`, `node`) says nothing and the next file is tried. An
 * `engines.node` that is not a version range npm accepts (`20-24`) is refused,
 * like a range no offered series satisfies: both name the file and the value.
 *
 * A repository that cannot be read fails a deploy (`node_version_unreadable`):
 * building with the default instead would quietly bring back the very bug this
 * fixes, and the error says how to go on (pin `x-turbopanel.nodeVersion`, which
 * skips the read). A preview only warns, and says the deploy reads it again
 * with the clone secret. A disabled app warns and uses the default rather than
 * holding up the whole deploy.
 *
 * **Rollbacks** send the series the release was built with, recorded on the
 * deploy command's release row (`context.releases[].nodeVersion`), and read
 * nothing: a rollback seals no clone secret, so a private repository could not
 * be read anyway. A release recorded before the series was is read as before
 * and falls back to the default with a warning in the deploy response.
 *
 * A deploy pins a source whose commit the provider could not resolve (a plain
 * git remote, a deploy-key repository: `commitSha` is still the branch) to the
 * commit the version files were read at, so the build and the series agree.
 *
 * "Offered" is the runtime registry mirror (`runtimeSeries('node')` in
 * `contracts/runtime-registry.ts`), the same list deploy-prepare grants the
 * runtime group from.
 */
import type { Context } from 'hono'
import { and, eq } from 'drizzle-orm'
import type { AppEnv } from '../../app/app.ts'
import { type Db, getDaemonCellRegistry } from '../../db/connection.ts'
import { repository } from '../../db/schema.ts'
import type { EnvironmentDeploySource } from '../../contracts/commands/schemas.ts'
import { DEFAULT_NATIVE_APP_NODE_SERIES, runtimeSeries } from '../../contracts/runtime-registry.ts'
import type { PreparedNativeAppService } from '../../features/compose/ir.ts'
import type { GitProviderSourceRow, RepositoryFileEntry } from '../../features/git/git-provider.ts'
import { newestAllowedSeries, parseNodeVersionRange } from '../../lib/node-version-range.ts'
import { inspectRepository, type InspectRepositoryParams } from '../repositories/inspect.ts'

/** Where a native app's Node series came from. */
export type NodeVersionOrigin =
  'compose' | 'release' | 'package.json' | '.nvmrc' | '.node-version' | 'default' | 'unresolved'

/** One native app's Node series, for people (the deploy preview). */
export type NativeAppNodeVersionView = {
  composeServiceName: string
  /**
   * The series the app runs: what is sent, or the daemon default when nothing
   * is. Absent when the preview could not read the repository (`unresolved`).
   */
  nodeVersion?: string
  source: NodeVersionOrigin
  /** What the file said (`>=26.7.0`), when the series came from one. */
  requested?: string
  /** Repository path that was read (`apps/web/package.json`). */
  path?: string
  /** Plain-words explanation, when the answer needs one. */
  note?: string
}

export type NodeVersionPrepareError =
  | {
      kind: 'node_version_unsupported'
      composeServiceName: string
      requested: string
      path: string
      supported: string[]
    }
  | { kind: 'node_version_invalid'; composeServiceName: string; requested: string; path: string }
  | { kind: 'node_version_unreadable'; composeServiceName: string; message: string }

export type NodeVersionWarning = {
  code: 'node_version_unresolved'
  message: string
  details: Record<string, unknown>
}

/** What one read of a repository's version files gives back. */
export type NodeVersionFileRead =
  { ok: true; files: RepositoryFileEntry[]; commitSha?: string } | { ok: false; message: string }

/** Read `paths` from the repository a source entry clones, at its commit. */
export type NodeVersionFileReader = (
  source: EnvironmentDeploySource,
  paths: readonly string[]
) => Promise<NodeVersionFileRead>

type FileKind = 'package.json' | '.nvmrc' | '.node-version'

const FILE_KINDS: readonly FileKind[] = ['package.json', '.nvmrc', '.node-version']

/** Longest file value echoed back in a view or an error. */
const MAX_ECHOED_VALUE = 200

/**
 * Longest value parsed at all. Far beyond any real range (a long one is a few
 * hundred characters); it keeps the work bounded however large the file is.
 */
const MAX_PARSED_VALUE = 4096

type FoundRequest = { requested: string; path: string; source: FileKind }

type FileDecision =
  | { series: string; request: FoundRequest }
  | { unsupported: FoundRequest }
  | { invalid: FoundRequest }
  | null

function joinPath(directory: string, name: string): string {
  return directory.length === 0 ? name : `${directory}/${name}`
}

/** Subdirectory files first, then the repository root's. */
export function nodeVersionFilePaths(subdirectory: string | undefined): string[] {
  const directory = (subdirectory ?? '').trim()
  const trimmed = directory.endsWith('/') ? directory.slice(0, -1) : directory
  const directories = trimmed.length === 0 || trimmed === '.' ? [''] : [trimmed, '']
  return directories.flatMap((dir) => FILE_KINDS.map((name) => joinPath(dir, name)))
}

function kindOf(path: string): FileKind | undefined {
  return FILE_KINDS.find((name) => path === name || path.endsWith(`/${name}`))
}

function enginesNode(content: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const engines = (parsed as { engines?: unknown }).engines
  if (typeof engines !== 'object' || engines === null) return undefined
  const node = (engines as { node?: unknown }).node
  return typeof node === 'string' && node.trim().length > 0 ? node.trim() : undefined
}

/** The first line that is not blank or a `#` comment. */
function firstVersionLine(content: string): string | undefined {
  for (const line of content.split('\n')) {
    const hash = line.indexOf('#')
    const value = (hash === -1 ? line : line.slice(0, hash)).trim()
    if (value.length > 0) return value
  }
  return undefined
}

function shortened(value: string): string {
  return value.length > MAX_ECHOED_VALUE ? `${value.slice(0, MAX_ECHOED_VALUE)}…` : value
}

function requestIn(file: RepositoryFileEntry): FoundRequest | undefined {
  if (!file.found) return undefined
  const source = kindOf(file.path)
  if (!source) return undefined
  const requested =
    source === 'package.json' ? enginesNode(file.content) : firstVersionLine(file.content)
  return requested === undefined ? undefined : { requested, path: file.path, source }
}

/** The request as echoed back to people: the value cut to a readable length. */
function forPeople(request: FoundRequest): FoundRequest {
  return { ...request, requested: shortened(request.requested) }
}

/**
 * The series the files ask for, in `paths` order. Pure, so the precedence and
 * every range form are testable without a repository.
 */
export function nodeVersionFromFiles(
  files: readonly RepositoryFileEntry[],
  paths: readonly string[],
  offered: readonly string[] = runtimeSeries('node')
): FileDecision {
  const byPath = new Map(files.map((file) => [file.path, file]))
  for (const path of paths) {
    const file = byPath.get(path)
    const request = file ? requestIn(file) : undefined
    if (!request) continue
    // The full value is parsed; only what is shown to people is shortened.
    const range =
      request.requested.length > MAX_PARSED_VALUE ? null : parseNodeVersionRange(request.requested)
    if (!range) {
      // `engines.node` is meant to be a range, so one npm would not accept is a
      // mistake to point out. A version file may hold an alias (`lts/*`).
      if (request.source === 'package.json') return { invalid: forPeople(request) }
      continue
    }
    const series = newestAllowedSeries(range, offered)
    return series === null
      ? { unsupported: forPeople(request) }
      : { series, request: forPeople(request) }
  }
  return null
}

function defaultView(composeServiceName: string, note?: string): NativeAppNodeVersionView {
  return {
    composeServiceName,
    nodeVersion: DEFAULT_NATIVE_APP_NODE_SERIES,
    source: 'default',
    ...(note === undefined ? {} : { note }),
  }
}

type AppOutcome =
  | {
      app: PreparedNativeAppService
      view: NativeAppNodeVersionView
      warning?: NodeVersionWarning
      /** The commit the version files were read at, when the reader said. */
      readCommitSha?: string
    }
  | { error: NodeVersionPrepareError }

type ResolveContext = {
  read: NodeVersionFileReader
  offered: readonly string[]
  mode: 'deploy' | 'preview'
  /** Node series recorded on each rollback pin, by compose service name. */
  recorded: ReadonlyMap<string, string>
}

function unresolvedWarning(name: string, message: string, commitSha: string): NodeVersionWarning {
  return {
    code: 'node_version_unresolved',
    message,
    details: { composeServiceName: name, commitSha },
  }
}

/** A read that failed, in each of the three situations it can happen in. */
function unreadableOutcome(
  app: PreparedNativeAppService,
  source: EnvironmentDeploySource,
  message: string,
  mode: 'deploy' | 'preview'
): AppOutcome {
  const name = app.composeServiceName
  const pin = `Set x-turbopanel.nodeVersion on the service to skip this read.`
  if (mode === 'preview') {
    const note = `Could not read the repository in this preview (${message}). The deploy reads it again at the commit it builds, with the clone secret; without a version file the app uses Node ${DEFAULT_NATIVE_APP_NODE_SERIES}. ${pin}`
    return {
      app,
      view: { composeServiceName: name, source: 'unresolved', note },
      warning: unresolvedWarning(name, `"${name}": ${note}`, source.commitSha),
    }
  }
  const rollback = source.rollbackToReleaseId !== undefined
  if (!rollback && app.enabled !== false) {
    return { error: { kind: 'node_version_unreadable', composeServiceName: name, message } }
  }
  const why = rollback
    ? 'The release being restored recorded no Node version (it was published before that was recorded)'
    : 'The app is disabled'
  const note = `${why}, and its repository could not be read (${message}), so it uses Node ${DEFAULT_NATIVE_APP_NODE_SERIES}. ${pin}`
  return {
    app,
    view: defaultView(name, note),
    warning: unresolvedWarning(name, `"${name}": ${note}`, source.commitSha),
  }
}

function decisionOutcome(
  app: PreparedNativeAppService,
  decision: Exclude<FileDecision, null>,
  offered: readonly string[]
): AppOutcome {
  const name = app.composeServiceName
  if ('invalid' in decision) {
    const { requested, path } = decision.invalid
    return { error: { kind: 'node_version_invalid', composeServiceName: name, requested, path } }
  }
  if ('unsupported' in decision) {
    const { requested, path } = decision.unsupported
    return {
      error: {
        kind: 'node_version_unsupported',
        composeServiceName: name,
        requested,
        path,
        supported: [...offered],
      },
    }
  }
  const { series, request } = decision
  return {
    app: { ...app, nodeVersion: series },
    view: {
      composeServiceName: name,
      nodeVersion: series,
      source: request.source,
      requested: request.requested,
      path: request.path,
    },
  }
}

/** Answers that need no read: a recorded release, a compose pin, no repository. */
function answerWithoutRead(
  app: PreparedNativeAppService,
  source: EnvironmentDeploySource | undefined,
  recorded: ReadonlyMap<string, string>
): AppOutcome | undefined {
  const name = app.composeServiceName
  const restored = source?.rollbackToReleaseId === undefined ? undefined : recorded.get(name)
  if (restored) {
    return {
      app: { ...app, nodeVersion: restored },
      view: { composeServiceName: name, nodeVersion: restored, source: 'release' },
    }
  }
  const pinned = app.nodeVersion?.trim()
  if (pinned) {
    return { app, view: { composeServiceName: name, nodeVersion: pinned, source: 'compose' } }
  }
  return source ? undefined : { app, view: defaultView(name) }
}

async function resolveOneApp(
  app: PreparedNativeAppService,
  source: EnvironmentDeploySource | undefined,
  ctx: ResolveContext
): Promise<AppOutcome> {
  const known = answerWithoutRead(app, source, ctx.recorded)
  if (known || !source) return known ?? { app, view: defaultView(app.composeServiceName) }

  const paths = nodeVersionFilePaths(source.subdirectory)
  const fetched = await ctx.read(source, paths)
  if (!fetched.ok) return unreadableOutcome(app, source, fetched.message, ctx.mode)

  const readCommitSha = fetched.commitSha
  const decision = nodeVersionFromFiles(fetched.files, paths, ctx.offered)
  const outcome =
    decision === null
      ? { app, view: defaultView(app.composeServiceName) }
      : decisionOutcome(app, decision, ctx.offered)
  if ('error' in outcome || readCommitSha === undefined) return outcome
  return { ...outcome, readCommitSha }
}

/** Node series per compose service recorded on a rollback's release pins. */
function recordedSeries(
  pins: Readonly<Record<string, { nodeVersion?: string }>> | undefined
): Map<string, string> {
  const out = new Map<string, string>()
  for (const [name, pin] of Object.entries(pins ?? {})) {
    const series = pin.nodeVersion?.trim()
    if (series) out.set(name, series)
  }
  return out
}

export type NativeAppNodeVersions = {
  apps: PreparedNativeAppService[]
  views: NativeAppNodeVersionView[]
  /** Compose service name → the commit its version files were read at. */
  readCommitShas: Map<string, string>
}

/**
 * Fill in `nodeVersion` for every native app that does not name one, from its
 * repository at the commit being deployed (or, on a rollback, from what the
 * release recorded).
 *
 * Returns the apps to send (unchanged when nothing was found) and, for the
 * preview, the series each one runs and where it came from.
 */
export async function withNativeAppNodeVersions(
  apps: readonly PreparedNativeAppService[],
  sourceMaterial: readonly EnvironmentDeploySource[],
  ctx: {
    /** `deploy` refuses when a repository cannot be read; `preview` warns. */
    mode: 'deploy' | 'preview'
    read: NodeVersionFileReader
    /** The prepare's warning list; only ever pushed to. */
    warnings: { push(warning: NodeVersionWarning): unknown }
    offered?: readonly string[]
    /** A rollback's pins (`DeployRollbackRequest.releaseByService`). */
    rollbackPins?: Readonly<Record<string, { nodeVersion?: string }>>
  }
): Promise<NativeAppNodeVersions | NodeVersionPrepareError> {
  const resolveContext: ResolveContext = {
    read: ctx.read,
    offered: ctx.offered ?? runtimeSeries('node'),
    mode: ctx.mode,
    recorded: recordedSeries(ctx.rollbackPins),
  }
  const sourceByName = new Map(sourceMaterial.map((entry) => [entry.composeServiceName, entry]))
  const outcomes = await Promise.all(
    apps.map((app) => resolveOneApp(app, sourceByName.get(app.composeServiceName), resolveContext))
  )
  const result: NativeAppNodeVersions = { apps: [], views: [], readCommitShas: new Map() }
  for (const outcome of outcomes) {
    if ('error' in outcome) return outcome.error
    if (outcome.warning) ctx.warnings.push(outcome.warning)
    result.apps.push(outcome.app)
    result.views.push(outcome.view)
    if (outcome.readCommitSha !== undefined) {
      result.readCommitShas.set(outcome.app.composeServiceName, outcome.readCommitSha)
    }
  }
  return result
}

/**
 * The step deploy-prepare runs once source material is resolved: the Node
 * series of every native app, and on a deploy (never a preview, whose commit is
 * only a placeholder) the sources pinned to the commits that were read.
 */
export async function resolveSourceNodeVersions(
  apps: readonly PreparedNativeAppService[],
  sourceMaterial: readonly EnvironmentDeploySource[],
  ctx: Parameters<typeof withNativeAppNodeVersions>[2]
): Promise<
  | { sourceMaterial: EnvironmentDeploySource[]; nodeVersions: NativeAppNodeVersions }
  | NodeVersionPrepareError
> {
  const nodeVersions = await withNativeAppNodeVersions(apps, sourceMaterial, ctx)
  if ('kind' in nodeVersions) return nodeVersions
  const pinned =
    ctx.mode === 'deploy'
      ? pinSourcesToReadCommits(sourceMaterial, nodeVersions.readCommitShas)
      : [...sourceMaterial]
  return { sourceMaterial: pinned, nodeVersions }
}

function isFullCommitSha(value: string): boolean {
  if (value.length !== 40 && value.length !== 64) return false
  for (const ch of value) {
    if (!((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))) return false
  }
  return true
}

/**
 * Pin each source the provider could not resolve to the commit its version
 * files were read at.
 *
 * A plain git remote or a deploy-key repository leaves `commitSha` as the
 * branch name, and the server clones that branch later. Reading the files at
 * the branch and building it separately would let a push land in between and
 * build a commit the series was not read from. Sending the read commit instead
 * makes the server check out exactly that one (it fetches a pinned commit when
 * the branch has moved). Sources that already name a commit are left alone.
 */
export function pinSourcesToReadCommits(
  sourceMaterial: readonly EnvironmentDeploySource[],
  readCommitShas: ReadonlyMap<string, string>
): EnvironmentDeploySource[] {
  return sourceMaterial.map((entry) => {
    const read = readCommitShas.get(entry.composeServiceName)
    if (read === undefined || entry.rollbackToReleaseId !== undefined) return entry
    if (isFullCommitSha(entry.commitSha) || !isFullCommitSha(read)) return entry
    return { ...entry, commitSha: read }
  })
}

/**
 * The series to record on each native app's release row: what was sent, else
 * the default the daemon applied. A rollback sends it back unchanged.
 */
export function recordedNodeVersions(
  apps: readonly { composeServiceName: string; nodeVersion?: string }[] | undefined
): Map<string, string> {
  return new Map(
    (apps ?? []).map((app) => [
      app.composeServiceName,
      app.nodeVersion?.trim() || DEFAULT_NATIVE_APP_NODE_SERIES,
    ])
  )
}

/**
 * The clone secret the deploy already sealed to the target server's daemon, in
 * the shape the inspect path's daemon lane takes. Absent in preview and on a
 * rollback, where nothing is sealed.
 */
export function daemonCredentialOf(
  source: EnvironmentDeploySource
): Pick<InspectRepositoryParams, 'daemonCredential'> {
  if (source.credential === undefined) return {}
  const daemonCredential: NonNullable<InspectRepositoryParams['daemonCredential']> = {
    credential: source.credential,
  }
  if (source.credentialKind !== undefined) daemonCredential.credentialKind = source.credentialKind
  if (source.credentialUsername !== undefined) {
    daemonCredential.credentialUsername = source.credentialUsername
  }
  return { daemonCredential }
}

/**
 * Reads already made in this request, keyed by repository, commit and paths.
 *
 * One request prepares every server of a deploy with the same context, so
 * keying by it reads each repository once per deploy however many servers and
 * apps share it, and nothing outlives the request.
 */
const readsByRequest = new WeakMap<object, Map<string, Promise<NodeVersionFileRead>>>()

function requestReads(c: object): Map<string, Promise<NodeVersionFileRead>> {
  let reads = readsByRequest.get(c)
  if (!reads) {
    reads = new Map()
    readsByRequest.set(c, reads)
  }
  return reads
}

function loadSourceRow(
  db: Db,
  organizationId: string,
  sourceId: string
): Promise<GitProviderSourceRow | undefined> {
  return db
    .select({
      id: repository.id,
      provider: repository.provider,
      repositoryUrl: repository.repositoryUrl,
      defaultBranch: repository.defaultBranch,
      subdirectory: repository.subdirectory,
      connectionId: repository.connectionId,
      secretId: repository.secretId,
    })
    .from(repository)
    .where(and(eq(repository.id, sourceId), eq(repository.organizationId, organizationId)))
    .limit(1)
    .then((found) => found[0])
}

/**
 * The reader deploy-prepare uses: the repository inspect path (the provider's
 * read API first, a connected server when the provider cannot read or turns an
 * anonymous read away for its rate limit), at the source entry's commit.
 *
 * The daemon lane only asks the server this prepare is for, and passes the
 * clone secret already sealed to that server's daemon, so a private repository
 * a provider cannot read is read with the same access the build will use.
 */
export function repositoryNodeVersionReader(
  c: Context<AppEnv>,
  db: Db,
  args: { organizationId: string; serverId: string },
  inspect: typeof inspectRepository = inspectRepository
): NodeVersionFileReader {
  const reads = requestReads(c)
  const readOnce = async (
    source: EnvironmentDeploySource,
    paths: readonly string[]
  ): Promise<NodeVersionFileRead> => {
    const row = await loadSourceRow(db, args.organizationId, source.sourceId)
    if (!row) return { ok: false, message: 'repository not found in this organization' }
    const outcome = await inspect({
      db,
      registry: getDaemonCellRegistry(c) ?? null,
      dataEncryptionSecrets: c.get('dataEncryptionSecrets') ?? null,
      organizationId: args.organizationId,
      row,
      ref: source.commitSha,
      paths,
      serverIds: [args.serverId],
      daemonOnRateLimit: true,
      ...daemonCredentialOf(source),
    })
    return outcome.ok
      ? { ok: true, files: outcome.files, commitSha: outcome.commitSha }
      : { ok: false, message: outcome.message }
  }

  return (source, paths) => {
    const key = [args.organizationId, source.sourceId, source.commitSha, ...paths].join('\n')
    let pending = reads.get(key)
    if (!pending) {
      pending = readOnce(source, paths)
      reads.set(key, pending)
    }
    return pending
  }
}
