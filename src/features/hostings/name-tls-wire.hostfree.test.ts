/**
 * Host-free coverage for the per-name certificate plan a deploy sends.
 */

import { assertEquals } from '@std/assert'
import { isUniform, nameTlsPinIds, planNameTls, type NameWire } from './name-tls-wire.ts'

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

test('a www name that matches its typed name rides on the typed name entry', () => {
  const plan = planNameTls([
    name('a.example.net', pin('t1')),
    name('b.example.net', pin('t1')),
    name('c.example.net', SELF),
    name('www.c.example.net', SELF, false),
  ])
  assertEquals(plan.nameTls, [{ hostname: 'c.example.net', tlsMode: 'internal' }])
})

test('a www name that differs from its typed name gets its own entry', () => {
  const plan = planNameTls([
    name('a.example.net', pin('t1')),
    name('www.a.example.net', pin('t1'), false),
    name('b.example.net', SELF),
    name('www.b.example.net', pin('t1'), false),
  ])
  assertEquals(plan.row, pin('t1'))
  assertEquals(plan.nameTls, [
    { hostname: 'b.example.net', tlsMode: 'internal' },
    { hostname: 'www.b.example.net', tlsId: 't1' },
  ])
})

test('a www name that differs only from the row gets an entry when its typed name has none', () => {
  const plan = planNameTls([
    name('a.example.net', pin('t1')),
    name('b.example.net', pin('t1')),
    name('www.a.example.net', SELF, false),
  ])
  assertEquals(plan.nameTls, [{ hostname: 'www.a.example.net', tlsMode: 'internal' }])
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
