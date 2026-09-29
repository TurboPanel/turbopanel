import { assert, assertEquals } from '@std/assert'
import { join } from '@std/path'
import { buildServerSizeCommand, SERVER_SIZE_COMMAND } from './size-command.ts'

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

Deno.test(
  'the console command reads /proc, is short, and carries no single quote inside the program',
  () => {
    assert(SERVER_SIZE_COMMAND.startsWith("awk -F: '"))
    assert(SERVER_SIZE_COMMAND.endsWith(' /proc/cpuinfo /proc/meminfo'))
    assertEquals(SERVER_SIZE_COMMAND.split("'").length, 3, 'exactly one single-quoted awk program')
    assert(SERVER_SIZE_COMMAND.length <= 240, `${SERVER_SIZE_COMMAND.length} characters`)
  }
)

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
  assertEquals(await runSize(cpuinfo, meminfo(8 * 1024 * 1024)), '8 cores, 8.0 GiB RAM')
})

Deno.test('no topology (e.g. many ARM boards): every processor is a core', async () => {
  const cpuinfo = [0, 1, 2, 3].map((i) => processor(i)).join('') + 'Hardware\t: Test Board\n'
  assertEquals(await runSize(cpuinfo, meminfo(4 * 1024 * 1024)), '4 cores, 4.0 GiB RAM')
})

Deno.test('no core id: falls back to cpu cores per socket', async () => {
  const cpuinfo = [0, 1, 2, 3, 4, 5, 6, 7]
    .map((i) => processor(i, { physicalId: i < 4 ? 0 : 1, cpuCores: 2 }))
    .join('')
  // Two sockets reporting "cpu cores: 2" — 4 physical cores, not 8.
  assertEquals(await runSize(cpuinfo, meminfo(1024 * 1024)), '4 cores, 1.0 GiB RAM')
})

Deno.test('RAM is MemTotal in GiB with one decimal, the unit placement reads', async () => {
  const oneCore = processor(0, { physicalId: 0, coreId: 0, cpuCores: 1 })
  assertEquals(await runSize(oneCore, meminfo(16 * 1024 * 1024)), '1 cores, 16.0 GiB RAM')
  // A "32 GB" machine reports a little under 32 GiB.
  assertEquals(await runSize(oneCore, meminfo(32_791_232)), '1 cores, 31.3 GiB RAM')
})

Deno.test('the awk program ends its printf with a literal backslash-n for awk to expand', () => {
  // The shell sees `\n` (two characters); awk turns it into the newline.
  assert(SERVER_SIZE_COMMAND.includes('GiB RAM\\n",(k?k:n),m/1048576}\''))
  assert(!SERVER_SIZE_COMMAND.includes('\n'))
})
