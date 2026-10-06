/**
 * Host-free coverage for the repin apply pass: a fake `Db` records every
 * `ip` write so the tests can assert exactly what the pass touches.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { ServerReportedIp } from '../../contracts/server-addresses.ts'
import { applyReportedAddressRepin } from './repin-apply.ts'
import { parseIpPinMetadata } from './repin.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SERVER = '00000000-0000-4000-8000-0000000000a1'
const ORG = '00000000-0000-4000-8000-0000000000b1'
const DC = '00000000-0000-4000-8000-0000000000d1'
const NET = '00000000-0000-4000-8000-0000000000e4'

type PinRow = {
  ipId: string
  serverId: string
  datacenterId: string
  networkId: string | null
  address: string
  organizationId: string
  metadata: unknown
  subnetCidr: string | null
}

type Write = { patch: Record<string, unknown> }

function thenable<T>(rows: T[]) {
  return {
    then(resolve: (value: T[]) => unknown, reject?: (err: unknown) => unknown) {
      return Promise.resolve(rows).then(resolve, reject)
    },
  }
}

/**
 * `select` dispatches on the projection: the pin-detail load selects
 * `subnetCidr`; the in-use lookup selects `{ id, address }` only.
 */
function createFakeDb(params: {
  pins: PinRow[]
  inUse?: Array<{ id: string; address: string }>
  writes: Write[]
  failWriteWith?: (patch: Record<string, unknown>) => unknown
}): Db {
  return {
    select(fields: Record<string, unknown>) {
      const rows: unknown[] = 'subnetCidr' in fields ? params.pins : (params.inUse ?? [])
      const chain = {
        from: () => chain,
        leftJoin: () => chain,
        where: () => thenable(rows),
      }
      return chain
    },
    update() {
      return {
        set(patch: Record<string, unknown>) {
          return {
            where: () => {
              const failure = params.failWriteWith?.(patch)
              if (failure) return Promise.reject(failure)
              params.writes.push({ patch })
              return Promise.resolve(undefined)
            },
          }
        },
      }
    },
  } as unknown as Db
}

function pin(overrides: Partial<PinRow> = {}): PinRow {
  return {
    ipId: 'ip-1',
    serverId: SERVER,
    datacenterId: DC,
    networkId: NET,
    address: '10.20.0.10',
    organizationId: ORG,
    metadata: null,
    subnetCidr: '10.20.0.0/24',
    ...overrides,
  }
}

function reported(...addresses: string[]): ServerReportedIp[] {
  return addresses.map((address) => ({
    address,
    version: address.includes(':') ? 6 : 4,
    scope: 'private',
  }))
}

test('applyReportedAddressRepin: no pins → zero writes', async () => {
  const writes: Write[] = []
  const db = createFakeDb({ pins: [], writes })
  const applied = await applyReportedAddressRepin(db, SERVER, reported('10.20.0.42'))
  assertEquals(applied, [])
  assertEquals(writes.length, 0)
})

test('applyReportedAddressRepin: unchanged pin → zero writes', async () => {
  const writes: Write[] = []
  const db = createFakeDb({ pins: [pin()], writes })
  const applied = await applyReportedAddressRepin(db, SERVER, reported('10.20.0.10'))
  assertEquals(applied, [])
  assertEquals(writes.length, 0)
})

test('applyReportedAddressRepin: a repin stamps repinPendingFanoutAt and clears stale', async () => {
  const writes: Write[] = []
  const db = createFakeDb({
    pins: [
      pin({
        metadata: {
          note: 'keep',
          stale: { since: '2026-09-01T00:00:00.000Z', reason: 'address_gone_no_candidate' },
        },
      }),
    ],
    writes,
  })
  const applied = await applyReportedAddressRepin(db, SERVER, reported('10.20.0.42'))
  assertEquals(applied, [{ kind: 'repin', ipId: 'ip-1', from: '10.20.0.10', to: '10.20.0.42' }])
  assertEquals(writes.length, 1)
  const patch = writes[0]?.patch
  if (!patch) throw new TypeError('expected one ip write')
  assertEquals(patch.address, '10.20.0.42')
  const metadata = patch.metadata as Record<string, unknown>
  assertEquals(metadata.note, 'keep')
  const parsed = parseIpPinMetadata(metadata)
  assertEquals(parsed.stale, undefined)
  assertEquals(parsed.repin?.from, '10.20.0.10')
  assertEquals(typeof patch.repinPendingFanoutAt, 'string')
  assertEquals(patch.repinPendingFanoutAt, parsed.repin?.at)
})

test('applyReportedAddressRepin: unique violation on repin downgrades to mark_stale', async () => {
  const writes: Write[] = []
  const db = createFakeDb({
    pins: [pin()],
    writes,
    failWriteWith: (patch) =>
      'address' in patch
        ? Object.assign(new Error('duplicate key uniq_ip_org_address'), {
            code: '23505',
          })
        : undefined,
  })
  const applied = await applyReportedAddressRepin(db, SERVER, reported('10.20.0.42'))
  assertEquals(applied, [{ kind: 'mark_stale', ipId: 'ip-1', reason: 'address_gone_ambiguous' }])
  assertEquals(writes.length, 1)
  const metadata = writes[0]?.patch.metadata
  assertEquals(parseIpPinMetadata(metadata).stale?.reason, 'address_gone_ambiguous')
  assertEquals((writes[0]?.patch as Record<string, unknown>).address, undefined)
})

test('applyReportedAddressRepin: candidate held by another org row → stale', async () => {
  const writes: Write[] = []
  const db = createFakeDb({
    pins: [pin()],
    inUse: [{ id: 'ip-other', address: '10.20.0.42' }],
    writes,
  })
  const applied = await applyReportedAddressRepin(db, SERVER, reported('10.20.0.42'))
  assertEquals(applied, [{ kind: 'mark_stale', ipId: 'ip-1', reason: 'address_gone_no_candidate' }])
  assertEquals(writes.length, 1)
})

test('applyReportedAddressRepin: pin address returning clears stale only', async () => {
  const writes: Write[] = []
  const db = createFakeDb({
    pins: [
      pin({
        metadata: {
          stale: { since: '2026-09-01T00:00:00.000Z', reason: 'address_gone_ambiguous' },
        },
      }),
    ],
    writes,
  })
  const applied = await applyReportedAddressRepin(db, SERVER, reported('10.20.0.10'))
  assertEquals(applied, [{ kind: 'clear_stale', ipId: 'ip-1' }])
  assertEquals(writes.length, 1)
  assertEquals(writes[0]?.patch.metadata, {})
})

test('applyReportedAddressRepin: a non-unique write failure is swallowed', async () => {
  const writes: Write[] = []
  const db = createFakeDb({
    pins: [pin()],
    writes,
    failWriteWith: () => new Error('connection reset'),
  })
  const applied = await applyReportedAddressRepin(db, SERVER, reported('10.20.0.42'))
  assertEquals(applied, [])
  assertEquals(writes.length, 0)
})

function reportedWithLink(address: string, link: 'up' | 'down' | undefined): ServerReportedIp[] {
  return [
    {
      address,
      version: 4,
      scope: 'private',
      interface: 'eth1',
      ...(link ? { link } : {}),
    },
  ]
}

test('applyReportedAddressRepin: a link reported down flags the pin and stamps the fan-out marker', async () => {
  const writes: Write[] = []
  const db = createFakeDb({ pins: [pin({ metadata: { note: 'keep' } })], writes })
  const applied = await applyReportedAddressRepin(
    db,
    SERVER,
    reportedWithLink('10.20.0.10', 'down')
  )
  assertEquals(applied, [{ kind: 'link_down', ipId: 'ip-1' }])
  assertEquals(writes.length, 1)
  const patch = writes[0]?.patch
  if (!patch) throw new TypeError('expected one ip write')
  const metadata = patch.metadata as Record<string, unknown>
  assertEquals(metadata.note, 'keep')
  assertEquals(typeof parseIpPinMetadata(metadata).linkDown?.since, 'string')
  assertEquals(patch.repinPendingFanoutAt, parseIpPinMetadata(metadata).linkDown?.since)
})

test('applyReportedAddressRepin: a pin already flagged down and still down writes nothing', async () => {
  const writes: Write[] = []
  const db = createFakeDb({
    pins: [pin({ metadata: { linkDown: { since: '2026-10-01T00:00:00.000Z' } } })],
    writes,
  })
  assertEquals(
    await applyReportedAddressRepin(db, SERVER, reportedWithLink('10.20.0.10', 'down')),
    []
  )
  assertEquals(writes.length, 0)
})

test('applyReportedAddressRepin: link back up (or not reported by an older daemon) clears the flag and re-plans', async () => {
  for (const link of ['up', undefined] as const) {
    const writes: Write[] = []
    const db = createFakeDb({
      pins: [pin({ metadata: { note: 'keep', linkDown: { since: '2026-10-01T00:00:00.000Z' } } })],
      writes,
    })
    const applied = await applyReportedAddressRepin(
      db,
      SERVER,
      reportedWithLink('10.20.0.10', link)
    )
    assertEquals(applied, [{ kind: 'link_up', ipId: 'ip-1' }])
    const patch = writes[0]?.patch
    if (!patch) throw new TypeError('expected one ip write')
    const metadata = patch.metadata as Record<string, unknown>
    assertEquals(metadata.note, 'keep')
    assertEquals(parseIpPinMetadata(metadata).linkDown, undefined)
    assertEquals(typeof patch.repinPendingFanoutAt, 'string')
  }
})

test('applyReportedAddressRepin: clearing stale and flagging link on one pin keeps both writes', async () => {
  const writes: Write[] = []
  const db = createFakeDb({
    pins: [
      pin({
        metadata: {
          stale: { since: '2026-09-01T00:00:00.000Z', reason: 'address_gone_ambiguous' },
        },
      }),
    ],
    writes,
  })
  const applied = await applyReportedAddressRepin(
    db,
    SERVER,
    reportedWithLink('10.20.0.10', 'down')
  )
  assertEquals(applied, [
    { kind: 'clear_stale', ipId: 'ip-1' },
    { kind: 'link_down', ipId: 'ip-1' },
  ])
  const last = writes.at(-1)?.patch.metadata
  const parsed = parseIpPinMetadata(last)
  assertEquals(parsed.stale, undefined)
  assertEquals(typeof parsed.linkDown?.since, 'string')
})

test('applyReportedAddressRepin: a repinned pin drops the old link flag and is judged on its new address', async () => {
  const writes: Write[] = []
  const db = createFakeDb({
    pins: [pin({ metadata: { linkDown: { since: '2026-10-01T00:00:00.000Z' } } })],
    writes,
  })
  const applied = await applyReportedAddressRepin(
    db,
    SERVER,
    reportedWithLink('10.20.0.42', 'down')
  )
  assertEquals(applied, [
    { kind: 'repin', ipId: 'ip-1', from: '10.20.0.10', to: '10.20.0.42' },
    { kind: 'link_down', ipId: 'ip-1' },
  ])
  assertEquals(writes.length, 2)
  assertEquals(typeof parseIpPinMetadata(writes[1]?.patch.metadata).linkDown?.since, 'string')
  assertEquals(parseIpPinMetadata(writes[1]?.patch.metadata).repin?.from, '10.20.0.10')
})

test('applyReportedAddressRepin: a pin without a subnet still gets its link state recorded', async () => {
  const writes: Write[] = []
  const db = createFakeDb({ pins: [pin({ networkId: null, subnetCidr: null })], writes })
  const applied = await applyReportedAddressRepin(
    db,
    SERVER,
    reportedWithLink('10.20.0.10', 'down')
  )
  assertEquals(applied, [{ kind: 'link_down', ipId: 'ip-1' }])
})

test('applyReportedAddressRepin: a repin onto an up address drops the old down marker in one write', async () => {
  const writes: Write[] = []
  const db = createFakeDb({
    pins: [pin({ metadata: { linkDown: { since: '2026-10-01T00:00:00.000Z' } } })],
    writes,
  })
  const applied = await applyReportedAddressRepin(db, SERVER, reportedWithLink('10.20.0.42', 'up'))
  assertEquals(applied, [{ kind: 'repin', ipId: 'ip-1', from: '10.20.0.10', to: '10.20.0.42' }])
  assertEquals(writes.length, 1)
  assertEquals(parseIpPinMetadata(writes[0]?.patch.metadata).linkDown, undefined)
})

test('applyReportedAddressRepin: down, up, down in a row restarts since after the clear', async () => {
  const writes: Write[] = []
  let stored: unknown = null
  const run = async (link: 'up' | 'down') => {
    const db = createFakeDb({ pins: [pin({ metadata: stored })], writes })
    await applyReportedAddressRepin(db, SERVER, reportedWithLink('10.20.0.10', link))
    stored = writes.at(-1)?.patch.metadata
  }
  await run('down')
  const first = parseIpPinMetadata(stored).linkDown?.since
  await run('up')
  assertEquals(parseIpPinMetadata(stored).linkDown, undefined)
  await new Promise((resolve) => setTimeout(resolve, 5))
  await run('down')
  const second = parseIpPinMetadata(stored).linkDown?.since
  assertEquals(typeof first, 'string')
  assertEquals(typeof second, 'string')
  assertEquals(second === first, false)
  assertEquals(writes.length, 3)
})

test('applyReportedAddressRepin: a stale-marked pin keeps its down marker when the stale flag is set', async () => {
  const writes: Write[] = []
  const db = createFakeDb({
    pins: [pin({ metadata: { linkDown: { since: '2026-10-01T00:00:00.000Z' } } })],
    writes,
  })
  // The pin's address is gone and nothing in its subnet is reported: it goes stale, the link flag stays.
  const applied = await applyReportedAddressRepin(db, SERVER, reportedWithLink('192.0.2.9', 'down'))
  assertEquals(applied, [{ kind: 'mark_stale', ipId: 'ip-1', reason: 'address_gone_no_candidate' }])
  const parsed = parseIpPinMetadata(writes.at(-1)?.patch.metadata)
  assertEquals(parsed.stale?.reason, 'address_gone_no_candidate')
  assertEquals(parsed.linkDown?.since, '2026-10-01T00:00:00.000Z')
})
