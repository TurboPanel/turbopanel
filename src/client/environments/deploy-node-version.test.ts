import { assertEquals } from '@std/assert'
import type { EnvironmentDeploySource } from '../../contracts/commands/schemas.ts'
import type { PreparedNativeAppService } from '../../features/compose/ir.ts'
import type { RepositoryFileEntry } from '../../features/git/git-provider.ts'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import {
  daemonCredentialOf,
  type NodeVersionFileReader,
  type NodeVersionWarning,
  nodeVersionFilePaths,
  nodeVersionFromFiles,
  repositoryNodeVersionReader,
  withNativeAppNodeVersions,
} from './deploy-node-version.ts'
import { mapPrepareErrorResponse } from './deploy-routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const OFFERED = ['22', '24', '26']
const COMMIT = '0123456789abcdef0123456789abcdef01234567'

function file(path: string, content: string): RepositoryFileEntry {
  return { path, found: true, content, bytes: content.length }
}

function missing(path: string): RepositoryFileEntry {
  return { path, found: false, reason: 'not_found' }
}

function packageJson(enginesNode: unknown): string {
  return JSON.stringify({ name: 'web', engines: { node: enginesNode } })
}

function app(nodeVersion?: string): PreparedNativeAppService {
  return {
    composeServiceName: 'web',
    listenPort: 18100,
    framework: 'next',
    ...(nodeVersion === undefined ? {} : { nodeVersion }),
  }
}

function source(subdirectory?: string): EnvironmentDeploySource {
  return {
    sourceId: '00000000-0000-4000-8000-000000000001',
    composeServiceName: 'web',
    provider: 'github',
    cloneUrl: 'https://github.com/TurboPanel/website.git',
    ref: 'trunk',
    commitSha: COMMIT,
    releaseId: 'rel-1',
    build: { kind: 'native' },
    ...(subdirectory === undefined ? {} : { subdirectory }),
  } as EnvironmentDeploySource
}

/** A reader that serves `files` and records every call. */
function reader(files: RepositoryFileEntry[]): {
  read: NodeVersionFileReader
  calls: Array<{ ref: string; paths: readonly string[] }>
} {
  const calls: Array<{ ref: string; paths: readonly string[] }> = []
  const byPath = new Map(files.map((entry) => [entry.path, entry]))
  return {
    calls,
    read: (entry, paths) => {
      calls.push({ ref: entry.commitSha, paths })
      return Promise.resolve({
        ok: true,
        files: paths.map((path) => byPath.get(path) ?? missing(path)),
      })
    },
  }
}

test('reads the subdirectory first, then the repository root', () => {
  assertEquals(nodeVersionFilePaths(undefined), ['package.json', '.nvmrc', '.node-version'])
  assertEquals(nodeVersionFilePaths('apps/web/'), [
    'apps/web/package.json',
    'apps/web/.nvmrc',
    'apps/web/.node-version',
    'package.json',
    '.nvmrc',
    '.node-version',
  ])
})

test('package.json engines.node wins over .nvmrc and .node-version', () => {
  const paths = nodeVersionFilePaths(undefined)
  const decision = nodeVersionFromFiles(
    [
      file('package.json', packageJson('>=26.7.0')),
      file('.nvmrc', '22'),
      file('.node-version', '24'),
    ],
    paths,
    OFFERED
  )
  assertEquals(decision, {
    series: '26',
    request: { requested: '>=26.7.0', path: 'package.json', source: 'package.json' },
  })
})

test('.nvmrc is next, then .node-version', () => {
  const paths = nodeVersionFilePaths(undefined)
  assertEquals(
    nodeVersionFromFiles(
      [
        file('package.json', JSON.stringify({ name: 'web' })),
        file('.nvmrc', '# pinned\nv22.11.0\n'),
        file('.node-version', '24'),
      ],
      paths,
      OFFERED
    ),
    { series: '22', request: { requested: 'v22.11.0', path: '.nvmrc', source: '.nvmrc' } }
  )
  assertEquals(nodeVersionFromFiles([file('.node-version', '24.1.0\n')], paths, OFFERED), {
    series: '24',
    request: { requested: '24.1.0', path: '.node-version', source: '.node-version' },
  })
})

test('a value that is not a version, or a broken package.json, falls through', () => {
  const paths = nodeVersionFilePaths(undefined)
  assertEquals(
    nodeVersionFromFiles(
      [file('package.json', '{ not json'), file('.nvmrc', 'lts/*'), file('.node-version', '26')],
      paths,
      OFFERED
    ),
    { series: '26', request: { requested: '26', path: '.node-version', source: '.node-version' } }
  )
  assertEquals(nodeVersionFromFiles([file('package.json', packageJson(22))], paths, OFFERED), null)
  assertEquals(nodeVersionFromFiles([], paths, OFFERED), null)
})

test('the subdirectory answer beats the root one', () => {
  const paths = nodeVersionFilePaths('apps/web')
  assertEquals(
    nodeVersionFromFiles(
      [file('apps/web/.nvmrc', '24'), file('package.json', packageJson('>=26'))],
      paths,
      OFFERED
    ),
    { series: '24', request: { requested: '24', path: 'apps/web/.nvmrc', source: '.nvmrc' } }
  )
})

test('a range nothing offered satisfies is reported, not skipped', () => {
  const paths = nodeVersionFilePaths(undefined)
  assertEquals(
    nodeVersionFromFiles(
      [file('package.json', packageJson('^20')), file('.nvmrc', '24')],
      paths,
      OFFERED
    ),
    { unsupported: { requested: '^20', path: 'package.json', source: 'package.json' } }
  )
})

test('sends the series read at the deployed commit and says where it came from', async () => {
  const { read, calls } = reader([file('package.json', packageJson('>=26.7.0'))])
  const warnings: NodeVersionWarning[] = []
  const result = await withNativeAppNodeVersions([app()], [source()], {
    mode: 'deploy',
    read,
    warnings,
    offered: OFFERED,
  })
  if ('kind' in result) throw new TypeError('expected apps')
  assertEquals(result.apps[0]?.nodeVersion, '26')
  assertEquals(result.views, [
    {
      composeServiceName: 'web',
      nodeVersion: '26',
      source: 'package.json',
      requested: '>=26.7.0',
      path: 'package.json',
    },
  ])
  assertEquals(calls, [{ ref: COMMIT, paths: ['package.json', '.nvmrc', '.node-version'] }])
  assertEquals(warnings, [])
})

test('an explicit compose nodeVersion wins and nothing is read', async () => {
  const { read, calls } = reader([file('package.json', packageJson('>=26.7.0'))])
  const result = await withNativeAppNodeVersions([app('22')], [source()], {
    mode: 'deploy',
    read,
    warnings: [],
    offered: OFFERED,
  })
  if ('kind' in result) throw new TypeError('expected apps')
  assertEquals(result.apps[0]?.nodeVersion, '22')
  assertEquals(result.views[0]?.source, 'compose')
  assertEquals(calls, [])
})

test('nothing in the repository leaves the series unset (daemon default)', async () => {
  const { read } = reader([])
  const result = await withNativeAppNodeVersions([app()], [source()], {
    mode: 'deploy',
    read,
    warnings: [],
    offered: OFFERED,
  })
  if ('kind' in result) throw new TypeError('expected apps')
  assertEquals('nodeVersion' in (result.apps[0] ?? {}), false)
  assertEquals(result.views, [{ composeServiceName: 'web', nodeVersion: '24', source: 'default' }])
})

test('an app with no repository binding gets the default without a read', async () => {
  const { read, calls } = reader([])
  const result = await withNativeAppNodeVersions([app()], [], {
    mode: 'deploy',
    read,
    warnings: [],
    offered: OFFERED,
  })
  if ('kind' in result) throw new TypeError('expected apps')
  assertEquals(result.views[0]?.source, 'default')
  assertEquals(calls, [])
})

const unreadable: NodeVersionFileReader = () =>
  Promise.resolve({ ok: false, message: 'No connected server can read this repository.' })

test('a preview of an unreadable repository warns and leaves the series unset', async () => {
  const warnings: NodeVersionWarning[] = []
  const result = await withNativeAppNodeVersions([app()], [source()], {
    mode: 'preview',
    read: unreadable,
    warnings,
    offered: OFFERED,
  })
  if ('kind' in result) throw new TypeError('expected apps')
  assertEquals('nodeVersion' in (result.apps[0] ?? {}), false)
  assertEquals(
    warnings.map((warning) => warning.code),
    ['node_version_unresolved']
  )
  assertEquals(warnings[0]?.details.composeServiceName, 'web')
})

test('an unsupported range fails prepare with a plain-words 422', async () => {
  const { read } = reader([file('package.json', packageJson('>=28'))])
  const result = await withNativeAppNodeVersions([app()], [source()], {
    mode: 'deploy',
    read,
    warnings: [],
    offered: OFFERED,
  })
  assertEquals(result, {
    kind: 'node_version_unsupported',
    composeServiceName: 'web',
    requested: '>=28',
    path: 'package.json',
    supported: OFFERED,
  })
  if (!('kind' in result)) throw new TypeError('expected an error')
  const response = mapPrepareErrorResponse(result)
  assertEquals(response.status, 422)
  assertEquals(response.body.error, 'node_version_unsupported')
  assertEquals(
    response.body.message,
    'Node app "web" asks for Node >=28 in package.json, and no Node version this platform offers matches that. Offered: 22, 24, 26. Change package.json, or set x-turbopanel.nodeVersion on the service to one of the offered versions.'
  )
})

/** A db whose one `repository` lookup answers with `rows`, counting lookups. */
function repositoryDb(rows: unknown[]): { db: Db; lookups: () => number } {
  let count = 0
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => {
      count += 1
      return Promise.resolve(rows)
    },
  }
  return { db: chain as unknown as Db, lookups: () => count }
}

/** A request context with no daemon registry and no at-rest key. */
const bareContext = { get: () => undefined } as unknown as Context<AppEnv>

test('the reader names a repository it cannot find in the organization', async () => {
  const { db } = repositoryDb([])
  const read = repositoryNodeVersionReader(bareContext, db, {
    organizationId: '00000000-0000-4000-8000-0000000000aa',
    serverId: '00000000-0000-4000-8000-0000000000bb',
  })
  assertEquals(await read(source(), ['package.json']), {
    ok: false,
    message: 'repository not found in this organization',
  })
})

test('the reader goes through the inspect path and loads each repository once', async () => {
  // A plain git remote has no provider read API, so inspect falls back to a
  // connected server; with none available the read fails and says why.
  const { db, lookups } = repositoryDb([
    {
      id: '00000000-0000-4000-8000-000000000001',
      provider: 'git',
      repositoryUrl: 'git@git.example.test:team/web.git',
      defaultBranch: 'trunk',
      subdirectory: null,
      connectionId: null,
      secretId: null,
    },
  ])
  const read = repositoryNodeVersionReader(bareContext, db, {
    organizationId: '00000000-0000-4000-8000-0000000000aa',
    serverId: '00000000-0000-4000-8000-0000000000bb',
  })
  const [first, second] = await Promise.all([
    read(source(), ['package.json']),
    read(source(), ['.nvmrc']),
  ])
  assertEquals(first.ok, false)
  assertEquals(second.ok, false)
  assertEquals(lookups(), 1)
})

test('the daemon lane gets the clone secret the deploy sealed, and nothing in preview', () => {
  assertEquals(daemonCredentialOf(source()), {})
  const sealed = {
    ...source(),
    credential: 'tpdaemon.sealed',
    credentialKind: 'token',
    credentialUsername: 'oauth2',
  } as EnvironmentDeploySource
  assertEquals(daemonCredentialOf(sealed), {
    daemonCredential: {
      credential: 'tpdaemon.sealed',
      credentialKind: 'token',
      credentialUsername: 'oauth2',
    },
  })
  const keyOnly = { ...source(), credential: 'tpdaemon.key' } as EnvironmentDeploySource
  assertEquals(daemonCredentialOf(keyOnly), { daemonCredential: { credential: 'tpdaemon.key' } })
})

test('a deploy refuses an unreadable repository instead of guessing', async () => {
  const warnings: NodeVersionWarning[] = []
  const result = await withNativeAppNodeVersions([app()], [source()], {
    mode: 'deploy',
    read: unreadable,
    warnings,
    offered: OFFERED,
  })
  assertEquals(result, {
    kind: 'node_version_unreadable',
    composeServiceName: 'web',
    message: 'No connected server can read this repository.',
  })
  assertEquals(warnings, [])
  if (!('kind' in result)) throw new TypeError('expected an error')
  const response = mapPrepareErrorResponse(result)
  assertEquals(response.status, 422)
  assertEquals(response.body.error, 'node_version_unreadable')
  assertEquals(
    String(response.body.message).includes('set x-turbopanel.nodeVersion on the service'),
    true
  )
})

test('a rollback of an unreadable repository falls back to the default', async () => {
  const rollback = { ...source(), rollbackToReleaseId: 'rel-0' } as EnvironmentDeploySource
  const warnings: NodeVersionWarning[] = []
  const result = await withNativeAppNodeVersions([app()], [rollback], {
    mode: 'deploy',
    read: unreadable,
    warnings,
    offered: OFFERED,
  })
  if ('kind' in result) throw new TypeError('expected apps')
  assertEquals(result.views[0]?.source, 'default')
  assertEquals(warnings.length, 1)
})
