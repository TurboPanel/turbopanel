import { assertEquals } from '@std/assert'
import {
  cacheView,
  memoryCeilingError,
  parseCacheCreateBody,
  parseCachePatchBody,
  parseDeleteData,
} from './routes-helpers.ts'
import {
  cacheRowFixture,
  deriveTestSecrets,
  PRINCIPAL_A,
} from '../../features/caches/fixtures.test.support.ts'

const test = Deno.test.bind(Deno)

test('create takes the defaults: socket, 64 MiB, REDIS', () => {
  assertEquals(parseCacheCreateBody({ name: 'app-cache', principalId: PRINCIPAL_A }), {
    name: 'app-cache',
    principalId: PRINCIPAL_A,
    access: 'socket',
    maxMemoryMb: 64,
    keyPrefix: 'REDIS',
  })
})

test('create refuses every bad field with its own code', () => {
  const code = (body: unknown) => {
    const parsed = parseCacheCreateBody(body)
    return 'error' in parsed ? parsed.error : 'ok'
  }
  const base = { name: 'app-cache', principalId: PRINCIPAL_A }
  assertEquals(code(null), 'invalid_request')
  assertEquals(code({ ...base, engine: 'redis' }), 'engine_unavailable')
  assertEquals(code({ ...base, version: '9.0' }), 'version_unavailable')
  assertEquals(code({ ...base, name: 'Bad' }), 'invalid_name')
  assertEquals(code({ ...base, principalId: 'x' }), 'invalid_principal')
  assertEquals(code({ ...base, access: 'tcp' }), 'invalid_access')
  assertEquals(code({ ...base, maxMemoryMb: 8 }), 'invalid_memory')
  assertEquals(code({ ...base, maxMemoryMb: 5000 }), 'invalid_memory')
  assertEquals(code({ ...base, keyPrefix: '1bad' }), 'invalid_prefix')
  assertEquals(
    code({
      ...base,
      engine: 'valkey',
      version: '8.1',
      access: 'port',
      maxMemoryMb: 16,
      keyPrefix: 'QUEUE',
    }),
    'ok'
  )
})

test('patch takes only what it names and refuses an empty change', () => {
  assertEquals(parseCachePatchBody({ maxMemoryMb: 128 }), { maxMemoryMb: 128 })
  assertEquals(parseCachePatchBody({ access: 'port', keyPrefix: 'Q' }), {
    access: 'port',
    keyPrefix: 'Q',
  })
  for (const bad of [
    {},
    null,
    { access: 'x' },
    { maxMemoryMb: 1 },
    { keyPrefix: '' },
    { engine: 'redis' },
  ]) {
    assertEquals('error' in parseCachePatchBody(bad), true)
  }
})

test('the data goes unless it is explicitly kept', () => {
  assertEquals(parseDeleteData(undefined), true)
  assertEquals(parseDeleteData('true'), true)
  assertEquals(parseDeleteData('false'), false)
  assertEquals(parseDeleteData('FALSE'), false)
  assertEquals(parseDeleteData('0'), false)
})

test('the unit ceiling must fit the account memory ceiling', () => {
  assertEquals(memoryCeilingError(64, undefined), null)
  assertEquals(memoryCeilingError(64, {}), null)
  assertEquals(memoryCeilingError(64, { memoryBytes: 160 * 1024 * 1024 }), null)
  const refused = memoryCeilingError(64, { memoryBytes: 100 * 1024 * 1024 })
  assertEquals(refused?.error, 'cache_memory_over_ceiling')
  assertEquals(refused?.status, 422)
  assertEquals(refused?.message.includes('34 MiB'), true)
})

test('the view never carries the password and lists the variable names', async () => {
  const secrets = await deriveTestSecrets()
  const row = await cacheRowFixture(secrets, {
    metadata: { runtimeVersion: '8.1.11', appliedAt: 'T', lastError: 'x' },
  })
  const view = cacheView(row)
  assertEquals(JSON.stringify(view).includes(row.password), false)
  assertEquals('password' in view, false)
  assertEquals(view.hostingAccount, 'siteowner')
  assertEquals(view.runtimeVersion, '8.1.11')
  assertEquals(view.variables.includes('REDIS_SOCKET'), true)
  assertEquals(cacheView({ ...row, metadata: null }).lastError, null)
})
