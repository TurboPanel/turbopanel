import { assert, assertEquals } from '@std/assert'
import { join } from '@std/path'
import { cpuBand, ramBand, resolveRequiredTier } from './tier-placement.ts'
import { PRICED_LADDER } from './ladder.ts'
import { buildServerSizeCommand, SERVER_SIZE_COMMAND } from './size-command.ts'

const GIB = 1024 ** 3

/** One `/proc/cpuinfo` processor block. */
function processor(
  index: number,
  topology: { physicalId?: number; coreId?: number; cpuCores?: number } = {}
): string {
  const lines = [
    `processor\t: ${index}`,
    'vendor_id\t: GenuineIntel',
    'model name\t: Test CPU @ 2.40GHz',
  ]
  if (topology.physicalId !== undefined) lines.push(`physical id\t: ${topology.physicalId}`)
  if (topology.coreId !== undefined) lines.push(`core id\t\t: ${topology.coreId}`)
  if (topology.cpuCores !== undefined) lines.push(`cpu cores\t: ${topology.cpuCores}`)
  return lines.join('\n') + '\n\n'
}

function meminfo(totalKb: number): string {
  return `MemTotal:       ${totalKb} kB\nMemFree:         1024 kB\nMemAvailable:    2048 kB\n`
}

async function runSize(cpuinfo: string, mem: string): Promise<string> {
  const dir = await Deno.makeTempDir()
  try {
    const cpuPath = join(dir, 'cpuinfo')
    const memPath = join(dir, 'meminfo')
    await Deno.writeTextFile(cpuPath, cpuinfo)
    await Deno.writeTextFile(memPath, mem)
    const command = buildServerSizeCommand({ cpuinfo: cpuPath, meminfo: memPath })
    const out = await new Deno.Command('sh', { args: ['-c', command] }).output()
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr))
    return new TextDecoder().decode(out.stdout).trim()
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

/** The tier placement would give a machine with these totals. */
function placement(cores: number, memoryBytes: number): string {
  return resolveRequiredTier({
    cpus: [{ cores: { total: cores } }],
    memory: { totalBytes: memoryBytes },
  }).label
}

Deno.test('the console command reads /proc and carries no single quote inside the program', () => {
  assert(SERVER_SIZE_COMMAND.endsWith(' /proc/cpuinfo /proc/meminfo'))
  const program = SERVER_SIZE_COMMAND.split("'")
  assertEquals(program.length, 3, 'exactly one single-quoted awk program')
})

Deno.test('the ladder is priced in whole GiB, so the GiB ceilings in the command are exact', () => {
  for (const entry of PRICED_LADDER) {
    assert(Number.isInteger(entry.maxMemoryBytes / GIB), entry.label)
  }
})

Deno.test('hyperthreads never count: 2 sockets x 4 cores x 2 threads is 8 cores', async () => {
  let cpuinfo = ''
  let index = 0
  for (const socket of [0, 1]) {
    for (let thread = 0; thread < 2; thread++) {
      for (let core = 0; core < 4; core++) {
        cpuinfo += processor(index++, { physicalId: socket, coreId: core, cpuCores: 4 })
      }
    }
  }
  const out = await runSize(cpuinfo, meminfo(8 * 1024 * 1024))
  assertEquals(out, '8 cores, 8.0 GiB RAM -> S2')
  assertEquals(placement(8, 8 * GIB), 'S2')
})

Deno.test('no topology (e.g. many ARM boards): every processor is a core', async () => {
  const cpuinfo = [0, 1, 2, 3].map((i) => processor(i)).join('') + 'Hardware\t: Test Board\n'
  assertEquals(await runSize(cpuinfo, meminfo(4 * 1024 * 1024)), '4 cores, 4.0 GiB RAM -> S1')
})

Deno.test('no core id: falls back to cpu cores per socket', async () => {
  const cpuinfo = [0, 1, 2, 3, 4, 5, 6, 7]
    .map((i) => processor(i, { physicalId: i < 4 ? 0 : 1, cpuCores: 2 }))
    .join('')
  // Two sockets reporting "cpu cores: 2" — 4 physical cores, not 8.
  assertEquals(await runSize(cpuinfo, meminfo(1024 * 1024)), '4 cores, 1.0 GiB RAM -> S1')
})

Deno.test('RAM bands at the ceiling edges match placement, and the harder band wins', async () => {
  const oneCore = processor(0, { physicalId: 0, coreId: 0, cpuCores: 1 })
  const cases: Array<[number, string]> = [
    [16 * 1024 * 1024, 'S1'],
    [16 * 1024 * 1024 + 1, 'S2'],
    [64 * 1024 * 1024, 'S3'],
    [1024 * 1024 * 1024, 'S7'],
    [1024 * 1024 * 1024 + 4, 'SX'],
  ]
  for (const [kb, label] of cases) {
    const out = await runSize(oneCore, meminfo(kb))
    assert(out.endsWith(`-> ${label}`), `${kb} kB: ${out}`)
    assertEquals(label, ramBand(kb * 1024).label)
  }
})

Deno.test('CPU bands at the ceiling edges match placement, including SX past S7', async () => {
  for (const cores of [4, 5, 10, 11, 256, 257]) {
    const cpuinfo = Array.from({ length: cores }, (_, i) =>
      processor(i, { physicalId: 0, coreId: i, cpuCores: cores })
    ).join('')
    const out = await runSize(cpuinfo, meminfo(1024 * 1024))
    assertEquals(out, `${cores} cores, 1.0 GiB RAM -> ${cpuBand(cores).label}`)
  }
})
