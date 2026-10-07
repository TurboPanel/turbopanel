/**
 * Host-free tests: what a binding emits for each kind of consuming service, and
 * how the host-run form is chosen, kept and refused.
 */

import { assertEquals } from '@std/assert'
import { bindingPrefixedKeys } from '../../lib/naming.ts'
import {
  bindingRequiredKeys,
  deliveryByServiceId,
  HOST_SITE_PROXY_PORT,
  hostRunDeliveryByComposeName,
  hostSiteBindingRefusal,
  inferStoredDelivery,
} from './host-run.ts'
import {
  computeBindingVariableSet,
  type DesiredBindingVariable,
  listBindingEmittedKeys,
  resolveBindingDelivery,
} from './materialize.ts'
import type { Db } from '../../db/connection.ts'

/** Sonar only recognizes `test()`; see `materialize.test.ts`. */
const test = Deno.test.bind(Deno)

const PEM = '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----'
const base = {
  keyPrefix: 'DATABASE',
  emitEngineDefaults: false,
  databaseName: 'wordpress',
  username: 'wp',
  password: 's3cret',
  host: 'abc-in',
  port: 13306,
  caCertPem: PEM,
  readSplit: false,
  engineCode: 'mysql',
  sslMode: 'verify-ca',
} as const

function render(extra: Partial<Parameters<typeof computeBindingVariableSet>[0]> = {}) {
  const result = computeBindingVariableSet({ ...base, ...extra })
  if ('kind' in result) throw new TypeError(result.kind)
  return new Map(result.map((row) => [row.key, row]))
}

const keys = bindingPrefixedKeys('DATABASE')

test('a container service keeps its container name and the CA as text, unchanged', () => {
  const omitted = render()
  const explicit = render({ delivery: 'container' })
  assertEquals([...explicit], [...omitted])
  assertEquals(omitted.get(keys.host)?.value, 'abc-in')
  assertEquals(omitted.get(keys.caCert)?.value, PEM)
  assertEquals(omitted.has(keys.caFile), false)
  assertEquals(omitted.get(keys.url)?.value.includes('abc-in:13306'), true)
})

test('a PHP site dials loopback and gets no multi-line value at all', () => {
  const rows = render({ delivery: 'host-site', emitEngineDefaults: true })
  assertEquals(rows.get(keys.host)?.value, '127.0.0.1')
  assertEquals(rows.get(keys.port)?.value, '13306')
  assertEquals(rows.get('MYSQL_HOST')?.value, '127.0.0.1')
  assertEquals(rows.has(keys.caCert), false)
  assertEquals(rows.has(keys.caFile), false)
  assertEquals(rows.get(keys.url)?.value.includes('127.0.0.1:13306'), true)
  assertEquals(rows.get(keys.url)?.value.includes('abc-in'), false)
  for (const row of rows.values()) assertEquals(row.value.includes('\n'), false)
})

test('a native Node app dials loopback and keeps the CA as text', () => {
  const rows = render({ delivery: 'host-node' })
  assertEquals(rows.get(keys.host)?.value, '127.0.0.1')
  assertEquals(rows.get(keys.caCert)?.value, PEM)
  assertEquals(rows.get(keys.caCert)?.isSecret, true)
})

test('every host-run row still carries the full connection set', () => {
  const rows = render({ delivery: 'host-site' })
  const names = [keys.url, keys.host, keys.port, keys.database, keys.user, keys.password]
  for (const name of names) assertEquals(rows.has(name), true, name)
  assertEquals(rows.get(keys.password)?.isSecret, true)
})

test('compose kinds map to a delivery, everything else is a container', () => {
  const byName = hostRunDeliveryByComposeName({
    services: {
      wp: { 'x-turbopanel': { serviceKind: 'site' } },
      api: { 'x-turbopanel': { serviceKind: 'node' } },
      cache: { image: 'redis' },
      plain: { 'x-turbopanel': { serviceKind: 'container' } },
    },
  })
  assertEquals(byName.get('wp'), 'host-site')
  assertEquals(byName.get('api'), 'host-node')
  assertEquals(byName.has('cache'), false)
  assertEquals(byName.has('plain'), false)
  const rows = [
    { id: 'a', composeServiceName: 'wp' },
    { id: 'b', composeServiceName: 'cache' },
  ]
  assertEquals(
    [...deliveryByServiceId(byName, rows)],
    [
      ['a', 'host-site'],
      ['b', 'container'],
    ]
  )
  assertEquals(hostRunDeliveryByComposeName({}).size, 0)
})

function stored(delivery: 'container' | 'host-site' | 'host-node') {
  const rows = render({ delivery })
  return [...rows.values()].map((row: DesiredBindingVariable) => row)
}

test('a re-materialize that is not a deploy keeps the stored form', () => {
  assertEquals(inferStoredDelivery(stored('container'), 'DATABASE'), 'container')
  assertEquals(inferStoredDelivery(stored('host-site'), 'DATABASE'), 'host-site')
  assertEquals(inferStoredDelivery(stored('host-node'), 'DATABASE'), 'host-node')
  assertEquals(inferStoredDelivery([], 'DATABASE'), 'container')
})

test('a PHP site is refused any database listener but the default MySQL one', () => {
  assertEquals(hostSiteBindingRefusal(HOST_SITE_PROXY_PORT), null)
  const refusal = hostSiteBindingRefusal(15432) ?? ''
  assertEquals(refusal.includes('15432'), true)
  assertEquals(refusal.includes('13306'), true)
})

test('required keys name the connection set, plus the engine defaults when emitted', () => {
  assertEquals(
    bindingRequiredKeys({ keyPrefix: 'DB', emitEngineDefaults: false, engineCode: 'mysql' }),
    ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']
  )
  const withDefaults = bindingRequiredKeys({
    keyPrefix: 'DB',
    emitEngineDefaults: true,
    engineCode: 'mysql',
  })
  assertEquals(withDefaults.includes('MYSQL_HOST'), true)
  assertEquals(withDefaults.length, 10)
})

test('the advertised binding keys do not grow: the CA file path is set by the daemon', () => {
  const emitted = listBindingEmittedKeys({
    keyPrefix: 'DATABASE',
    emitEngineDefaults: false,
    engineCode: 'mysql',
  })
  assertEquals(emitted?.includes('DATABASE_CA_FILE'), false)
  assertEquals(emitted?.includes('DATABASE_CA_CERT'), true)
  assertEquals(emitted?.length, 8)
})

/** A `Db` whose one select returns the binding's stored variable rows. */
function dbWithStoredRows(rows: DesiredBindingVariable[]): Db {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  } as unknown as Db
}

const target = { bindingId: 'b1', keyPrefix: 'DATABASE', listenerPort: 13306 }

test('a deploy decides the form; any other re-materialize keeps the stored one', async () => {
  const noRows = dbWithStoredRows([])
  assertEquals(await resolveBindingDelivery(noRows, target, 'host-node'), 'host-node')
  assertEquals(await resolveBindingDelivery(noRows, target, undefined), 'container')
  const hostSiteRows = dbWithStoredRows(stored('host-site'))
  assertEquals(await resolveBindingDelivery(hostSiteRows, target, undefined), 'host-site')
  // The document now says container: the deploy wins over what was stored.
  assertEquals(await resolveBindingDelivery(hostSiteRows, target, 'container'), 'container')
})

test('a PHP site on another listener port is refused, a native app or container is not', async () => {
  const db = dbWithStoredRows([])
  const odd = { ...target, listenerPort: 15432 }
  const refused = await resolveBindingDelivery(db, odd, 'host-site')
  assertEquals(typeof refused === 'object' && refused.kind, 'binding_host_site_unsupported')
  assertEquals(await resolveBindingDelivery(db, odd, 'host-node'), 'host-node')
  assertEquals(await resolveBindingDelivery(db, odd, 'container'), 'container')
})
