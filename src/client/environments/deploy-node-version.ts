/**
 * Which Node series a native (`serviceKind: node`) app gets, when its compose
 * service names none.
 *
 * The daemon has to know the series before it checks anything out: it installs
 * that Node and adds the site owner's Linux user to the series' group first.
 * So the answer is worked out here, from the repository at the exact commit
 * this deploy builds, and sent as the payload's `nodeVersion`:
 *
 * 1. `x-turbopanel.nodeVersion` on the service always wins; nothing is read.
 * 2. `package.json` `engines.node` (a range such as `>=26.7.0`, `^22`,
 *    `20 || 22`) → the newest offered series it allows.
 * 3. `.nvmrc`, then `.node-version` (a version such as `26` or `v24.1.0`).
 * 4. Nothing usable → left unset, and the daemon uses its default (24).
 *
 * Files are read from the service's `subdirectory` first and, when it has one,
 * from the repository root after that, so a monorepo that keeps `.nvmrc` at
 * the top still counts. A value that is not a version at all (`lts/*`, `node`)
 * says nothing and the next file is tried. A range no offered series
 * satisfies is a hard error naming the range and the offered series. A
 * repository that cannot be read leaves the series unset with a warning
 * rather than failing the deploy.
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
export type NodeVersionOrigin = 'compose' | 'package.json' | '.nvmrc' | '.node-version' | 'default'

/** One native app's Node series, for people (the deploy preview). */
export type NativeAppNodeVersionView = {
  composeServiceName: string
  /** The series the app runs: what is sent, or the daemon default when nothing is. */
  nodeVersion: string
  source: NodeVersionOrigin
  /** What the file said (`>=26.7.0`), when the series came from one. */
  requested?: string
  /** Repository path that was read (`apps/web/package.json`). */
  path?: string
}

export type NodeVersionPrepareError = {
  kind: 'node_version_unsupported'
  composeServiceName: string
  requested: string
  path: string
  supported: string[]
}

export type NodeVersionWarning = {
  code: 'node_version_unresolved'
  message: string
  details: Record<string, unknown>
}

/** Read `paths` from the repository a source entry clones, at its commit. */
export type NodeVersionFileReader = (
  source: EnvironmentDeploySource,
  paths: readonly string[]
) => Promise<{ ok: true; files: RepositoryFileEntry[] } | { ok: false; message: string }>

type FileKind = 'package.json' | '.nvmrc' | '.node-version'

const FILE_KINDS: readonly FileKind[] = ['package.json', '.nvmrc', '.node-version']

type FoundRequest = { requested: string; path: string; source: FileKind }

type FileDecision = { series: string; request: FoundRequest } | { unsupported: FoundRequest } | null

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

function requestIn(file: RepositoryFileEntry): FoundRequest | undefined {
  if (!file.found) return undefined
  const source = kindOf(file.path)
  if (!source) return undefined
  const requested =
    source === 'package.json' ? enginesNode(file.content) : firstVersionLine(file.content)
  return requested === undefined ? undefined : { requested, path: file.path, source }
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
    const range = parseNodeVersionRange(request.requested)
    if (!range) continue
    const series = newestAllowedSeries(range, offered)
    return series === null ? { unsupported: request } : { series, request }
  }
  return null
}

function defaultView(composeServiceName: string): NativeAppNodeVersionView {
  return { composeServiceName, nodeVersion: DEFAULT_NATIVE_APP_NODE_SERIES, source: 'default' }
}

type AppOutcome =
  | { app: PreparedNativeAppService; view: NativeAppNodeVersionView; warning?: NodeVersionWarning }
  | { error: NodeVersionPrepareError }

async function resolveOneApp(
  app: PreparedNativeAppService,
  source: EnvironmentDeploySource | undefined,
  read: NodeVersionFileReader,
  offered: readonly string[]
): Promise<AppOutcome> {
  const name = app.composeServiceName
  const pinned = app.nodeVersion?.trim()
  if (pinned) {
    return { app, view: { composeServiceName: name, nodeVersion: pinned, source: 'compose' } }
  }
  if (!source) return { app, view: defaultView(name) }

  const paths = nodeVersionFilePaths(source.subdirectory)
  const fetched = await read(source, paths)
  if (!fetched.ok) {
    return {
      app,
      view: defaultView(name),
      warning: {
        code: 'node_version_unresolved',
        message: `Could not read the repository of "${name}" to find which Node version it needs (${fetched.message}). It will use Node ${DEFAULT_NATIVE_APP_NODE_SERIES}.`,
        details: { composeServiceName: name, commitSha: source.commitSha },
      },
    }
  }

  const decision = nodeVersionFromFiles(fetched.files, paths, offered)
  if (decision === null) return { app, view: defaultView(name) }
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

/**
 * Fill in `nodeVersion` for every native app that does not name one, from its
 * repository at the commit being deployed.
 *
 * Returns the apps to send (unchanged when nothing was found) and, for the
 * preview, the series each one runs and where it came from.
 */
export async function withNativeAppNodeVersions(
  apps: readonly PreparedNativeAppService[],
  sourceMaterial: readonly EnvironmentDeploySource[],
  ctx: {
    read: NodeVersionFileReader
    /** The prepare's warning list; only ever pushed to. */
    warnings: { push(warning: NodeVersionWarning): unknown }
    offered?: readonly string[]
  }
): Promise<
  { apps: PreparedNativeAppService[]; views: NativeAppNodeVersionView[] } | NodeVersionPrepareError
> {
  const offered = ctx.offered ?? runtimeSeries('node')
  const sourceByName = new Map(sourceMaterial.map((entry) => [entry.composeServiceName, entry]))
  const outcomes = await Promise.all(
    apps.map((app) =>
      resolveOneApp(app, sourceByName.get(app.composeServiceName), ctx.read, offered)
    )
  )
  const resolved: PreparedNativeAppService[] = []
  const views: NativeAppNodeVersionView[] = []
  for (const outcome of outcomes) {
    if ('error' in outcome) return outcome.error
    if (outcome.warning) ctx.warnings.push(outcome.warning)
    resolved.push(outcome.app)
    views.push(outcome.view)
  }
  return { apps: resolved, views }
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
 * The reader deploy-prepare uses: the repository inspect path (the provider's
 * read API first, a connected server when the provider cannot read), at the
 * source entry's commit.
 *
 * The daemon lane only asks the server this prepare is for, and passes the
 * clone secret already sealed to that server's daemon, so a private repository
 * a provider cannot read is read with the same access the build will use.
 * Repository rows are loaded once per source and shared.
 */
export function repositoryNodeVersionReader(
  c: Context<AppEnv>,
  db: Db,
  args: { organizationId: string; serverId: string }
): NodeVersionFileReader {
  const rows = new Map<string, Promise<GitProviderSourceRow | undefined>>()
  const rowFor = (sourceId: string): Promise<GitProviderSourceRow | undefined> => {
    let pending = rows.get(sourceId)
    if (!pending) {
      pending = db
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
        .where(and(eq(repository.id, sourceId), eq(repository.organizationId, args.organizationId)))
        .limit(1)
        .then((found) => found[0])
      rows.set(sourceId, pending)
    }
    return pending
  }

  return async (source, paths) => {
    const row = await rowFor(source.sourceId)
    if (!row) return { ok: false, message: 'repository not found in this organization' }
    const outcome = await inspectRepository({
      db,
      registry: getDaemonCellRegistry(c) ?? null,
      dataEncryptionSecrets: c.get('dataEncryptionSecrets') ?? null,
      organizationId: args.organizationId,
      row,
      ref: source.commitSha,
      paths,
      serverIds: [args.serverId],
      ...daemonCredentialOf(source),
    })
    return outcome.ok ? { ok: true, files: outcome.files } : { ok: false, message: outcome.message }
  }
}
