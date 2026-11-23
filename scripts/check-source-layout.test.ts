/**
 * The source layout check must pass on a clean baselined tree, fail on a new
 * violation, and fail when a baselined entry is fixed but still listed. The
 * script derives its root from its own location, so each case copies it into a
 * throwaway tree.
 */
import { assertEquals, assertStringIncludes } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const scriptPath = join(dirname(fromFileUrl(import.meta.url)), 'check-source-layout.mjs')

const OK = 'export const ok = 1\n'

async function runInTree(files: Record<string, string>, baseline: Record<string, unknown> = {}) {
  const root = await Deno.makeTempDir({ prefix: 'tp-source-layout-' })
  try {
    await Deno.mkdir(join(root, 'scripts'), { recursive: true })
    await Deno.copyFile(scriptPath, join(root, 'scripts/check-source-layout.mjs'))
    await Deno.writeTextFile(
      join(root, 'scripts/source-layout-baseline.json'),
      JSON.stringify(baseline)
    )
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, rel)
      await Deno.mkdir(dirname(abs), { recursive: true })
      await Deno.writeTextFile(abs, body)
    }
    const run = async (...args: string[]) => {
      const out = await new Deno.Command('node', {
        args: [join(root, 'scripts/check-source-layout.mjs'), ...args],
        stdout: 'piped',
        stderr: 'piped',
      }).output()
      return {
        code: out.code,
        text: new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr),
      }
    }
    const result = await run()
    return { ...result, run, root }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

const bigFile = (lines: number) => 'export const a = 1\n'.repeat(lines)

test('a clean tree with an empty baseline passes', async () => {
  const result = await runInTree({
    'src/features/f/a.ts': OK,
    'src/features/f/a.test.ts': OK,
    'src/features/f/b.hostfree.test.ts': OK,
    'src/platform/deno/x.ts': 'export const t = Deno.cwd()\n',
    'src/deno.ts': 'export const t = Deno.cwd()\n',
  })
  assertEquals(result.code, 0, result.text)
})

test('Deno and Workers bindings outside the runtime folders are new violations', async () => {
  const result = await runInTree({
    'src/features/f/a.ts': 'export const t = Deno.cwd()\n',
    'src/lib/b.ts':
      "import { DurableObject } from 'cloudflare:workers'\nexport { DurableObject }\n",
    'src/lib/c.ts': '// Deno.cwd() in a comment only\nexport const c = 1\n',
    'src/features/f/a.test.ts': 'Deno.test("x", () => {})\n',
  })
  assertEquals(result.code, 1)
  assertStringIncludes(result.text, 'runtime: src/features/f/a.ts is a new violation')
  assertStringIncludes(result.text, 'runtime: src/lib/b.ts is a new violation')
  assertEquals(result.text.includes('src/lib/c.ts'), false)
  assertEquals(result.text.includes('a.test.ts'), false)
})

test('every Deno and cloudflare form is detected outside the runtime folders', async () => {
  const forms: Record<string, string> = {
    'src/lib/typeof.ts': "export const a = typeof Deno === 'undefined'\n",
    'src/lib/optional.ts': 'export const b = (globalThis as any).Deno?.env\n',
    'src/lib/dynamic.ts': "export const c = () => import('cloudflare:workers')\n",
    'src/lib/bare.ts': "import 'cloudflare:test'\n",
    'src/lib/reexport.ts': "export { env } from 'cloudflare:workers'\n",
    'src/lib/template.ts': 'export const d = `${Deno.cwd()}`\n',
    'src/lib/typed.ts': 'export function f(x: Deno.FsFile, y: Map<string, Deno.FsFile>) {}\n',
    'src/lib/value.ts': 'export const v = { cmd: Deno.Command }\n',
    'src/lib/ternary.ts': 'export const t = a ? b : Deno.Command\n',
    'src/developer/surface.ts': 'export const e = Deno.cwd()\n',
  }
  const result = await runInTree(forms)
  assertEquals(result.code, 1)
  for (const file of Object.keys(forms)) {
    assertStringIncludes(result.text, `runtime: ${file} is a new violation`)
  }
})

test('runtime folders are not violations', async () => {
  const result = await runInTree({
    'src/app/deno/a.ts': 'export const a = Deno.cwd()\n',
    'src/app/workers/a.ts': "import 'cloudflare:workers'\n",
    'src/features/f/deno/a.ts': 'export const a = Deno.cwd()\n',
    'src/features/f/workers/a.ts': "import 'cloudflare:workers'\n",
  })
  assertEquals(result.code, 0, result.text)
})

test('regex literals do not hide a later Deno use', async () => {
  const bodies: Record<string, string> = {
    'src/lib/r1.ts': 'const a = /[;|&$\\`()<>\\\\"\'!*?{}]/\nexport const b = Deno.cwd()\n',
    'src/lib/r2.ts': 'const a = /^\\/*x/\nexport const b = Deno.cwd()\n',
    'src/lib/r3.ts': 'export const a = x.replace(/`/g, "")\nexport const b = Deno.cwd()\n',
    'src/lib/r4.ts': 'export const a = /[/]`/.test(s) && Deno.cwd()\n',
  }
  const result = await runInTree(bodies)
  assertEquals(result.code, 1)
  for (const file of Object.keys(bodies)) {
    assertStringIncludes(result.text, `runtime: ${file} is a new violation`)
  }
  const clean = await runInTree({
    'src/lib/c.ts': 'export const a = /Deno\\.cwd/\nexport const d = 6 / 2 / 1\n',
  })
  assertEquals(clean.code, 0, clean.text)
})

test('strings, comments and local declarations do not trigger the runtime rule', async () => {
  const result = await runInTree({
    'src/lib/a.ts': "export const a = '**/*.ts'\nexport const b = 'Deno.env'\n",
    'src/lib/b.ts': 'export const t = `Deno.env ${1 + 1} Deno`\n',
    'src/lib/c.ts': 'export class Queue {}\nexport const q = new Queue()\n',
    'src/lib/d.ts': "export const g = '/*'\n// Deno.cwd()\n/* Deno.cwd() */\n",
  })
  assertEquals(result.code, 0, result.text)
  // A real use after a string holding a block-comment opener is still seen.
  const after = await runInTree({
    'src/lib/e.ts': "export const g = '**/*.ts'\nexport const h = Deno.cwd()\n",
  })
  assertEquals(after.code, 1)
  assertStringIncludes(after.text, 'runtime: src/lib/e.ts is a new violation')
})

test('an oversized source file fails, a baselined one passes, and growth fails', async () => {
  const files = { 'src/lib/big.ts': bigFile(1501), 'src/lib/big.test.ts': bigFile(2000) }
  const fresh = await runInTree(files)
  assertEquals(fresh.code, 1)
  assertStringIncludes(fresh.text, 'size: src/lib/big.ts has 1501 lines')

  const listed = await runInTree(files, { size: { 'src/lib/big.ts': 1501 } })
  assertEquals(listed.code, 0, listed.text)

  const grown = await runInTree(files, { size: { 'src/lib/big.ts': 1500 } })
  assertEquals(grown.code, 1)
  assertStringIncludes(grown.text, 'grew to 1501 lines')
})

test('a baselined file that shrank must be lowered, and prune lowers it', async () => {
  const files = { 'src/lib/big.ts': bigFile(1600) }
  const shrunk = await runInTree(files, { size: { 'src/lib/big.ts': 1700 } })
  assertEquals(shrunk.code, 1)
  assertStringIncludes(shrunk.text, 'shrank to 1600 lines (baseline 1700)')

  const root = await Deno.makeTempDir({ prefix: 'tp-source-layout-shrink-' })
  try {
    await Deno.mkdir(join(root, 'scripts'), { recursive: true })
    await Deno.mkdir(join(root, 'src/lib'), { recursive: true })
    await Deno.copyFile(scriptPath, join(root, 'scripts/check-source-layout.mjs'))
    const baselinePath = join(root, 'scripts/source-layout-baseline.json')
    await Deno.writeTextFile(baselinePath, JSON.stringify({ size: { 'src/lib/big.ts': 1700 } }))
    await Deno.writeTextFile(join(root, 'src/lib/big.ts'), files['src/lib/big.ts'])
    const run = (...args: string[]) =>
      new Deno.Command('node', {
        args: [join(root, 'scripts/check-source-layout.mjs'), ...args],
        stdout: 'piped',
        stderr: 'piped',
      }).output()
    assertEquals((await run('--prune')).code, 0)
    assertEquals(JSON.parse(await Deno.readTextFile(baselinePath)).size, { 'src/lib/big.ts': 1600 })
    assertEquals((await run()).code, 0)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

test('a new index.ts barrel fails', async () => {
  const result = await runInTree({ 'src/features/f/index.ts': "export * from './a.ts'\n" })
  assertEquals(result.code, 1)
  assertStringIncludes(result.text, 'barrel: src/features/f/index.ts is a new violation')
})

test('test files must match the naming grammar', async () => {
  const result = await runInTree({
    'src/a/x.parity.test.ts': OK,
    'src/a/y.spec.ts': OK,
    'src/a/z.workers-e2e.test.ts': OK,
    'src/a/w.test.support.ts': OK,
  })
  assertEquals(result.code, 1)
  assertStringIncludes(result.text, 'test-name: src/a/x.parity.test.ts is a new violation')
  assertStringIncludes(result.text, 'test-name: src/a/y.spec.ts is a new violation')
  assertEquals(result.text.includes('z.workers-e2e'), false)
  assertEquals(result.text.includes('w.test.support'), false)
})

test('a baselined entry that is fixed or gone must be dropped', async () => {
  const result = await runInTree(
    { 'src/lib/small.ts': OK, 'src/lib/ok.ts': OK },
    {
      size: { 'src/lib/small.ts': 1600, 'src/lib/gone.ts': 1700 },
      runtime: ['src/lib/ok.ts'],
      barrel: ['src/lib/index.ts'],
      'test-name': ['src/lib/old.parity.test.ts'],
    }
  )
  assertEquals(result.code, 1)
  assertStringIncludes(result.text, 'size: src/lib/small.ts is under 1500 lines')
  assertStringIncludes(result.text, 'size: src/lib/gone.ts is under 1500 lines or gone')
  assertStringIncludes(result.text, 'runtime: src/lib/ok.ts is fixed')
  assertStringIncludes(result.text, 'barrel: src/lib/index.ts is fixed')
  assertStringIncludes(result.text, 'test-name: src/lib/old.parity.test.ts is fixed')
})

test('--prune drops fixed entries and never adds new ones', async () => {
  const root = await Deno.makeTempDir({ prefix: 'tp-source-layout-prune-' })
  try {
    await Deno.mkdir(join(root, 'scripts'), { recursive: true })
    await Deno.mkdir(join(root, 'src/lib'), { recursive: true })
    await Deno.copyFile(scriptPath, join(root, 'scripts/check-source-layout.mjs'))
    const baselinePath = join(root, 'scripts/source-layout-baseline.json')
    await Deno.writeTextFile(baselinePath, JSON.stringify({ barrel: ['src/lib/index.ts'] }))
    await Deno.writeTextFile(join(root, 'src/lib/a.ts'), OK)
    const prune = () =>
      new Deno.Command('node', {
        args: [join(root, 'scripts/check-source-layout.mjs'), '--prune'],
        stdout: 'piped',
        stderr: 'piped',
      }).output()
    assertEquals((await prune()).code, 0)
    assertEquals(JSON.parse(await Deno.readTextFile(baselinePath)).barrel, [])

    await Deno.writeTextFile(join(root, 'src/lib/index.ts'), OK)
    assertEquals((await prune()).code, 1)
    assertEquals(JSON.parse(await Deno.readTextFile(baselinePath)).barrel, [])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

test('the real tree matches the committed baseline', async () => {
  const repoRoot = join(dirname(fromFileUrl(import.meta.url)), '..')
  const out = await new Deno.Command('node', {
    args: [scriptPath],
    cwd: repoRoot,
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr)
  assertEquals(out.code, 0, text)
})
