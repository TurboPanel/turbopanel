import { assertEquals, assertThrows } from '@std/assert'
import {
  parseCacheApplyPayload,
  parseCacheApplyResult,
  parseCommandPayload,
  parseCommandResult,
  parseEnvironmentDeployPayload,
  parseEnvironmentDeployResult,
} from './schemas.ts'

const test = Deno.test.bind(Deno)

const ID_A = '00000000-0000-4000-8000-00000000ca01'
const ID_B = '00000000-0000-4000-8000-00000000ca02'

const socketCache = {
  id: ID_A,
  name: 'app-cache',
  username: 'siteowner',
  engine: 'valkey',
  version: '8.1',
  access: 'socket',
  maxMemoryMb: 64,
  passwordSha256: 'a'.repeat(64),
}
const portCache = { ...socketCache, id: ID_B, name: 'app-queue', access: 'port', port: 18200 }

const DEPLOY = {
  environmentId: 'env-1',
  projectId: 'proj-1',
  organizationId: 'org-1',
  projectName: 'tp-demo',
  composeFiles: [{ filename: 'compose.yaml', role: 'runtime', content: 'services: {}\n' }],
  hostings: [],
}

test('absent stays absent, empty stays empty, a list is kept (deploy)', () => {
  const absent = parseEnvironmentDeployPayload(DEPLOY)
  assertEquals('caches' in absent, false)
  assertEquals('helperReach' in absent, false)
  const empty = parseEnvironmentDeployPayload({ ...DEPLOY, caches: [], helperReach: [] })
  assertEquals(empty.caches, [])
  assertEquals(empty.helperReach, [])
  const listed = parseEnvironmentDeployPayload({
    ...DEPLOY,
    caches: [socketCache, portCache],
    helperReach: [
      { composeServiceName: 'search', containerPort: 7700, hostPort: 18101, username: 'siteowner' },
    ],
  })
  assertEquals(listed.caches?.length, 2)
  assertEquals(listed.helperReach?.[0]?.hostPort, 18101)
})

test('cache entries outside the wire rules are refused', () => {
  const refuse = (cache: Record<string, unknown>) =>
    assertThrows(() => parseEnvironmentDeployPayload({ ...DEPLOY, caches: [cache] }), TypeError)
  refuse({ ...socketCache, engine: 'redis' })
  refuse({ ...socketCache, version: '9.0' })
  refuse({ ...socketCache, access: 'tcp' })
  refuse({ ...socketCache, port: 18200 })
  refuse({ ...portCache, port: undefined })
  refuse({ ...portCache, port: 17999 })
  refuse({ ...portCache, port: 19000 })
  refuse({ ...socketCache, maxMemoryMb: 8 })
  refuse({ ...socketCache, maxMemoryMb: 70000 })
  refuse({ ...socketCache, maxMemoryMb: 64.5 })
  refuse({ ...socketCache, passwordSha256: 'A'.repeat(64) })
  refuse({ ...socketCache, id: 'not-a-uuid' })
  refuse({ ...socketCache, name: 'Bad Name' })
  refuse({ ...socketCache, username: 'bad name' })
  refuse('nope' as unknown as Record<string, unknown>)
})

test('duplicate ids, names and ports, and too many caches, are refused', () => {
  assertThrows(
    () => parseEnvironmentDeployPayload({ ...DEPLOY, caches: [socketCache, socketCache] }),
    TypeError,
    'twice'
  )
  assertThrows(
    () =>
      parseEnvironmentDeployPayload({
        ...DEPLOY,
        caches: [
          { ...portCache, id: ID_A },
          { ...portCache, name: 'other' },
        ],
      }),
    TypeError,
    'twice'
  )
  const many = Array.from({ length: 17 }, (_, i) => ({
    ...socketCache,
    id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
    name: `c${i}`,
  }))
  assertThrows(() => parseEnvironmentDeployPayload({ ...DEPLOY, caches: many }), TypeError)
  assertThrows(() => parseEnvironmentDeployPayload({ ...DEPLOY, caches: 'x' }), TypeError)
})

test('helper reach entries are checked', () => {
  const entry = {
    composeServiceName: 'search',
    containerPort: 7700,
    hostPort: 18101,
    username: 'u',
  }
  const refuse = (helperReach: unknown) =>
    assertThrows(() => parseEnvironmentDeployPayload({ ...DEPLOY, helperReach }), TypeError)
  refuse('x')
  refuse([{ ...entry, composeServiceName: '..' }])
  refuse([{ ...entry, composeServiceName: 'a b' }])
  refuse([{ ...entry, containerPort: 0 }])
  refuse([{ ...entry, hostPort: 80 }])
  refuse([{ ...entry, username: 'bad name' }])
  refuse([entry, { ...entry, hostPort: 18102 }])
  refuse([entry, { ...entry, composeServiceName: 'other' }])
  refuse(
    Array.from({ length: 33 }, (_, i) => ({
      ...entry,
      composeServiceName: `s${i}`,
      hostPort: 18200 + i,
    }))
  )
})

test('cache.apply payload: an empty set is valid, a missing set is not, a removal cannot also be listed', () => {
  assertEquals(parseCacheApplyPayload({ environmentId: 'env-1', caches: [] }).caches, [])
  assertThrows(() => parseCacheApplyPayload({ environmentId: 'env-1' }), TypeError)
  assertThrows(() => parseCacheApplyPayload(null), TypeError)
  assertThrows(() => parseCacheApplyPayload({ caches: [] }), TypeError)
  const removed = [{ id: ID_B, username: 'siteowner', deleteData: true }]
  assertEquals(
    parseCacheApplyPayload({ environmentId: 'env-1', caches: [socketCache], removed }).removed,
    removed
  )
  assertThrows(
    () =>
      parseCacheApplyPayload({
        environmentId: 'env-1',
        caches: [portCache],
        removed,
      }),
    TypeError,
    'also lists'
  )
  for (const bad of [
    [{ id: ID_B, username: 'u' }],
    [{ id: 'x', username: 'u', deleteData: true }],
    [removed[0], removed[0]],
    'x',
  ]) {
    assertThrows(
      () => parseCacheApplyPayload({ environmentId: 'env-1', caches: [], removed: bad }),
      TypeError
    )
  }
})

test('cache.apply is a registered command with its own parsers', () => {
  assertEquals(parseCommandPayload('cache.apply', { environmentId: 'env-1', caches: [] }), {
    environmentId: 'env-1',
    caches: [],
  })
  assertEquals(
    parseCommandResult('cache.apply', {
      caches: [{ id: ID_A, state: 'ready', runtimeVersion: '8.1.11' }],
    }),
    { caches: [{ id: ID_A, state: 'ready', runtimeVersion: '8.1.11' }] }
  )
})

test('results are read leniently: bad entries dropped, long text cut', () => {
  assertThrows(() => parseCacheApplyResult(null), TypeError)
  assertThrows(() => parseCacheApplyResult({}), TypeError)
  const result = parseCacheApplyResult({
    caches: [
      { id: ID_A, state: 'failed', error: 'x'.repeat(900) },
      { id: 'bad', state: 'ready' },
      { id: ID_B, state: 'odd' },
      7,
    ],
  })
  assertEquals(result.caches.length, 1)
  assertEquals(result.caches[0]?.error?.length, 500)
  const deploy = parseEnvironmentDeployResult({
    projectName: 'p',
    caches: [{ id: ID_A, state: 'pending', error: 'starts with the next deploy' }],
  })
  assertEquals(deploy.caches?.[0]?.state, 'pending')
  assertEquals('caches' in parseEnvironmentDeployResult({ projectName: 'p', caches: [] }), false)
})
