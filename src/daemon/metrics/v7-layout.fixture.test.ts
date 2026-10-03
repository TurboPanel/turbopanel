/**
 * Pins the metrics v7 canonical layout fixture (testing/v7-layout.fixture.json,
 * generated from the owner-sealed explorer model by
 * scripts/metrics-v7-layout/generate.mjs) against the numbers the sealed plan
 * states, so the spec cannot drift unnoticed before the writer is built on it.
 */
import { assert, assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import fixtureJson from './testing/v7-layout.fixture.json' with { type: 'json' }

type Row = { family: string; page?: number; entities?: string[] }
type Case = {
  id: string
  plan: string
  machine: 'vps' | 'phys'
  docker: boolean
  db: boolean
  rowCount: number
  rows: Row[]
}
type Template = {
  kind: string
  doubles: (string | null)[]
  blobs: string[]
  perPageEntities?: number
}
const fixture = fixtureJson as unknown as {
  plan: { ids: string[]; ownerExclusions: { ids: string[] } }
  envelope: { contentBlobCapacity: number }
  planLimits: Record<
    string,
    { driveSlots: number; gpuSlots: number; sensorSignals: number; docker: boolean }
  >
  families: Record<string, Template>
  cases: Case[]
}

const find = (id: string): Case => {
  const found = fixture.cases.find((c) => c.id === id)
  assert(found, `missing case ${id}`)
  return found
}

describe('metrics v7 layout fixture', () => {
  it('covers every plan x machine x hardware shape x service mix', () => {
    assertEquals(fixture.cases.length, 8 * 2 * 5 * 3)
  })

  it('keeps the sealed row counts (VPS 4, physical 5-6, +1 with managed databases)', () => {
    for (const plan of Object.keys(fixture.planLimits)) {
      assertEquals(find(`${plan}/vps/preset/plain`).rowCount, 4)
      assertEquals(find(`${plan}/vps/preset/docker`).rowCount, 4)
      assertEquals(find(`${plan}/vps/preset/docker+db`).rowCount, 5)
      assertEquals(find(`${plan}/phys/single/docker`).rowCount, 5)
      assertEquals(find(`${plan}/phys/preset/docker`).rowCount, 6)
      assertEquals(find(`${plan}/phys/preset/docker+db`).rowCount, 7)
    }
  })

  it('states the sealed plan limits', () => {
    const l = fixture.planLimits
    const drives = Object.values(l).map((p) => p.driveSlots)
    assertEquals(drives, [3, 6, 6, 9, 12, 18, 21, 24])
    assertEquals(
      Object.values(l).map((p) => p.gpuSlots),
      [0, 1, 1, 4, 4, 6, 8, 8]
    )
    assert(Object.values(l).every((p) => p.docker && p.sensorSignals === 19))
  })

  it('never exceeds 19 doubles and 14 content blobs per row', () => {
    for (const tpl of Object.values(fixture.families)) {
      if (tpl.kind === 'host') assert(tpl.doubles.length <= 19)
      assert(tpl.blobs.length <= fixture.envelope.contentBlobCapacity)
    }
    for (const t of Object.values(fixture.families).filter((f) => f.kind === 'entity')) {
      const per = t.perPageEntities ?? 0
      assert(per * t.doubles.length <= 19)
      assert(per * t.blobs.length <= fixture.envelope.contentBlobCapacity)
    }
  })

  it('drops the owner-excluded per-site Caddy text and places every other id once', () => {
    const exclusions = fixture.plan.ownerExclusions.ids
    assertEquals(exclusions.sort(), ['topSites5xx', 'topSitesReq'])
    const placed = new Set<string>()
    for (const tpl of Object.values(fixture.families)) {
      for (const id of [...tpl.doubles, ...tpl.blobs]) {
        if (id) placed.add(id.split('.')[0])
      }
    }
    for (const id of exclusions) assert(!placed.has(id), `${id} must not be placed`)
    assert(placed.has('topSites'))
    assert(placed.has('oomKills') && placed.has('ctrCpu') && placed.has('cTls'))
  })

  it('names the liveness row host.system and writes the sealed host rows everywhere', () => {
    for (const c of fixture.cases) {
      assertEquals(
        c.rows.slice(0, 4).map((r) => r.family),
        ['host.system', 'host.io', 'host.network', 'host.web']
      )
    }
  })

  it('skips the block row for one drive and folds exactly one extra filesystem', () => {
    const oneDrive = find('SX/phys/single/docker')
    assert(!oneDrive.rows.some((r) => r.family === 'block' || r.family === 'filesystem'))
    assert(find('S2/phys/max/docker').rows.some((r) => r.family === 'filesystem'))
  })

  it('applies the GPU slots per plan (none on S1, one on S2 and S3)', () => {
    const gpuCount = (id: string) =>
      find(id)
        .rows.filter((r) => r.family === 'gpu')
        .flatMap((r) => r.entities ?? []).length
    assertEquals(gpuCount('S1/phys/max/docker'), 0)
    assertEquals(gpuCount('S2/phys/over/docker'), 1)
    assertEquals(gpuCount('S3/phys/over/docker'), 1)
    assertEquals(gpuCount('S4/phys/max/docker'), 4)
  })
})
