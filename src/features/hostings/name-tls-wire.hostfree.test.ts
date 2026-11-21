/**
 * Host-free coverage for the per-name certificate plan a deploy sends.
 */

import { assertEquals } from '@std/assert'
import {
  isUniform,
  NAME_CERTIFICATES_NEED_UPDATE,
  nameTlsPinIds,
  planNameTls,
  planNameTlsForServer,
  type NameWire,
} from './name-tls-wire.ts'
import { DAEMON_WIRE_FEATURES } from '../../lib/version-wire.ts'

/** Jest/Mocha-shaped alias for {@link Deno.test} (Sonar only sees `test()`). */
const test = Deno.test.bind(Deno)

const SELF = { tlsId: null }
const ACME = { tlsId: null, tlsMode: 'acme' as const }
const pin = (tlsId: string) => ({ tlsId })

function name(hostname: string, value: NameWire['value'], typed = true): NameWire {
  return { hostname, typed, value }
}

test('names with one value are uniform and add no entries', () => {
  const names = [name('a.example.net', pin('t1')), name('www.a.example.net', pin('t1'), false)]
  assertEquals(isUniform(names), true)
  assertEquals(planNameTls(names), { row: pin('t1'), nameTls: [] })
})

test('the most common value goes on the row and only the others get entries', () => {
  const plan = planNameTls([
    name('a.example.net', pin('t1')),
    name('b.example.net', pin('t1')),
    name('c.example.net', SELF),
  ])
  assertEquals(plan.row, pin('t1'))
  assertEquals(plan.nameTls, [{ hostname: 'c.example.net', tlsMode: 'internal' }])
})

test('a tie goes to the value that comes first in names order', () => {
  const plan = planNameTls([name('a.example.net', ACME), name('b.example.net', pin('t2'))])
  assertEquals(plan.row, ACME)
  assertEquals(plan.nameTls, [{ hostname: 'b.example.net', tlsId: 't2' }])
})

test('an acme entry carries the mode and no pin', () => {
  const plan = planNameTls([
    name('a.example.net', pin('t1')),
    name('b.example.net', pin('t1')),
    name('c.example.net', ACME),
  ])
  assertEquals(plan.nameTls, [{ hostname: 'c.example.net', tlsMode: 'acme' }])
})

const ROOT_TO_WWW = new Map([['a.example.net', 'www.a.example.net']])
const WWW_TO_ROOT = new Map([['www.a.example.net', 'a.example.net']])

test('both: each name keeps its own value and is never compared with its partner', () => {
  const plan = planNameTls([
    name('a.example.net', pin('t1')),
    name('www.a.example.net', SELF, false),
    name('b.example.net', pin('t1')),
    name('www.b.example.net', pin('t1'), false),
  ])
  assertEquals(plan.row, pin('t1'))
  assertEquals(plan.nameTls, [{ hostname: 'www.a.example.net', tlsMode: 'internal' }])
})

test('both: a typed name and its www name that both differ from the row each get an entry', () => {
  const plan = planNameTls([
    name('a.example.net', pin('t1')),
    name('b.example.net', pin('t1')),
    name('c.example.net', SELF),
    name('www.c.example.net', SELF, false),
  ])
  assertEquals(plan.nameTls, [
    { hostname: 'c.example.net', tlsMode: 'internal' },
    { hostname: 'www.c.example.net', tlsMode: 'internal' },
  ])
})

test('www-to-root: the redirect-only www name has its own certificate', () => {
  const plan = planNameTls(
    [
      name('a.example.net', pin('t1')),
      name('www.a.example.net', SELF, false),
      name('b.example.net', pin('t1')),
    ],
    { redirects: WWW_TO_ROOT }
  )
  assertEquals(plan.row, pin('t1'))
  assertEquals(plan.nameTls, [{ hostname: 'www.a.example.net', tlsMode: 'internal' }])
})

test('root-to-www: the redirect-only bare name has its own certificate', () => {
  const plan = planNameTls(
    [
      name('www.a.example.net', pin('t1')),
      name('a.example.net', SELF, false),
      name('www.b.example.net', pin('t1')),
    ],
    { redirects: ROOT_TO_WWW }
  )
  assertEquals(plan.nameTls, [{ hostname: 'a.example.net', tlsMode: 'internal' }])
})

test('a redirect name that matches the row still gets an entry when its target has a different one', () => {
  const plan = planNameTls(
    [
      name('a.example.net', SELF),
      name('www.a.example.net', pin('t1'), false),
      name('b.example.net', pin('t1')),
      name('c.example.net', pin('t1')),
    ],
    { redirects: WWW_TO_ROOT }
  )
  assertEquals(plan.nameTls, [
    { hostname: 'a.example.net', tlsMode: 'internal' },
    { hostname: 'www.a.example.net', tlsId: 't1' },
  ])
})

test('names that all match the row add nothing in any www mode', () => {
  const all = [name('a.example.net', pin('t1')), name('www.a.example.net', pin('t1'), false)]
  for (const redirects of [undefined, WWW_TO_ROOT, ROOT_TO_WWW]) {
    assertEquals(planNameTls(all, { redirects }), { row: pin('t1'), nameTls: [] })
  }
})

test('the row never asks for acme when the caller says a tunnel name is closed', () => {
  const plan = planNameTls([name('a.example.net', ACME), name('b.example.net', SELF)], {
    avoidAcmeAtRow: true,
  })
  assertEquals(plan.row, SELF)
  assertEquals(plan.nameTls, [{ hostname: 'a.example.net', tlsMode: 'acme' }])
})

test('pins in entries are listed for the sealed material', () => {
  assertEquals(
    nameTlsPinIds([
      { hostname: 'a.example.net', tlsId: 't1' },
      { hostname: 'b.example.net', tlsMode: 'internal' },
    ]),
    ['t1']
  )
  assertEquals(nameTlsPinIds(undefined), [])
})

const MIXED = [
  name('a.example.net', pin('t1')),
  name('b.example.net', pin('t1')),
  name('c.example.net', SELF),
]

test('names that share a value send no entries, with or without the daemon feature', () => {
  const same = [name('a.example.net', pin('t1')), name('www.a.example.net', pin('t1'), false)]
  for (const serverTakesNameTls of [true, false]) {
    assertEquals(planNameTlsForServer(same, { serverTakesNameTls }), {
      ok: true,
      plan: { row: pin('t1'), nameTls: [] },
    })
  }
})

test('mixed names on a daemon with the feature send the common value plus entries', () => {
  assertEquals(planNameTlsForServer(MIXED, { serverTakesNameTls: true }), {
    ok: true,
    plan: { row: pin('t1'), nameTls: [{ hostname: 'c.example.net', tlsMode: 'internal' }] },
  })
})

test('mixed names on a daemon without the feature are refused, never sent as one certificate', () => {
  const result = planNameTlsForServer(MIXED, { serverTakesNameTls: false })
  assertEquals(result.ok, false)
  if (!result.ok) {
    assertEquals(result.error, NAME_CERTIFICATES_NEED_UPDATE)
    assertEquals(
      result.message,
      "This server's agent is too old to give names in one row different certificates. Update it, or give them the same certificate."
    )
  }
})

test('the shipped feature list names the per-name certificate feature', () => {
  assertEquals((DAEMON_WIRE_FEATURES as readonly string[]).includes('hosting-name-tls-v1'), true)
})

test('no per-name entry carries an ACME challenge, and the preparer never sets one', async () => {
  // Per-name entries are not orders: the DNS proof is ordered only through the
  // issuance sweep, so nothing here may emit a `challenge`.
  const plan = planNameTls([
    name('a.example.net', pin('t1')),
    name('b.example.net', SELF),
    name('c.example.net', ACME),
  ])
  for (const entry of plan.nameTls) assertEquals('challenge' in entry, false)
  assertEquals(JSON.stringify(plan).includes('challenge'), false)
  for (const file of ['./name-tls-wire.ts', '../../client/environments/deploy-prepare.ts']) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url))
    const lines = source.split('\n').filter((line) => /\bnameTls\b/.test(line))
    assertEquals(
      lines.filter((line) => /challenge|dns-?01/i.test(line)),
      []
    )
  }
})
