import { assert, assertEquals, assertNotEquals } from '@std/assert'
import { endpointRefusal } from './endpoint-guard.ts'
import { type BackupTargetRow, parseTargetBody, toApiTarget } from './targets.ts'
import {
  parseBackupCopyTarget,
  parseBackupTargetTestResult,
} from '../../contracts/commands/schemas.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const GOOD = {
  name: 'Offsite',
  endpoint: 'https://s3.example.com/',
  region: 'us-east-1',
  bucket: 'tp-backups',
  prefix: '/backups/db/',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'a-secret',
}

function row(over: Partial<BackupTargetRow> = {}): BackupTargetRow {
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    organizationId: '00000000-0000-4000-8000-0000000000a1',
    name: 'Offsite',
    kind: 's3',
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: 'tp-backups',
    prefix: '',
    isPathStyle: true,
    isServerSideEncrypted: false,
    accessKeyId: 'AKIAEXAMPLE',
    secretKeySealed: 'tpsecret.v1.sealed-value',
    lastTestedAt: null,
    isLastTestOk: null,
    lastTestError: null,
    createdBy: null,
    ...over,
  }
}

test('a good create body is normalized: trailing slashes cut, defaults filled', () => {
  const parsed = parseTargetBody(GOOD, 'create')
  assert(parsed.ok)
  assertEquals(parsed.value.endpoint, 'https://s3.example.com')
  assertEquals(parsed.value.prefix, 'backups/db')
  assertEquals(parsed.value.pathStyle, true)
  assertEquals(parsed.value.serverSideEncryption, false)
  assertEquals(parsed.value.secretAccessKey, 'a-secret')
})

test('create needs the secret key; update may leave it out and keeps the rest', () => {
  assertEquals(parseTargetBody({ ...GOOD, secretAccessKey: undefined }, 'create').ok, false)
  const parsed = parseTargetBody({ bucket: 'other-bucket' }, 'update', row())
  assert(parsed.ok)
  assertEquals(parsed.value.bucket, 'other-bucket')
  assertEquals(parsed.value.name, 'Offsite')
  assertEquals(parsed.value.secretAccessKey, undefined)
})

test('bad fields are refused with the field named and a plain reason', () => {
  for (const [override, field] of [
    [{ name: '' }, 'name'],
    [{ name: 'x'.repeat(65) }, 'name'],
    [{ endpoint: 'ftp://s3.example.com' }, 'endpoint'],
    [{ endpoint: 'https://127.0.0.1' }, 'endpoint'],
    [{ bucket: 'Bad_Bucket' }, 'bucket'],
    [{ region: 'us east' }, 'region'],
    [{ prefix: 'a/../b' }, 'prefix'],
    [{ accessKeyId: 'has space' }, 'accessKeyId'],
    [{ secretAccessKey: '' }, 'secretAccessKey'],
    [{ pathStyle: 'yes' }, 'pathStyle'],
  ] as const) {
    const parsed = parseTargetBody({ ...GOOD, ...override }, 'create')
    assert(!parsed.ok, field)
    assertEquals(parsed.field, field)
    assertNotEquals(parsed.detail, '')
  }
})

test('endpoint rules: https, or http on a private address; never loopback or metadata', () => {
  assertEquals(endpointRefusal('https://s3.example.com'), null)
  assertEquals(endpointRefusal('http://10.0.0.5:9000'), null)
  assertEquals(endpointRefusal('http://[fd12::1]'), null)
  for (const bad of [
    'http://s3.example.com',
    'http://8.8.8.8',
    'https://localhost',
    'https://127.0.0.1',
    'https://169.254.169.254',
    'https://metadata.google.internal',
    'https://[::1]',
    'https://user:pw@s3.example.com',
    'https://s3.example.com/bucket',
    'nonsense',
  ]) {
    assertEquals(typeof endpointRefusal(bad), 'string', bad)
  }
})

test('the API shape never carries the secret key', () => {
  const api = toApiTarget(row())
  assertEquals(api.hasSecret, true)
  const text = JSON.stringify(api)
  assert(!text.includes('tpsecret'))
  assert(!text.includes('sealed-value'))
  assert(!('secretKeySealed' in api) && !('secretAccessKey' in api))
})

test('the wire shape the host receives parses, and a malformed one does not', () => {
  const wire = {
    targetId: '00000000-0000-4000-8000-0000000000c1',
    name: 'Offsite',
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: 'tp-backups',
    prefix: 'a/b',
    pathStyle: true,
    serverSideEncryption: false,
    accessKeyId: 'AKIAEXAMPLE',
    secretKeyEnvelope: 'tpdaemon.v1.x',
  }
  assertEquals(parseBackupCopyTarget(wire).bucket, 'tp-backups')
  for (const bad of [
    { ...wire, bucket: 'UPPER' },
    { ...wire, prefix: '/a' },
    { ...wire, secretKeyEnvelope: '' },
  ]) {
    let threw = false
    try {
      parseBackupCopyTarget(bad)
    } catch {
      threw = true
    }
    assert(threw)
  }
})

test('a test result is read leniently and bounded', () => {
  assertEquals(parseBackupTargetTestResult(null).ok, false)
  const r = parseBackupTargetTestResult({
    ok: false,
    steps: [
      { step: 'write', ok: false, error: 'x'.repeat(1000) },
      { step: 'nope', ok: true },
    ],
    error: 'write failed',
  })
  assertEquals(r.steps.length, 1)
  assertEquals(r.steps[0]!.error!.length, 300)
})
