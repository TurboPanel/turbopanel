import { assertEquals, assertStringIncludes } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { resolveMergedCompose } from '../../features/schedule/plan-deploy.ts'
import type { ProjectComposeSource } from '../../features/projects/project-options.ts'
import { composeSourceDigest } from '../../features/projects/project-options.ts'
import {
  readTrackedComposeBase,
  resolveDeployProjectOptions,
  type TrackedFileReader,
} from './deploy-tracked-base.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SOURCE_ID = '00000000-0000-4000-8000-000000000001'
const COMMIT_A = 'a'.repeat(40)
const COMMIT_B = 'b'.repeat(40)
const SOURCE: ProjectComposeSource = {
  sourceId: SOURCE_ID,
  path: 'deploy/compose.yaml',
  ref: 'main',
  seededCommitSha: COMMIT_A,
  seededDigest: '0'.repeat(64),
  mode: 'track',
}

function readerOf(commitSha: string, content: string | null): TrackedFileReader {
  return () =>
    Promise.resolve({
      ok: true as const,
      commitSha,
      file:
        content === null
          ? { path: SOURCE.path, found: false as const, reason: 'not_found' as const }
          : { path: SOURCE.path, found: true as const, content, bytes: content.length },
    })
}

const V1 = 'services:\n  web:\n    image: nginx:1\n'
const V2 = 'services:\n  web:\n    image: nginx:2\n'

test('a tracked read returns the file as the Base with the commit and content hash', async () => {
  const result = await readTrackedComposeBase(SOURCE, 'main', undefined, readerOf(COMMIT_A, V1))
  if (!result.ok) throw new Error('expected a read')
  assertEquals(result.record, {
    sourceId: SOURCE_ID,
    ref: 'main',
    path: 'deploy/compose.yaml',
    commitSha: COMMIT_A,
    digest: await composeSourceDigest(V1),
  })
  assertEquals(
    (result.document.data.services as Record<string, { image: string }>).web.image,
    'nginx:1'
  )
})

test('a changed file at a later commit gives a changed Base and a different hash', async () => {
  const first = await readTrackedComposeBase(SOURCE, 'main', undefined, readerOf(COMMIT_A, V1))
  const second = await readTrackedComposeBase(SOURCE, 'main', undefined, readerOf(COMMIT_B, V2))
  if (!first.ok || !second.ok) throw new Error('expected reads')
  assertEquals(second.record.commitSha, COMMIT_B)
  assertEquals(first.record.digest === second.record.digest, false)
  assertEquals(
    (second.document.data.services as Record<string, { image: string }>).web.image,
    'nginx:2'
  )
})

test('the read is made at the commit a trigger already resolved', async () => {
  const asked: string[] = []
  const reader: TrackedFileReader = (ref) => {
    asked.push(ref)
    return readerOf(COMMIT_B, V2)(ref)
  }
  await readTrackedComposeBase(SOURCE, 'main', COMMIT_B, reader)
  await readTrackedComposeBase(SOURCE, 'main', undefined, reader)
  assertEquals(asked, [COMMIT_B, 'main'])
})

test('a missing file fails naming the file and the commit', async () => {
  const result = await readTrackedComposeBase(SOURCE, 'main', undefined, readerOf(COMMIT_A, null))
  if (result.ok) throw new Error('expected a failure')
  assertEquals(result.error.code, 'compose_file_missing')
  assertEquals(result.error.commitSha, COMMIT_A)
  assertStringIncludes(result.error.message, 'deploy/compose.yaml')
  assertStringIncludes(result.error.message, COMMIT_A.slice(0, 12))
})

test('a file that is not a compose document fails naming the file and the commit', async () => {
  const result = await readTrackedComposeBase(
    SOURCE,
    'main',
    undefined,
    readerOf(COMMIT_A, 'services: [unclosed')
  )
  if (result.ok) throw new Error('expected a failure')
  assertEquals(result.error.code, 'compose_file_unparseable')
  assertStringIncludes(result.error.message, 'deploy/compose.yaml')
  assertStringIncludes(result.error.message, COMMIT_A.slice(0, 12))
})

test('a repository that cannot be read fails without falling back', async () => {
  const result = await readTrackedComposeBase(SOURCE, 'main', undefined, () =>
    Promise.resolve({ ok: false as const, message: 'timed out' })
  )
  if (result.ok) throw new Error('expected a failure')
  assertEquals(result.error.code, 'compose_source_unavailable')
  assertStringIncludes(result.error.message, 'timed out')
})

test('the environment layer merges on top of the tracked Base', async () => {
  const read = await readTrackedComposeBase(SOURCE, 'main', undefined, readerOf(COMMIT_A, V1))
  if (!read.ok) throw new Error('expected a read')
  const merged = resolveMergedCompose(
    { compose: read.document },
    {
      compose: {
        version: 1,
        data: { services: { web: { environment: { MODE: 'prod' } } } },
        presentation: { keyOrder: ['services'], comments: {} },
      },
    },
    'docker-compose.environment.yml'
  )
  if ('kind' in merged) throw new Error('expected a merge')
  const web = (merged.data.services as Record<string, Record<string, unknown>>).web
  assertEquals(web.image, 'nginx:1')
  assertEquals(web.environment, { MODE: 'prod' })
})

test('a project that does not follow a file, a rollback and a hostings-only run read nothing', async () => {
  const c = { get: () => undefined } as unknown as Context<AppEnv>
  const db = {} as unknown as Db
  const base = {
    organizationId: '00000000-0000-4000-8000-0000000000aa',
    projectId: '00000000-0000-4000-8000-0000000000bb',
    mode: 'deploy' as const,
  }
  const untouched = { compose: { version: 1, data: {}, presentation: {} } }
  const seeded = { ...untouched, composeSource: { ...SOURCE, mode: 'seed' } }
  assertEquals(await resolveDeployProjectOptions(c, db, { ...base, projectOptions: seeded }), {
    ok: true,
    options: seeded,
    base: null,
  })
  const tracked = {
    ...untouched,
    composeSource: { ...SOURCE, lastReadCommitSha: COMMIT_A, lastReadDigest: '1'.repeat(64) },
  }
  const stored = await resolveDeployProjectOptions(c, db, {
    ...base,
    projectOptions: tracked,
    skipRead: true,
  })
  assertEquals(stored, {
    ok: true,
    options: tracked,
    base: {
      sourceId: SOURCE_ID,
      ref: 'main',
      path: 'deploy/compose.yaml',
      commitSha: COMMIT_A,
      digest: '1'.repeat(64),
    },
  })
})
