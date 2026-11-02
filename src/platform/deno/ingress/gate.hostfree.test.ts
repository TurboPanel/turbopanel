import { assert, assertEquals } from '@std/assert'
import { edgeGateFrom, type EdgeGateServer } from './gate.ts'

const test = Deno.test.bind(Deno)

function srv(id: string, trustPinnedBy: string | null, name = id): EdgeGateServer {
  return { id, name, organizationId: 'org-1', trustPinnedBy }
}

const NONE = new Set<string>()

test('no remote server at all: edge modes are ready', () => {
  const gate = edgeGateFrom([], NONE, undefined)
  assertEquals(gate.open, true)
  assertEquals(gate.remoteServers, 0)
  assertEquals(gate.waiting, [])
})

test('every remote server pinned by install or upgrade: ready', () => {
  const gate = edgeGateFrom([srv('a', 'install'), srv('b', 'upgrade')], NONE, undefined)
  assertEquals(gate.open, true)
  assertEquals(gate.remoteServers, 2)
})

test('a server that never pinned, or was installed with the skip flag, keeps the gate shut', () => {
  const gate = edgeGateFrom(
    [srv('a', 'install'), srv('b', null, 'kappa'), srv('c', 'unsafe', 'omicron')],
    NONE,
    undefined
  )
  assertEquals(gate.open, false)
  assertEquals(
    gate.waiting.map((item) => [item.name, item.pinnedBy]),
    [
      ['kappa', null],
      ['omicron', 'unsafe'],
    ]
  )
  assertEquals(
    gate.reason,
    "2 servers still need to re-learn this control plane's key before an edge mode can be used: kappa, omicron."
  )
  const one = edgeGateFrom([srv('b', null, 'kappa')], NONE, undefined)
  assert(one.reason?.startsWith('1 server still needs'))
})

test('the server on the control plane host is ignored', () => {
  const gate = edgeGateFrom([srv('local', null), srv('a', 'install')], new Set(['local']), '')
  assertEquals(gate.open, true)
  assertEquals(gate.remoteServers, 1)
  assertEquals(edgeGateFrom([srv('local', null)], new Set(['local']), undefined).open, true)
})

test('TURBOPANEL_EDGE_GATE=closed keeps the gate shut; no value opens it', () => {
  const forced = edgeGateFrom([], NONE, 'closed')
  assertEquals(forced.open, false)
  assertEquals(forced.forcedClosed, true)
  assertEquals(edgeGateFrom([srv('b', null)], NONE, 'open').open, false)
})

test('a long list names three servers and counts the rest', () => {
  const servers = ['a', 'b', 'c', 'd', 'e'].map((id) => srv(id, null))
  const gate = edgeGateFrom(servers, NONE, undefined)
  assert(gate.reason?.endsWith('a, b, c and 2 more.'))
  assertEquals(gate.waiting.length, 5)
})
