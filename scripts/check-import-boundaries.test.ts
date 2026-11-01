/**
 * The self-hosted ingress rule must refuse every importer outside
 * `src/platform/deno/**`, test files included, and the real tree must stay
 * clean. The script derives its root from its own location, so each case
 * copies it into a throwaway tree.
 */
import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const scriptPath = join(dirname(fromFileUrl(import.meta.url)), 'check-import-boundaries.mjs')

async function runInTree(files: Record<string, string>) {
  const root = await Deno.makeTempDir({ prefix: 'tp-import-boundaries-' })
  try {
    await Deno.mkdir(join(root, 'scripts'), { recursive: true })
    await Deno.copyFile(scriptPath, join(root, 'scripts/check-import-boundaries.mjs'))
    for (const [rel, body] of Object.entries(files)) {
      const abs = join(root, rel)
      await Deno.mkdir(dirname(abs), { recursive: true })
      await Deno.writeTextFile(abs, body)
    }
    const out = await new Deno.Command('node', {
      args: [join(root, 'scripts/check-import-boundaries.mjs')],
      stdout: 'piped',
      stderr: 'piped',
    }).output()
    return {
      code: out.code,
      text: new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr),
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

const INGRESS = { 'src/platform/deno/ingress/y.ts': 'export const y = 1\n' }

test('a surface or its test file importing the ingress directory fails', async () => {
  for (const importer of ['src/admin/x.ts', 'src/admin/x.test.ts', 'src/features/f/x.ts']) {
    const depth = importer.split('/').length - 2
    const up = '../'.repeat(depth)
    const result = await runInTree({
      ...INGRESS,
      [importer]: `import { y } from '${up}platform/deno/ingress/y.ts'\nexport const z = y\n`,
    })
    assertEquals(result.code, 1, importer)
    assertStringIncludes(result.text, `${importer} imports self-hosted ingress module`)
  }
})

test('the Deno composition root may import the ingress directory', async () => {
  const result = await runInTree({
    ...INGRESS,
    'src/platform/deno/server.ts': "import { y } from './ingress/y.ts'\nexport const z = y\n",
    'src/deno.ts': "import { y } from './platform/deno/ingress/y.ts'\nexport const z = y\n",
  })
  assertEquals(result.code, 0, result.text)
})

test('the real tree passes', async () => {
  const root = join(dirname(scriptPath), '..')
  const out = await new Deno.Command('node', {
    args: [scriptPath],
    cwd: root,
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  assert(out.code === 0, new TextDecoder().decode(out.stderr))
})
