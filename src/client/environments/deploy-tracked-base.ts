/**
 * The Base of a project that follows its repository's compose file.
 *
 * A project created from a Git repository stores `options.composeSource` with
 * `mode: 'track'`. Each deploy then reads `composeSource.path` at the commit it
 * deploys, uses that document as the project's Base, and layers the
 * environment's own changes on top exactly as it always did. This module is the
 * one place that read happens; the scheduler's plan and every per-server
 * prepare call it and get the same answer, because the result is cached for the
 * request.
 *
 * Which commit: the one a trigger already resolved for that repository (a push
 * names it), else the head of `composeSource.ref` (else the repository's
 * default branch). A head read is then pinned for the services that build from
 * the same repository and branch, so the file and the code come from one
 * commit even if a push lands mid-deploy.
 *
 * How the file is read: the repository inspect path (the provider's read API,
 * a connected server when the provider cannot read), the same one the Node
 * version lookup uses. Nothing is cloned for it.
 *
 * Nothing falls back silently. A deploy whose file is missing, unreadable or
 * not a compose document fails with a code that names the file and the commit.
 * A preview, which only shows what a deploy would do, may use the stored Base
 * and says so with a warning.
 */
import type { Context } from 'hono'
import { and, eq } from 'drizzle-orm'
import type { AppEnv } from '../../app/app.ts'
import { type Db, getDaemonCellRegistry } from '../../db/connection.ts'
import { project, repository, server } from '../../db/schema.ts'
import { assertComposeDocument, yamlToComposeDocument } from '../../features/compose/index.ts'
import type { ComposeDocument } from '../../features/compose/index.ts'
import type { GitProviderSourceRow, RepositoryFileEntry } from '../../features/git/git-provider.ts'
import { syncProjectWatch } from '../../features/git/watch-records.ts'
import {
  composeSourceDigest,
  isTrackingComposeSource,
  parseProjectOptions,
  type ComposeBaseRecord,
  type DeployProjectOptions,
  type ProjectComposeSource,
  type TrackedBaseError,
} from '../../features/projects/project-options.ts'
import {
  environmentBranchBindings,
  normalizeBranchName,
  trackedBranches,
} from '../../features/git/environment-branch-tracking.ts'
import { inspectRepository, type InspectOutcome } from '../repositories/inspect.ts'
import { requestedCommitShaForSource } from './deploy-sources.ts'

/** One file read of a repository at a ref (a branch, or a commit). */
export type TrackedFileReader = (
  ref: string
) => Promise<
  | { ok: true; commitSha: string; file: RepositoryFileEntry | undefined }
  | { ok: false; message: string }
>

export type TrackedBaseRead =
  | { ok: true; document: ComposeDocument; record: ComposeBaseRecord; source: string }
  | { ok: false; error: TrackedBaseError }

function describeCommit(commitSha: string | undefined, ref: string): string {
  return commitSha === undefined ? `ref "${ref}"` : `commit ${commitSha.slice(0, 12)}`
}

/**
 * Read and parse the compose file a project tracks.
 *
 * `ref` is the branch (or tag) the project follows; `pinnedCommitSha`, when a
 * trigger already resolved the commit for this repository, is what is read
 * instead of the branch head.
 */
export async function readTrackedComposeBase(
  composeSource: ProjectComposeSource,
  ref: string,
  pinnedCommitSha: string | undefined,
  read: TrackedFileReader
): Promise<TrackedBaseRead> {
  const { sourceId, path } = composeSource
  const base = { sourceId, ref, path }
  const outcome = await read(pinnedCommitSha ?? ref)
  if (!outcome.ok) {
    return {
      ok: false,
      error: {
        ...base,
        ...(pinnedCommitSha === undefined ? {} : { commitSha: pinnedCommitSha }),
        code: 'compose_source_unavailable',
        message: `Could not read ${path} at ${describeCommit(pinnedCommitSha, ref)} from the repository: ${outcome.message}`,
      },
    }
  }
  const { commitSha, file } = outcome
  if (!file?.found) {
    const why =
      file && !file.found && file.reason !== 'not_found'
        ? ` (the file is ${file.reason.replaceAll('_', ' ')})`
        : ''
    return {
      ok: false,
      error: {
        ...base,
        commitSha,
        code: 'compose_file_missing',
        message: `The compose file ${path} does not exist at ${describeCommit(commitSha, ref)}${why}. The project follows that file, so this deploy was stopped instead of using an older copy.`,
      },
    }
  }
  let document: ComposeDocument
  try {
    document = assertComposeDocument(yamlToComposeDocument(file.content))
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'not a compose document'
    return {
      ok: false,
      error: {
        ...base,
        commitSha,
        code: 'compose_file_unparseable',
        message: `The compose file ${path} at ${describeCommit(commitSha, ref)} could not be used: ${detail}. This deploy was stopped instead of using an older copy.`,
      },
    }
  }
  return {
    ok: true,
    document,
    source: file.content,
    record: { sourceId, ref, path, commitSha, digest: await composeSourceDigest(file.content) },
  }
}

export type DeployProjectOptionsMode = 'deploy' | 'preview'

type ResolveArgs = {
  organizationId: string
  projectId: string
  projectOptions: unknown
  mode: DeployProjectOptionsMode
  /**
   * A rollback re-promotes releases that exist, and a hostings-only run builds
   * nothing: neither reads the repository, both keep the stored Base.
   */
  skipRead?: boolean
  /**
   * A rollback: the Base recorded on the deployment being rolled back to.
   * That file is read again at that commit, never the latest read.
   */
  atBase?: ComposeBaseRecord
  /** The environment being deployed: the branch it builds decides which commit is read. */
  environmentId?: string
  environmentOptions?: unknown
  selection?: {
    ref: string | null
    commitSha: string | null
    sourceId: string | null
  }
}

const resolvedByRequest = new WeakMap<object, Map<string, Promise<DeployProjectOptions>>>()

function sourceRow(
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
    .then((rows) => rows[0])
}

function storedBaseRecord(composeSource: ProjectComposeSource): ComposeBaseRecord | null {
  if (!composeSource.lastReadCommitSha || !composeSource.lastReadDigest) return null
  return {
    sourceId: composeSource.sourceId,
    ref: composeSource.ref ?? '',
    path: composeSource.path,
    commitSha: composeSource.lastReadCommitSha,
    digest: composeSource.lastReadDigest,
  }
}

function withBase(options: unknown, document: ComposeDocument): unknown {
  const record = typeof options === 'object' && options !== null ? options : {}
  return { ...(record as Record<string, unknown>), compose: document }
}

/**
 * Keep the stored Base equal to what a deploy just used, so every other reader
 * of the Base (listings, lint, a switch to `seed`) sees the last-read content.
 * Written under the project row lock, re-reading the row so a concurrent edit
 * of something else is never overwritten.
 */
export async function storeTrackedBase(
  db: Db,
  projectId: string,
  document: unknown,
  record: ComposeBaseRecord
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ options: project.options })
      .from(project)
      .where(eq(project.id, projectId))
      .for('update')
      .limit(1)
    const current = row?.options
    if (typeof current !== 'object' || current === null) return
    const options = current as Record<string, unknown>
    const source = parseProjectOptions(options).composeSource
    // Stop following (or re-pointed at another file) while this deploy read.
    if (
      !isTrackingComposeSource(source) ||
      source.sourceId !== record.sourceId ||
      source.path !== record.path
    ) {
      return
    }
    if (
      source.lastReadDigest === record.digest &&
      source.lastReadCommitSha === record.commitSha &&
      options.compose !== undefined
    ) {
      return
    }
    await tx
      .update(project)
      .set({
        options: {
          ...options,
          compose: document,
          composeSource: {
            ...source,
            lastReadCommitSha: record.commitSha,
            lastReadDigest: record.digest,
          },
        },
      })
      .where(eq(project.id, projectId))
    await syncProjectWatch(tx, projectId)
  })
}

/**
 * The branch this environment deploys the repository from. An environment that
 * binds the repository on its own branch (staging on `staging`) reads the
 * file there; otherwise the project's `composeSource.ref`. A push names the
 * branch it was for, which wins when the environment follows it.
 */
function environmentRef(
  args: ResolveArgs,
  composeSource: ProjectComposeSource,
  defaultBranch: string | null
): string | null {
  const own = normalizeBranchName(composeSource.ref ?? defaultBranch)
  if (args.environmentOptions === undefined) return composeSource.ref ?? null
  const branches = trackedBranches(
    environmentBranchBindings({
      projectOptions: args.projectOptions,
      environmentOptions: args.environmentOptions,
      sourceId: composeSource.sourceId,
      repositoryDefaultBranch: defaultBranch,
    })
  )
  if (branches.length === 0) return composeSource.ref ?? null
  const pushed = normalizeBranchName(args.selection?.ref)
  if (pushed !== null && branches.includes(pushed)) return pushed
  if (own !== null && branches.includes(own)) return own
  return branches[0] ?? null
}

async function resolveUncached(
  c: Context<AppEnv>,
  db: Db,
  args: ResolveArgs,
  composeSource: ProjectComposeSource,
  inspect: typeof inspectRepository
): Promise<DeployProjectOptions> {
  const source = args.atBase ? { ...composeSource, path: args.atBase.path } : composeSource
  const row = await sourceRow(db, args.organizationId, composeSource.sourceId)
  const ref = (
    args.atBase?.ref ??
    environmentRef(args, composeSource, row?.defaultBranch ?? null) ??
    row?.defaultBranch ??
    ''
  ).trim()
  const failure = (message: string): DeployProjectOptions => ({
    ok: false,
    error: {
      code: 'compose_source_unavailable',
      message: `Could not read ${composeSource.path} from the repository: ${message}`,
      sourceId: composeSource.sourceId,
      ref,
      path: composeSource.path,
    },
  })
  if (!row) return failure('the repository is no longer connected to this organization.')
  if (args.atBase && args.atBase.sourceId !== composeSource.sourceId) {
    return failure('the project now follows a different repository than that release was built from.')
  }
  if (ref.length === 0) return failure('the repository records no default branch to follow.')

  const serverIds = (
    await db
      .select({ id: server.id })
      .from(server)
      .where(eq(server.organizationId, args.organizationId))
  ).map((entry) => entry.id)

  const read: TrackedFileReader = async (readRef) => {
    const outcome: InspectOutcome = await inspect({
      db,
      registry: getDaemonCellRegistry(c) ?? null,
      dataEncryptionSecrets: c.get('dataEncryptionSecrets') ?? null,
      organizationId: args.organizationId,
      row: { ...row, defaultBranch: ref },
      ref: readRef,
      paths: [source.path],
      serverIds,
      daemonOnRateLimit: true,
    })
    if (!outcome.ok) return { ok: false, message: outcome.message }
    return {
      ok: true,
      commitSha: outcome.commitSha,
      file: outcome.files.find((entry) => entry.path === source.path),
    }
  }

  const pinned =
    args.atBase?.commitSha ??
    requestedCommitShaForSource(args.selection ?? undefined, composeSource.sourceId, ref)
  const result = await readTrackedComposeBase(source, ref,
    pinned,
    read
  )
  if (!result.ok) {
    if (args.mode === 'preview') {
      return {
        ok: true,
        options: args.projectOptions,
        base: storedBaseRecord(composeSource),
        unreadable: result.error,
      }
    }
    return { ok: false, error: result.error }
  }
  return {
    ok: true,
    options: withBase(args.projectOptions, result.document),
    base: result.record,
    // A deploy stores what it read only once it is accepted (`storeTrackedBase`);
    // a rollback re-reads an old commit and never changes the stored Base.
    ...(args.mode === 'deploy' && args.atBase === undefined
      ? { read: { document: result.document, record: result.record } }
      : {}),
    ...(pinned === undefined && normalizeBranchName(ref) !== null
      ? { pin: { sourceId: composeSource.sourceId, ref, commitSha: result.record.commitSha } }
      : {}),
  }
}

let inspectOverride: typeof inspectRepository | null = null

/** Test seam: the repository read a route-level test serves instead of a provider. */
export function setTrackedInspectForTests(inspect: typeof inspectRepository | null): void {
  inspectOverride = inspect
}

/**
 * The project options a deploy or preview should merge, with the tracked Base
 * swapped in when the project follows its repository's compose file. Projects
 * that do not follow one come back untouched.
 */
export function resolveDeployProjectOptions(
  c: Context<AppEnv>,
  db: Db,
  args: ResolveArgs,
  inspect: typeof inspectRepository = inspectOverride ?? inspectRepository
): Promise<DeployProjectOptions> {
  const composeSource = parseProjectOptions(args.projectOptions).composeSource
  if (!isTrackingComposeSource(composeSource)) {
    return Promise.resolve({ ok: true, options: args.projectOptions, base: null })
  }
  if (args.skipRead === true) {
    return Promise.resolve({
      ok: true,
      options: args.projectOptions,
      base: storedBaseRecord(composeSource),
    })
  }
  let byKey = resolvedByRequest.get(c)
  if (!byKey) {
    byKey = new Map()
    resolvedByRequest.set(c, byKey)
  }
  const key = [
    args.projectId,
    args.mode,
    args.environmentId ?? '',
    args.atBase ? `${args.atBase.commitSha}:${args.atBase.path}` : '',
    args.selection?.sourceId ?? '',
    args.selection?.commitSha ?? '',
    args.selection?.ref ?? '',
  ].join('\n')
  let pending = byKey.get(key)
  if (!pending) {
    pending = resolveUncached(c, db, args, composeSource, inspect)
    byKey.set(key, pending)
  }
  return pending
}

/** Warning text for a preview that used the stored Base. */
export function previewBaseFallbackMessage(error: TrackedBaseError): string {
  return `${error.message} This preview uses the Base from the last deploy instead.`
}
