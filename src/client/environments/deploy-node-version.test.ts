import { assertEquals } from '@std/assert'
import type { EnvironmentDeploySource } from '../../contracts/commands/schemas.ts'
import type { PreparedNativeAppService } from '../../features/compose/ir.ts'
import type { RepositoryFileEntry } from '../../features/git/git-provider.ts'
import { NEWEST_NATIVE_APP_NODE_SERIES } from '../../contracts/runtime-registry.ts'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import {
  daemonCredentialOf,
  type NodeVersionFileReader,
  pinSourcesToReadCommits,
  recordedNodeVersions,
  resolveSourceNodeVersions,
  type NodeVersionWarning,
  nodeVersionFilePaths,
  nodeVersionFromFiles,
  nodeVersionSuggestion,
  repositoryNodeVersionReader,
  withNativeAppNodeVersions,
} from './deploy-node-version.ts'
import { mapPrepareErrorResponse, queuedCommandsResponseBody } from './deploy-routes-helpers.ts'
import { contextReleaseFromSource, contextReleasesFor } from './deploy-routes.ts'
import { releasePin } from './release-routes.ts'
import { listServiceReleases } from '../../features/git/releases.ts'
import { normalizeContextReleases } from '../../features/commands/context.ts'
import {
  type InspectRepositoryParams,
  isRateLimited,
  providerAnswerStands,
} from '../repositories/inspect.ts'

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
    serviceId: '00000000-0000-4000-8000-0000000000a1',
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
        commitSha: COMMIT,
      })
    },
  }
}

test('reads the subdirectory first, then the repository root', () => {
  assertEquals(nodeVersionFilePaths(undefined), [
    'package.json',
    '.nvmrc',
    '.node-version',
    '.tool-versions',
  ])
  assertEquals(nodeVersionFilePaths('apps/web/'), [
    'apps/web/package.json',
    'apps/web/.nvmrc',
    'apps/web/.node-version',
    'apps/web/.tool-versions',
    'package.json',
    '.nvmrc',
    '.node-version',
    '.tool-versions',
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
  assertEquals(calls, [
    { ref: COMMIT, paths: ['package.json', '.nvmrc', '.node-version', '.tool-versions'] },
  ])
  assertEquals(warnings, [])
  assertEquals([...result.readCommitShas], [['web', COMMIT]])
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

test('nothing in the repository leaves the series unset (the daemon runs the newest)', async () => {
  const { read } = reader([])
  const result = await withNativeAppNodeVersions([app()], [source()], {
    mode: 'deploy',
    read,
    warnings: [],
    offered: OFFERED,
  })
  if ('kind' in result) throw new TypeError('expected apps')
  assertEquals('nodeVersion' in (result.apps[0] ?? {}), false)
  assertEquals(result.views, [{ composeServiceName: 'web', nodeVersion: '26', source: 'newest' }])
})

test('an app with no repository binding gets the newest series without a read', async () => {
  const { read, calls } = reader([])
  const result = await withNativeAppNodeVersions([app()], [], {
    mode: 'deploy',
    read,
    warnings: [],
    offered: OFFERED,
  })
  if ('kind' in result) throw new TypeError('expected apps')
  assertEquals(result.views[0]?.source, 'newest')
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
  // The preview does not claim a version it could not read.
  const view = result.views[0]
  assertEquals(view?.source, 'unresolved')
  assertEquals(view?.nodeVersion, undefined)
  assertEquals(view?.note?.includes('The deploy reads it again at the commit it builds'), true)
  assertEquals(view?.note?.includes('x-turbopanel.nodeVersion'), true)
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
    'Node app "web" asks for Node >=28 in package.json, and no Node version this platform offers matches that. Offered: 22, 24, 26. Change package.json to allow one of them. To choose one yourself, add to service "web": x-turbopanel: { nodeVersion: "26" }.'
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

/** A fresh request context with no daemon registry and no at-rest key. */
function bareContext(): Context<AppEnv> {
  return { get: () => undefined } as unknown as Context<AppEnv>
}

test('the reader names a repository it cannot find in the organization', async () => {
  const { db } = repositoryDb([])
  const read = repositoryNodeVersionReader(bareContext(), db, {
    organizationId: '00000000-0000-4000-8000-0000000000aa',
    serverId: '00000000-0000-4000-8000-0000000000bb',
  })
  assertEquals(await read(source(), ['package.json']), {
    ok: false,
    message: 'repository not found in this organization',
  })
})

test('the reader goes through the inspect path and reads each repository once per request', async () => {
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
  const c = bareContext()
  const organizationId = '00000000-0000-4000-8000-0000000000aa'
  // Two servers of one deploy share the request, so they share the read.
  const onFirstServer = repositoryNodeVersionReader(c, db, {
    organizationId,
    serverId: '00000000-0000-4000-8000-0000000000bb',
  })
  const onSecondServer = repositoryNodeVersionReader(c, db, {
    organizationId,
    serverId: '00000000-0000-4000-8000-0000000000cc',
  })
  const paths = nodeVersionFilePaths(undefined)
  const [first, second, third] = await Promise.all([
    onFirstServer(source(), paths),
    onFirstServer(source(), paths),
    onSecondServer(source(), paths),
  ])
  assertEquals(first.ok, false)
  assertEquals(second, first)
  assertEquals(third, first)
  assertEquals(lookups(), 1)
  // Another request reads again.
  await repositoryNodeVersionReader(bareContext(), db, {
    organizationId,
    serverId: '00000000-0000-4000-8000-0000000000bb',
  })(source(), paths)
  assertEquals(lookups(), 2)
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
    String(response.body.message).includes(
      'add to service "web": x-turbopanel: { nodeVersion: "26" }'
    ),
    true
  )
})

test('a rollback of an unreadable repository falls back to the newest series', async () => {
  const rollback = { ...source(), rollbackToReleaseId: 'rel-0' } as EnvironmentDeploySource
  const warnings: NodeVersionWarning[] = []
  const result = await withNativeAppNodeVersions([app()], [rollback], {
    mode: 'deploy',
    read: unreadable,
    warnings,
    offered: OFFERED,
  })
  if ('kind' in result) throw new TypeError('expected apps')
  assertEquals(result.views[0]?.source, 'newest')
  assertEquals(warnings.length, 1)
})

test('a rollback runs the series its release recorded and reads nothing', async () => {
  const { read, calls } = reader([file('package.json', packageJson('>=22'))])
  const rollback = { ...source(), rollbackToReleaseId: 'rel-0' } as EnvironmentDeploySource
  const result = await withNativeAppNodeVersions([app('24')], [rollback], {
    mode: 'deploy',
    read,
    warnings: [],
    offered: OFFERED,
    rollbackPins: { web: { nodeVersion: '26' } },
  })
  if ('kind' in result) throw new TypeError('expected apps')
  // The tree was built on 26: it runs on 26, whatever the compose says now.
  assertEquals(result.apps[0]?.nodeVersion, '26')
  assertEquals(result.views, [{ composeServiceName: 'web', nodeVersion: '26', source: 'release' }])
  assertEquals(calls, [])
})

test('a rollback to a release that recorded no series still says what it did', async () => {
  const rollback = { ...source(), rollbackToReleaseId: 'rel-0' } as EnvironmentDeploySource
  const warnings: NodeVersionWarning[] = []
  const result = await withNativeAppNodeVersions([app()], [rollback], {
    mode: 'deploy',
    read: unreadable,
    warnings,
    offered: OFFERED,
    rollbackPins: { web: {} },
  })
  if ('kind' in result) throw new TypeError('expected apps')
  assertEquals(result.views[0]?.source, 'newest')
  assertEquals(warnings[0]?.message.includes('recorded no Node version'), true)
})

test('a pin on an ordinary deploy is not mistaken for a rollback', async () => {
  const { read, calls } = reader([file('package.json', packageJson('>=22'))])
  const result = await withNativeAppNodeVersions([app()], [source()], {
    mode: 'deploy',
    read,
    warnings: [],
    offered: OFFERED,
    rollbackPins: { web: { nodeVersion: '22' } },
  })
  if ('kind' in result) throw new TypeError('expected apps')
  assertEquals(result.apps[0]?.nodeVersion, '26')
  assertEquals(calls.length, 1)
})

test('a disabled app with an unreadable repository does not hold up the deploy', async () => {
  const warnings: NodeVersionWarning[] = []
  const disabled = { ...app(), enabled: false }
  const result = await withNativeAppNodeVersions([disabled], [source()], {
    mode: 'deploy',
    read: unreadable,
    warnings,
    offered: OFFERED,
  })
  if ('kind' in result) throw new TypeError('expected apps')
  assertEquals(result.views[0]?.source, 'newest')
  assertEquals(warnings[0]?.message.includes('The app is disabled'), true)
})

test('an engines.node npm would not accept is refused with a clear message', async () => {
  const { read } = reader([file('package.json', packageJson('20-24')), file('.nvmrc', '24')])
  const result = await withNativeAppNodeVersions([app()], [source()], {
    mode: 'preview',
    read,
    warnings: [],
    offered: OFFERED,
  })
  assertEquals(result, {
    kind: 'node_version_invalid',
    composeServiceName: 'web',
    requested: '20-24',
    path: 'package.json',
  })
  if (!('kind' in result)) throw new TypeError('expected an error')
  const response = mapPrepareErrorResponse(result)
  assertEquals(response.status, 422)
  assertEquals(
    response.body.message,
    'Node app "web": engines.node in package.json is "20-24", which is not a version range npm accepts (a range between two versions needs spaces around the dash, like "20 - 24"). Fix it in package.json. To choose one yourself, add to service "web": x-turbopanel: { nodeVersion: "26" }.'
  )
})

test('a long value is cut short before it is echoed back', () => {
  const long = `>=26 ${'x'.repeat(500)}`
  const decision = nodeVersionFromFiles(
    [file('package.json', packageJson(long))],
    nodeVersionFilePaths(undefined),
    OFFERED
  )
  if (decision === null || !('invalid' in decision)) throw new TypeError('expected invalid')
  assertEquals(decision.invalid.requested.length, 201)
})

test('a deploy builds the commit the version files were read at', () => {
  const branchOnly = { ...source(), commitSha: 'trunk' } as EnvironmentDeploySource
  const other = {
    ...source(),
    composeServiceName: 'api',
    commitSha: 'trunk',
  } as EnvironmentDeploySource
  const rollback = {
    ...source(),
    composeServiceName: 'old',
    commitSha: 'trunk',
    rollbackToReleaseId: 'rel-0',
  } as EnvironmentDeploySource
  const read = new Map([
    ['web', COMMIT],
    ['old', COMMIT],
  ])
  const pinned = pinSourcesToReadCommits([branchOnly, other, rollback, source()], read)
  assertEquals(
    pinned.map((entry) => entry.commitSha),
    // Pinned; not read; a rollback keeps its release; already a commit.
    [COMMIT, 'trunk', 'trunk', COMMIT]
  )
  // A read that did not give back a commit pins nothing.
  assertEquals(
    pinSourcesToReadCommits([branchOnly], new Map([['web', 'trunk']]))[0]?.commitSha,
    'trunk'
  )
})

test('every native app records the series it ran, the newest offered series when none was sent', () => {
  assertEquals(
    [
      ...recordedNodeVersions([
        { composeServiceName: 'web', nodeVersion: '26' },
        { composeServiceName: 'api' },
      ]),
    ],
    [
      ['web', '26'],
      ['api', '26'],
    ]
  )
  assertEquals(recordedNodeVersions(undefined).size, 0)
})

test('the series a deploy ran with comes back on the rollback pin', async () => {
  const recorded = contextReleaseFromSource(source(), '26')
  assertEquals(recorded.nodeVersion, '26')
  assertEquals(normalizeContextReleases([recorded])?.[0]?.nodeVersion, '26')
  // A non-native service records none, and an old row reads back without one.
  assertEquals('nodeVersion' in contextReleaseFromSource(source()), false)

  const rows = [
    {
      id: 'cmd-1',
      serverId: '00000000-0000-4000-8000-0000000000bb',
      status: 'succeeded',
      context: { releases: [recorded] },
      resultSummary: null,
      queuedAt: '2026-10-01T00:00:00.000Z',
      finishedAt: '2026-10-01T00:01:00.000Z',
    },
  ]
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(rows),
  }
  const [release] = await listServiceReleases(
    chain as unknown as Db,
    '00000000-0000-4000-8000-0000000000dd'
  )
  if (!release) throw new TypeError('expected a release')
  assertEquals(release.nodeVersion, '26')
  assertEquals(releasePin(release).nodeVersion, '26')
})

test('a deploy response carries the Node version warnings, and only when there are some', () => {
  const queued = [{ commandId: 'c1', serverId: 's1', status: 'queued' as const }]
  assertEquals('warnings' in queuedCommandsResponseBody(queued), false)
  const warning = { code: 'node_version_unresolved', message: '"web": uses Node 24.' }
  assertEquals(queuedCommandsResponseBody(queued, undefined, [warning]).warnings, [warning])
})

test('only a rate limit sends a provider read to a server instead', () => {
  const anonymous = {
    id: 'r',
    provider: 'github',
    repositoryUrl: 'https://github.com/TurboPanel/website.git',
    defaultBranch: 'trunk',
    subdirectory: null,
    connectionId: null,
    secretId: null,
  }
  assertEquals(isRateLimited(429, anonymous), true)
  assertEquals(isRateLimited(403, anonymous), true)
  assertEquals(isRateLimited(404, anonymous), false)
  // An installation that is refused is refused; a server would be too.
  assertEquals(isRateLimited(403, { ...anonymous, connectionId: 'conn' }), false)
  assertEquals(isRateLimited(429, { ...anonymous, connectionId: 'conn' }), true)
})

test('a long valid range is parsed in full; only what is shown is shortened', () => {
  const majors = Array.from({ length: 20 }, (_, i) => `^${i + 4}.0.0`)
  const long = [...majors, '>=22.11.0'].join(' || ')
  if (long.length <= 200) throw new TypeError('the range must be longer than what is shown')
  const decision = nodeVersionFromFiles(
    [file('package.json', packageJson(long))],
    nodeVersionFilePaths(undefined),
    OFFERED
  )
  if (decision === null || !('series' in decision)) throw new TypeError('expected a series')
  assertEquals(decision.series, '26')
  assertEquals(decision.request.requested.length, 201)
  assertEquals(decision.request.requested.endsWith('…'), true)
})

test('a value past the parse limit is not a range', () => {
  const huge = Array.from({ length: 600 }, () => '^22.0.0').join(' || ')
  const decision = nodeVersionFromFiles(
    [file('package.json', packageJson(huge))],
    nodeVersionFilePaths(undefined),
    OFFERED
  )
  if (decision === null || !('invalid' in decision)) throw new TypeError('expected invalid')
  assertEquals(decision.invalid.requested.length, 201)
})

test('prepare pins a deploy to the commit it read, and never a preview', async () => {
  const { read } = reader([file('package.json', packageJson('>=26'))])
  const branchOnly = { ...source(), commitSha: 'trunk' } as EnvironmentDeploySource
  const deploy = await resolveSourceNodeVersions([app()], [branchOnly], {
    mode: 'deploy',
    read,
    warnings: [],
    offered: OFFERED,
  })
  if ('kind' in deploy) throw new TypeError('expected sources')
  assertEquals(deploy.sourceMaterial[0]?.commitSha, COMMIT)
  assertEquals(deploy.nodeVersions.apps[0]?.nodeVersion, '26')
  const preview = await resolveSourceNodeVersions([app()], [branchOnly], {
    mode: 'preview',
    read,
    warnings: [],
    offered: OFFERED,
  })
  if ('kind' in preview) throw new TypeError('expected sources')
  assertEquals(preview.sourceMaterial[0]?.commitSha, 'trunk')
  const refused = await resolveSourceNodeVersions([app()], [branchOnly], {
    mode: 'deploy',
    read: unreadable,
    warnings: [],
    offered: OFFERED,
  })
  assertEquals('kind' in refused && refused.kind, 'node_version_unreadable')
})

test('the reader asks inspect at the commit, on this server, with the rate-limit fallback', async () => {
  const row = {
    id: '00000000-0000-4000-8000-000000000001',
    provider: 'github',
    repositoryUrl: 'https://github.com/TurboPanel/website.git',
    defaultBranch: 'trunk',
    subdirectory: null,
    connectionId: null,
    secretId: null,
  }
  const { db } = repositoryDb([row])
  const seen: InspectRepositoryParams[] = []
  const read = repositoryNodeVersionReader(
    bareContext(),
    db,
    {
      organizationId: '00000000-0000-4000-8000-0000000000aa',
      serverId: '00000000-0000-4000-8000-0000000000bb',
    },
    (params) => {
      seen.push(params)
      return Promise.resolve({
        ok: true,
        commitSha: COMMIT,
        files: [file('package.json', packageJson('>=26'))],
        entries: [],
        via: 'provider',
      })
    }
  )
  const sealed = {
    ...source(),
    credential: 'tpdaemon.sealed',
    credentialKind: 'token',
  } as EnvironmentDeploySource
  const result = await read(sealed, ['package.json'])
  assertEquals(result.ok && result.commitSha, COMMIT)
  assertEquals(seen.length, 1)
  assertEquals(seen[0]?.ref, COMMIT)
  assertEquals(seen[0]?.paths, ['package.json'])
  assertEquals(seen[0]?.serverIds, ['00000000-0000-4000-8000-0000000000bb'])
  assertEquals(seen[0]?.daemonOnRateLimit, true)
  assertEquals(seen[0]?.daemonCredential, {
    credential: 'tpdaemon.sealed',
    credentialKind: 'token',
  })
  assertEquals(seen[0]?.row, row)
})

test('a provider rate limit goes to a server only when the caller asks', () => {
  const row = {
    id: 'r',
    provider: 'github',
    repositoryUrl: 'https://github.com/TurboPanel/website.git',
    defaultBranch: 'trunk',
    subdirectory: null,
    connectionId: null,
    secretId: null,
  }
  const limited = { failure: 'API rate limit exceeded', status: 403 }
  assertEquals(providerAnswerStands(limited, { row }), true)
  assertEquals(providerAnswerStands(limited, { row, daemonOnRateLimit: true }), false)
  assertEquals(
    providerAnswerStands({ failure: 'Not Found', status: 404 }, { row, daemonOnRateLimit: true }),
    true
  )
  // No status (unreachable) or no read API: always a server.
  assertEquals(providerAnswerStands({ failure: 'fetch failed' }, { row }), false)
  assertEquals(providerAnswerStands({ unsupported: true }, { row }), false)
})

test('a deploy command records each native app series on its release row', () => {
  const api = {
    ...source(),
    composeServiceName: 'api',
    releaseId: 'rel-2',
  } as EnvironmentDeploySource
  const site = {
    ...source(),
    composeServiceName: 'blog',
    releaseId: 'rel-3',
  } as EnvironmentDeploySource
  const releases = contextReleasesFor(
    [source(), api, site],
    [{ composeServiceName: 'web', nodeVersion: '26' }, { composeServiceName: 'api' }]
  )
  assertEquals(
    releases?.map((row) => [row.composeServiceName, row.nodeVersion]),
    [
      ['web', '26'],
      ['api', '26'],
      // Not a native app: nothing to record.
      ['blog', undefined],
    ]
  )
})

test('a Deno app is never read for a Node series, and keeps its place among the apps', async () => {
  const { read, calls } = reader([file('package.json', packageJson('>=26.7.0'))])
  const deno: PreparedNativeAppService = {
    composeServiceName: 'api',
    serviceId: '00000000-0000-4000-8000-0000000000a2',
    listenPort: 18101,
    framework: 'auto',
    runtime: 'deno',
    denoVersion: '2',
  }
  const result = await withNativeAppNodeVersions(
    [deno, app()],
    [source(), { ...source(), composeServiceName: 'api' }],
    { mode: 'deploy', read, warnings: [], offered: OFFERED }
  )
  if ('kind' in result) throw new TypeError('expected apps')
  assertEquals(
    result.apps.map((entry) => [entry.composeServiceName, entry.nodeVersion]),
    [
      ['api', undefined],
      ['web', '26'],
    ]
  )
  // Only the Node app got a Node view, and only its repository was read.
  assertEquals(
    result.views.map((view) => view.composeServiceName),
    ['web']
  )
  assertEquals(calls.length, 1)
  // And no Node series is recorded for it on the release row.
  assertEquals(
    [
      ...recordedNodeVersions([
        { composeServiceName: 'api', runtime: 'deno' },
        { composeServiceName: 'web' },
      ]),
    ],
    [['web', '26']]
  )
})

test('volta.node comes after engines.node and before .nvmrc', () => {
  const paths = nodeVersionFilePaths(undefined)
  const volta = JSON.stringify({ volta: { node: '22.4.1' }, engines: { node: '>=22' } })
  assertEquals(
    nodeVersionFromFiles([file('package.json', volta), file('.nvmrc', '24')], paths, OFFERED),
    {
      series: '26',
      request: { requested: '>=22', path: 'package.json', source: 'package.json' },
    }
  )
  const voltaOnly = JSON.stringify({ volta: { node: '22.4.1' } })
  assertEquals(
    nodeVersionFromFiles([file('package.json', voltaOnly), file('.nvmrc', '24')], paths, OFFERED),
    { series: '22', request: { requested: '22.4.1', path: 'package.json', source: 'volta' } }
  )
})

test('.tool-versions is read last, from its nodejs line', () => {
  const paths = nodeVersionFilePaths(undefined)
  const tool = 'python 3.12.1\n# runtimes\nnodejs 24.1.0 22.9.0 # first wins\n'
  assertEquals(nodeVersionFromFiles([file('.tool-versions', tool)], paths, OFFERED), {
    series: '24',
    request: { requested: '24.1.0', path: '.tool-versions', source: '.tool-versions' },
  })
  assertEquals(
    nodeVersionFromFiles(
      [file('.tool-versions', 'nodejs lts\n'), file('.node-version', '22')],
      paths,
      OFFERED
    ),
    { series: '22', request: { requested: '22', path: '.node-version', source: '.node-version' } }
  )
  assertEquals(nodeVersionFromFiles([file('.tool-versions', 'ruby 3.3.0\n')], paths, OFFERED), null)
  assertEquals(
    nodeVersionFromFiles(
      [file('.tool-versions', 'nodejs 22.1.0\n'), file('.nvmrc', '24')],
      paths,
      OFFERED
    ),
    { series: '24', request: { requested: '24', path: '.nvmrc', source: '.nvmrc' } }
  )
})

test('ranges pick the highest offered series that satisfies them', () => {
  const paths = ['package.json']
  const pick = (range: string) =>
    nodeVersionFromFiles([file('package.json', packageJson(range))], paths, OFFERED)
  assertEquals((pick('^22') as { series: string }).series, '22')
  assertEquals((pick('>=22') as { series: string }).series, '26')
  assertEquals((pick('22 || 24') as { series: string }).series, '24')
  assertEquals((pick('>=22.5 <24') as { series: string }).series, '22')
  assertEquals('unsupported' in (pick('^18') as object), true)
})

test('latest is the deliberate follow-the-server choice and ignores the repository files', async () => {
  const { read, calls } = reader([file('package.json', packageJson('^22'))])
  const result = await withNativeAppNodeVersions([app('latest')], [source()], {
    mode: 'deploy',
    read,
    warnings: [],
    offered: OFFERED,
  })
  if ('kind' in result) throw new TypeError('expected apps')
  assertEquals(result.apps[0]?.nodeVersion, NEWEST_NATIVE_APP_NODE_SERIES)
  assertEquals(result.views[0]?.source, 'compose')
  assertEquals(calls, [])
})

test('the wizard suggestion names a matched hint, an unavailable one, or none', () => {
  const matched = nodeVersionSuggestion([file('.nvmrc', 'v22.11.0')], OFFERED)
  assertEquals(matched.hint, {
    source: '.nvmrc',
    requested: 'v22.11.0',
    path: '.nvmrc',
    status: 'matched',
    series: '22',
  })
  assertEquals(matched.newest, NEWEST_NATIVE_APP_NODE_SERIES)
  const unsupported = nodeVersionSuggestion([file('.nvmrc', '16')], OFFERED)
  assertEquals(unsupported.hint?.status, 'unsupported')
  assertEquals(unsupported.hint?.series, undefined)
  assertEquals(
    nodeVersionSuggestion([file('package.json', packageJson('nope'))], OFFERED).hint?.status,
    'invalid'
  )
  assertEquals(nodeVersionSuggestion([missing('.nvmrc')], OFFERED).hint, undefined)
})

test('latest never reaches the wire: every resolve path turns it into a concrete series', async () => {
  const { read } = reader([])
  const variants: Array<{
    mode: 'deploy' | 'preview'
    sources: EnvironmentDeploySource[]
    rollbackPins?: Record<string, { nodeVersion?: string }>
    expected: string
  }> = [
    { mode: 'deploy', sources: [source()], expected: NEWEST_NATIVE_APP_NODE_SERIES },
    { mode: 'preview', sources: [source()], expected: NEWEST_NATIVE_APP_NODE_SERIES },
    { mode: 'deploy', sources: [], expected: NEWEST_NATIVE_APP_NODE_SERIES },
    {
      mode: 'deploy',
      sources: [{ ...source(), rollbackToReleaseId: 'rel-0' } as EnvironmentDeploySource],
      rollbackPins: { web: { nodeVersion: '24' } },
      expected: '24',
    },
  ]
  for (const variant of variants) {
    const result = await resolveSourceNodeVersions([app('latest')], variant.sources, {
      mode: variant.mode,
      read,
      warnings: [],
      offered: OFFERED,
      ...(variant.rollbackPins ? { rollbackPins: variant.rollbackPins } : {}),
    })
    if ('kind' in result) throw new TypeError('expected apps')
    assertEquals(
      result.nodeVersions.apps.map((a) => a.nodeVersion),
      [variant.expected]
    )
  }
})
