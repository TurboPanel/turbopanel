/**
 * Host-free coverage for the rule that a site may not use a panel hostname.
 */

import { assertEquals } from '@std/assert'
import { hostname, instanceHostname, setting } from '../../db/schema.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import { normalizeHostForCompare } from '../../lib/hostname-compare.ts'
import { panelHostnameInUseMessage, panelHostnameRefusal } from './panel-hostname-guard.ts'
import { panelHostsUsedBySites } from '../install/instance-hostnames.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function panelRow(host: string, index: number) {
  return {
    id: `panel-${index}`,
    host,
    source: 'platform-ca',
    uploadedCertId: null,
    acmeLastAttemptAt: null,
    acmeLastError: null,
    notAfter: null,
    createdAt: new Date(index).toISOString(),
    updatedAt: new Date(index).toISOString(),
  }
}

function dbWith(panelHosts: string[], siteHosts: string[] = []) {
  return createMemoryDb([
    [instanceHostname, panelHosts.map(panelRow)],
    [setting, []],
    [hostname, siteHosts.map((host, i) => ({ id: `site-${i}`, hostname: host }))],
  ])
}

test('normalizeHostForCompare folds case, port, trailing dot and international names', () => {
  assertEquals(normalizeHostForCompare('Canary.Example.Test.'), 'canary.example.test')
  assertEquals(normalizeHostForCompare('canary.example.test:8443'), 'canary.example.test')
  assertEquals(normalizeHostForCompare('https://canary.example.test:8443'), 'canary.example.test')
  assertEquals(normalizeHostForCompare('bücher.example.test'), 'xn--bcher-kva.example.test')
  assertEquals(normalizeHostForCompare('*.Example.Test.'), '*.example.test')
  assertEquals(normalizeHostForCompare('2001:DB8::1'), normalizeHostForCompare('[2001:db8::1]'))
  assertEquals(
    normalizeHostForCompare('[2001:db8::1]:8443'),
    normalizeHostForCompare('2001:db8::1')
  )
})

test('panelHostnameRefusal catches the exact panel name in any spelling, and the www name a choice adds', async () => {
  const db = dbWith(['canary.example.test:8443'])
  for (const typed of ['canary.example.test', 'CANARY.example.test', 'canary.example.test.']) {
    const refusal = await panelHostnameRefusal(db, 'web', { hostnames: [typed], www: 'off' })
    assertEquals(refusal, {
      kind: 'hosting_hostname_is_panel',
      composeServiceName: 'web',
      hostname: typed,
    })
  }
  const viaWww = await panelHostnameRefusal(db, 'web', { hostnames: ['example.test'], www: 'both' })
  assertEquals(viaWww, null)
  const db2 = dbWith(['www.example.test'])
  const www = await panelHostnameRefusal(db2, 'web', { hostnames: ['example.test'], www: 'both' })
  assertEquals(www?.hostname, 'www.example.test')
})

test('panelHostnameRefusal lets other names and a covering wildcard through', async () => {
  const db = dbWith(['canary.example.test'])
  assertEquals(
    await panelHostnameRefusal(db, 'web', { hostnames: ['shop.example.test'], www: 'off' }),
    null
  )
  assertEquals(
    await panelHostnameRefusal(db, 'web', { hostnames: ['*.example.test'], www: 'off' }),
    null
  )
  assertEquals(
    await panelHostnameRefusal(dbWith([]), 'web', {
      hostnames: ['canary.example.test'],
      www: 'off',
    }),
    null
  )
})

test('panelHostsUsedBySites reports a new panel name a site already uses, in any spelling', async () => {
  const db = dbWith([], ['shop.example.test', '*.wild.example.test'])
  assertEquals(await panelHostsUsedBySites(db, ['Shop.Example.Test.']), ['Shop.Example.Test.'])
  assertEquals(await panelHostsUsedBySites(db, ['shop.example.test:8443']), [
    'shop.example.test:8443',
  ])
  // A wildcard site name never blocks an exact panel name.
  assertEquals(await panelHostsUsedBySites(db, ['a.wild.example.test']), [])
  // A name the panel already publishes is not re-checked.
  assertEquals(await panelHostsUsedBySites(db, ['shop.example.test'], ['shop.example.test']), [])
})

test('the refusal message is plain', () => {
  assertEquals(
    panelHostnameInUseMessage('canary.example.test'),
    'canary.example.test is used by the control panel itself and cannot be used by a site'
  )
})
