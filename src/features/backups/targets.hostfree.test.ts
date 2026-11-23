import { assert, assertEquals, assertNotEquals } from '@std/assert'
import { endpointRefusal, ipv6Class } from './endpoint-guard.ts'
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

test('endpoint rules: loopback and link-local written as IPv6 are refused', () => {
  for (const bad of [
    '[::ffff:127.0.0.1]',
    '[::ffff:7f00:1]',
    '[::ffff:a9fe:a9fe]',
    '[::ffff:169.254.169.254]',
    '[0:0:0:0:0:ffff:7f00:1]',
    '[::127.0.0.1]',
    '[::7f00:1]',
    '[64:ff9b::7f00:1]',
    '[64:ff9b::a9fe:a9fe]',
    '[::ffff:0.0.0.0]',
  ]) {
    assertEquals(typeof endpointRefusal(`https://${bad}`), 'string', bad)
    assertEquals(typeof endpointRefusal(`http://${bad}`), 'string', bad)
  }
  assertEquals(endpointRefusal('https://[2001:db8::1]:9000'), null)
  assertEquals(endpointRefusal('https://[::ffff:8.8.8.8]'), null)
  assertEquals(endpointRefusal('http://[::ffff:10.0.0.5]:9000'), null)
  assertEquals(typeof endpointRefusal('http://[::ffff:8.8.8.8]'), 'string')
})

test('endpoint rules: an IPv6 literal that cannot be read is refused', () => {
  for (const host of [
    '[1::2::3]',
    '[1:2:3:4:5:6:7]',
    '[1:2:3:4:5:6:7:8:9]',
    '[1:2:3:4::5:6:7:8]',
    '[g::1]',
    '[::12345]',
    '[::ffff:300.1.1.1]',
  ]) {
    assertEquals(ipv6Class(host), 'loopback', host)
  }
})

test('endpoint rules: a dotted-quad tail is read as two groups', () => {
  assertEquals(ipv6Class('[::ffff:127.0.0.1]'), 'loopback')
  assertEquals(ipv6Class('[::ffff:10.1.2.3]'), 'private')
  assertEquals(ipv6Class('[::ffff:8.8.8.8]'), 'other')
  assertEquals(ipv6Class('[64:ff9b::192.168.1.1]'), 'private')
})

test('endpoint rules: all of fe80::/10 is link-local, and fec0:: is not', () => {
  for (const url of ['https://[fe80::1]', 'https://[fe9a::1]', 'https://[febf::1]']) {
    assertEquals(typeof endpointRefusal(url), 'string', url)
  }
  assertEquals(ipv6Class('[fec0::1]'), 'other')
  assertEquals(ipv6Class('[::]'), 'loopback')
  assertEquals(ipv6Class('[::1]'), 'loopback')
  assertEquals(ipv6Class('[fd00:ec2::254]'), 'loopback')
  assertEquals(ipv6Class('[fd12::1]'), 'private')
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
    destinationId: '00000000-0000-4000-8000-0000000000c1',
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
