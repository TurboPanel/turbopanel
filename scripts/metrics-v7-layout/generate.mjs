#!/usr/bin/env node
/**
 * Regenerates src/daemon/metrics/testing/v7-layout.fixture.json: the canonical
 * metrics v7 slot layout, computed by the owner-sealed explorer's own packing
 * logic (artifact-model.cjs, extracted from the "Metrics Schema Audit"
 * artifact) for the sealed plan (plan.json) over every plan x machine kind.
 *
 * The v7 write path (field-map.ts + v7-layout.ts) must reproduce this fixture
 * exactly; v7-layout.fixture.test.ts enforces it.
 *
 * Deliberate deviations from the explorer, all documented in V7-LAYOUT.md:
 *  - owner exclusions in plan.json are removed before packing;
 *  - the explorer packs envelope blobs in catalogue order; the real envelope
 *    keeps sample time at blob5, so topology generation moves to blob4
 *    (still six contiguous envelope blobs, so content packing is unchanged).
 *
 * Usage: node scripts/metrics-v7-layout/generate.mjs
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(HERE, '../../src/daemon/metrics/testing/v7-layout.fixture.json')
const model = require('./artifact-model.cjs')
const plan = JSON.parse(fs.readFileSync(path.join(HERE, 'plan.json'), 'utf8'))

const excluded = new Set(plan.ownerExclusions.ids)
const locked = model.ITEMS.filter((i) => i.lock).map((i) => i.id)
const effectiveIds = [...new Set([...plan.ids.filter((id) => !excluded.has(id)), ...locked])].sort()
for (const id of effectiveIds) if (!model.ITEM[id]) throw new Error(`unknown plan id ${id}`)

const FAMILY_BY_LABEL = {
  'cpu + memory + limits + diagnostics': 'host.system',
  'disk-io + docker': 'host.io',
  'disk-space + network + health + diagnostics + traefik': 'host.network',
  'health + directories + caddy + traefik': 'host.web',
  'db-census + proxysql': 'managed.database',
}
const ENTITY_FAMILY = {
  drive: 'block',
  nic: 'network',
  fs: 'filesystem',
  gpu: 'gpu',
  sensor: 'hardware.physical',
}
const ENVELOPE_ORDER = ['kind', 'family', 'version', 'topoGen', 'sampledAt', 'ids']

model.builder.sel = new Set(effectiveIds)
model.builder.mode = plan.packing
model.builder.rules = { ...plan.shortcuts }

const templates = {}
function recordTemplate(family, tpl) {
  const key = JSON.stringify(tpl)
  if (templates[family] === undefined) templates[family] = { key, tpl }
  else if (templates[family].key !== key)
    throw new Error(`template for ${family} varies between machines`)
}
const doubleIds = (slots) => slots.map((s) => (s.f ? s.id : null))
const contentBlobIds = (blobs) => blobs.filter((b) => !b.env && b.id).map((b) => b.id)

function entityIdsOf(row) {
  return [...new Set(row.slots.filter((s) => s.f).map((s) => s.g.split(' ').slice(1).join(' ')))]
}

function rowsToCase(rows, machine, hw, tier) {
  const out = []
  const counters = {}
  for (const row of rows) {
    if (row.fam in FAMILY_BY_LABEL) {
      const family = FAMILY_BY_LABEL[row.fam]
      recordTemplate(family, {
        kind: 'host',
        doubles: doubleIds(row.slots),
        blobs: contentBlobIds(row.blobs),
      })
      out.push({ family })
      continue
    }
    const sec = row.sec
    const family = ENTITY_FAMILY[sec]
    if (!family) throw new Error(`unmapped row ${row.fam}`)
    const page = counters[family] ?? 0
    counters[family] = page + 1
    let entities
    if (sec === 'sensor') {
      entities = row.slots.filter((s) => s.f).map((s) => s.f.name)
      recordTemplate(family, { kind: 'sensor', doubles: ['sn_value'], blobs: [] })
    } else {
      entities = entityIdsOf(row)
      const per = entities.length
      const one = row.slots.slice(
        0,
        row.slots.findIndex((s) => !s.f) === -1 ? 19 : row.slots.findIndex((s) => !s.f)
      )
      const width = one.length / per
      recordTemplate(family, {
        kind: 'entity',
        doubles: doubleIds(one.slice(0, width)),
        blobs: [...new Set(contentBlobIds(row.blobs).map((id) => id))],
        perPageEntities: row.per,
      })
    }
    out.push({ family, page, entities })
  }
  return out
}

const MACHINE_KINDS = ['vps', 'phys']
const hardwareVariants = (tier, kind, t) => {
  const preset = model.MACHINES[kind].preset
  const variants = {
    preset: { ...preset },
    max: {
      nics: t.nic,
      disks: t.drive,
      gpus: kind === 'phys' ? t.gpu : Math.min(t.gpu, 1),
      fs: t.fs,
    },
    single: { nics: 1, disks: 1, gpus: 0, fs: 0 },
    fold1: { nics: 3, disks: 1, gpus: 1, fs: 1 },
    over: { nics: t.nic + 2, disks: t.drive + 2, gpus: t.gpu + 1, fs: t.fs + 2 },
  }
  for (const v of Object.values(variants)) {
    v.nics = Math.max(1, Math.min(v.nics, model.LIMITS.nics[1]))
    v.disks = Math.max(1, Math.min(v.disks, model.LIMITS.disks[1]))
    v.gpus = Math.max(0, Math.min(v.gpus, model.LIMITS.gpus[1]))
    v.fs = Math.max(0, Math.min(v.fs, model.LIMITS.fs[1]))
  }
  return variants
}

const HEADER = `# Metrics v7 canonical layout

Generated by \`scripts/metrics-v7-layout/generate.mjs\`; do not edit by hand. The machine-readable twin is
\`testing/v7-layout.fixture.json\` (240 cases: 8 plans x {vps, phys} x 5 hardware shapes x {plain, docker,
docker+db}); \`v7-layout.fixture.test.ts\` pins it. The v7 write path must reproduce it exactly.

## Provenance

The slot layout comes from the owner-sealed "Metrics Schema Audit" row explorer (\`plan.json\` is the owner's
selection: the Recommended preset, packing \`auto\`, shortcuts \`foldFs\` + \`skipDrive\`; the file holds 150 data-point
ids, not the 171 the brief quoted, and equals preset \`r\` exactly). Differences from the explorer, all deliberate:

- Owner answer 2026-10-03: hosting/front Caddy is totals only, so \`topSitesReq\` and \`topSites5xx\` are dropped before
  packing. \`topSites\` (largest sites by disk, from the directory walk) is not a Caddy field and stays.
- The explorer packs envelope blobs in catalogue order, which would put sample time in blob4. The real envelope keeps
  sample time at blob5 (as in v6, so every row kind agrees), so topology generation takes blob4. There are still six
  contiguous envelope blobs and 14 content blobs, so content packing is identical to the explorer.
- Slot ids are catalogue ids (\`busy\`, \`oomKills\`, ...). The contract field behind each id is in \`v7-layout.ts\`.
- Sizes amendment, owner decision 2026-10-07: every sample carries the sizes its percentages are measured against
  (memory, swap, commit limit, logical cores, root bytes and inodes, each extra filesystem's bytes and inodes, each
  GPU's memory), so a resize or a balloon never needs a new topology generation. To make room without adding rows,
  these already-selected data points were dropped: \`majorFaults\` (major page faults), \`softirq\` (soft-interrupt
  CPU time), \`memPsiFull\` (memory pressure, all tasks stalled), \`dSlabU\` (kernel slab that cannot be freed),
  \`t5xx\` / \`tLatency\` / \`tRequests\` (shared router backend errors, latency and request count; backends up and
  total stay), \`nic2.problems\` (NIC 2 errors and drops; NIC 1 stays) and \`gp_memoryActivityPercent\` (GPU memory
  controller activity). Filesystem rows hold 4 filesystems instead of 9, which only costs an extra row on a host with
  more than 4 extra filesystems.

## Row envelope (metrics rows)

| Blob | Content |
| --- | --- |
| blob1 | kind, \`metrics\` |
| blob2 | family (below) |
| blob3 | storage layout revision, \`8\` (the sizes amendment reused slots under wire version 7, so rows stamped \`7\` are never read) |
| blob4 | topology generation |
| blob5 | sample time, UTC text \`YYYY-MM-DD hh:mm:ss\` |
| blob6 | entity ids (comma joined, same order as the row's doubles) or source id; empty on host rows |
| blob7-blob20 | text content blobs (below) |
| double20 | interval seconds |

Event and status rows keep their v6 blob positions; only blob3 (\`8\`) and the blob5 text format change. Sequence,
capability-plan generation and page are no longer written.

## Row families and presence

- \`host.system\` is the liveness row (index = bare serverId); every other family is indexed \`<serverId>:<family>\`.
- Host rows (\`host.system\`, \`host.io\`, \`host.network\`, \`host.web\`) carry every selected host-wide data point
  and are written on every host. A data point that does not apply (no Docker, no RAID) is the sentinel in its slot.
- \`managed.database\` (database census + ProxySQL) is written only when managed databases run.
- \`block\`: written only when the host has more than one drive (a single drive is covered by \`host.io\`);
  3 drives per row.
- \`network\`: NIC 3 and up, 3 per row. NIC 1 and 2 are embedded in \`host.network\` (rx, tx, problems each).
- \`filesystem\`: extra (non-root) filesystems, 4 per row (bytes free, inodes free, bytes total, inodes total);
  exactly one extra filesystem is folded into \`host.network\` (\`fs_*\` slots) and writes no row.
- \`gpu\`: 3 per row, physical machines or real passthrough GPUs only. \`hardware.physical\`: physical only, up to 19
  signals (one double each, ids in blob6); signal order: CPU/board signals, one per drive, three per GPU.
- Plan limits (entities kept, the rest dropped at ingest): see \`planLimits\` in the fixture. Drive slots are
  multiples of 3 (S1 3, S2 6, S3 6, S4 9, S5 12, S6 18, S7 21, SX 24); GPU slots S1 0, S2 1, S3 1, S4+ 4, 4, 6, 8, 8;
  extra filesystems S1 1, S2-S4 9, S5+ 18; NIC slots 2, 2, 5, 5, 8, 8, 11, 11. Docker metrics are on every plan.

`

const cases = []
for (const tier of model.TIER_IDS) {
  const t = model.TIERS.prop[tier]
  for (const kind of MACHINE_KINDS) {
    for (const [hwName, hw] of Object.entries(hardwareVariants(tier, kind, t))) {
      for (const [docker, db] of [
        [false, false],
        [true, false],
        [true, true],
      ]) {
        const machine = model.buildMachine(kind, hw)
        const rows = model.customRows(machine, tier, { docker, db, passthrough: true })
        const caseRows = rowsToCase(rows, machine, hw, tier)
        const embeddedNics = machine.nics.slice(0, 2)
        const kept = (list, n) => list.slice(0, n)
        cases.push({
          id: `${tier}/${kind}/${hwName}/${docker ? (db ? 'docker+db' : 'docker') : 'plain'}`,
          plan: tier,
          machine: kind,
          hardware: hw,
          docker,
          db,
          embeddedNics: kept(embeddedNics, t.nic),
          foldedFilesystem: kept(machine.fs, t.fs).length === 1 ? machine.fs[0] : null,
          rowCount: caseRows.length,
          rows: caseRows,
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sizes amendment (owner decision 2026-10-07).
//
// Every sample carries the sizes its percentages are measured against, so a
// resize or a balloon never needs a new topology generation. The owner chose to
// free the number slots by dropping the least valuable already-selected data
// points (rather than adding rows or using text slots). The packer's output
// above is amended here, slot for slot, so every other slot keeps its place.
//
//   host.system: majorFaults -> cores, softirq -> memTotal, memPsiFull -> swapTotal, dSlabU -> commitLimit
//   host.network: t5xx -> rootTotal, tLatency -> rootInodesTotal, tRequests -> fs_totalBytes,
//                 nic2.problems -> fs_totalInodes
//   gpu: gp_memoryActivityPercent -> gp_memoryTotalBytes
//   filesystem: two more per-entity doubles (fs_totalBytes, fs_totalInodes), so 4 filesystems per row
//
// Nothing is dropped from the entity rows except the one GPU data point.
// ---------------------------------------------------------------------------
const SIZE_SUBSTITUTIONS = {
  'host.system': {
    majorFaults: 'cores',
    softirq: 'memTotal',
    memPsiFull: 'swapTotal',
    dSlabU: 'commitLimit',
  },
  'host.network': {
    t5xx: 'rootTotal',
    tLatency: 'rootInodesTotal',
    tRequests: 'fs_totalBytes',
    'nic2.problems': 'fs_totalInodes',
  },
  gpu: { gp_memoryActivityPercent: 'gp_memoryTotalBytes' },
}
const FILESYSTEM_SIZE_DOUBLES = ['fs_totalBytes', 'fs_totalInodes']
const FILESYSTEM_ENTITIES_PER_ROW = Math.floor(19 / (2 + FILESYSTEM_SIZE_DOUBLES.length))
const DROPPED_BY_SIZES = Object.values(SIZE_SUBSTITUTIONS).flatMap((m) => Object.keys(m))
const ADDED_BY_SIZES = [
  ...Object.values(SIZE_SUBSTITUTIONS).flatMap((m) => Object.values(m)),
  ...FILESYSTEM_SIZE_DOUBLES,
]
for (const id of [...new Set(ADDED_BY_SIZES)])
  if (!model.ITEM[id.split('.')[0]]) throw new Error(`unknown sizes id ${id}`)

for (const [family, map] of Object.entries(SIZE_SUBSTITUTIONS)) {
  const tpl = templates[family].tpl
  for (const [from, to] of Object.entries(map)) {
    const at = tpl.doubles.indexOf(from)
    if (at === -1) throw new Error(`${family} has no slot ${from} to replace`)
    tpl.doubles[at] = to
  }
}
{
  const tpl = templates.filesystem.tpl
  tpl.doubles = [...tpl.doubles, ...FILESYSTEM_SIZE_DOUBLES]
  tpl.perPageEntities = FILESYSTEM_ENTITIES_PER_ROW
}
for (const c of cases) {
  const filesystemRows = c.rows.filter((r) => r.family === 'filesystem')
  if (filesystemRows.length === 0) continue
  const entities = filesystemRows.flatMap((r) => r.entities)
  const rebuilt = []
  for (let i = 0; i < entities.length; i += FILESYSTEM_ENTITIES_PER_ROW) {
    rebuilt.push({
      family: 'filesystem',
      page: rebuilt.length,
      entities: entities.slice(i, i + FILESYSTEM_ENTITIES_PER_ROW),
    })
  }
  const first = c.rows.findIndex((r) => r.family === 'filesystem')
  c.rows = [
    ...c.rows.slice(0, first),
    ...rebuilt,
    ...c.rows.filter((r, i) => i > first && r.family !== 'filesystem'),
  ]
  c.rowCount = c.rows.length
}

const planLimits = Object.fromEntries(
  model.TIER_IDS.map((tier) => {
    const t = model.TIERS.prop[tier]
    return [
      tier,
      {
        nicSlots: t.nic,
        driveSlots: t.drive,
        gpuSlots: t.gpu,
        filesystemSlots: t.fs,
        sensorSignals: t.sensors,
        docker: t.docker,
      },
    ]
  })
)

const fixture = {
  specVersion: 1,
  schemaVersion: 7,
  generatedBy: 'scripts/metrics-v7-layout/generate.mjs',
  plan: {
    packing: plan.packing,
    shortcuts: plan.shortcuts,
    ownerExclusions: plan.ownerExclusions,
    ids: effectiveIds,
    sizesAmendment: {
      date: '2026-10-07',
      dropped: DROPPED_BY_SIZES,
      added: [...new Set(ADDED_BY_SIZES)],
    },
  },
  envelope: {
    order: ENVELOPE_ORDER,
    contentBlobCapacity: 20 - ENVELOPE_ORDER.length,
    note: 'Metrics rows: blob1 kind, blob2 family, blob3 "8" (storage layout revision), blob4 topology generation, blob5 sample time (UTC YYYY-MM-DD hh:mm:ss), blob6 entity or source ids; content text blobs from blob7. double20 is the interval.',
  },
  planLimits,
  families: Object.fromEntries(Object.entries(templates).map(([k, v]) => [k, v.tpl])),
  cases,
}
fs.writeFileSync(OUT, `${JSON.stringify(fixture)}\n`)

const label = (id) => {
  const base = id.split('.')[0]
  const it = model.ITEM[base]
  const f = it.f
  const nic = id.includes('.') ? `.${id.split('.')[1]}` : ''
  return `${id} (${f.scope}.${f.name}${nic})`
}
const md = [HEADER]
for (const [family, tpl] of Object.entries(fixture.families)) {
  md.push(`### ${family}`, '')
  if (tpl.kind === 'host') {
    md.push('| Slot | Data point |', '| --- | --- |')
    tpl.doubles.forEach((id, i) =>
      md.push(`| double${i + 1} | ${id ? label(id) : 'spare (sentinel)'} |`)
    )
    md.push('| double20 | interval seconds |')
    tpl.blobs.forEach((id, i) => md.push(`| blob${i + 7} | ${label(id)} |`))
  } else if (tpl.kind === 'sensor') {
    md.push('One double per sensor signal id, in the order listed in blob6 (up to 19 per row).')
  } else {
    md.push(
      `${tpl.perPageEntities} entities per row; each entity takes ${tpl.doubles.length} consecutive doubles, in blob6 order:`,
      ''
    )
    tpl.doubles.forEach((id, i) => md.push(`- per-entity double ${i + 1}: ${label(id)}`))
    tpl.blobs.forEach((id) => md.push(`- per-entity blob: ${label(id)}`))
  }
  md.push('')
}
md.push('### Rows per sample (Recommended plan, preset hardware)', '')
md.push('| Plan | Machine | Docker | DB | Rows |', '| --- | --- | --- | --- | --- |')
for (const c of cases.filter((x) => x.id.includes('/preset/'))) {
  md.push(
    `| ${c.plan} | ${c.machine} | ${c.docker ? 'yes' : 'no'} | ${c.db ? 'yes' : 'no'} | ${c.rowCount} |`
  )
}
md.push('')
fs.writeFileSync(path.resolve(OUT, '../../V7-LAYOUT.md'), md.join('\n'))
console.log(
  `wrote ${path.relative(process.cwd(), OUT)}: ${cases.length} cases, ${Object.keys(templates).length} families`
)
