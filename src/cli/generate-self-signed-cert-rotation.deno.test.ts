/**
 * Script-level coverage for the CA rotation path of generate-self-signed-cert.mjs
 * (kept outside src/lib/tls, where Platform CA names are not allowed).
 */

import { assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'

const test = Deno.test.bind(Deno)

const here = dirname(fromFileUrl(import.meta.url))
const script = join(here, '../../scripts/generate-self-signed-cert.mjs')

async function run(dirs: { stateDir: string; certsDir: string }, extraEnv: Record<string, string>) {
  const out = await new Deno.Command('node', {
    args: [script],
    env: {
      ...Deno.env.toObject(),
      TURBOPANEL_STATE_DIR: dirs.stateDir,
      TURBOPANEL_TLS_CERTS_DIR: dirs.certsDir,
      ...extraEnv,
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  return {
    success: out.success,
    text: `${new TextDecoder().decode(out.stderr)}\n${new TextDecoder().decode(out.stdout)}`,
  }
}

async function mode(path: string): Promise<number> {
  return ((await Deno.stat(path)).mode ?? 0) & 0o777
}

test('a CA rotation keeps the old root, lists the new one first and leaves regular files', async () => {
  const root = await Deno.makeTempDir({ prefix: 'tp-ssc-' })
  const stateDir = join(root, 'state')
  const certsDir = join(root, 'certs')
  await Deno.mkdir(stateDir, { recursive: true })
  await Deno.mkdir(certsDir, { recursive: true })
  const first = await run({ stateDir, certsDir }, {})
  assertEquals(first.success, true, first.text)
  try {
    const tlsDir = join(stateDir, 'tls')
    const oldCrt = (await Deno.readTextFile(join(tlsDir, 'ca.crt'))).trim()
    const rotated = await run({ stateDir, certsDir }, { TURBOPANEL_TLS_CA_ROTATE: '1' })
    assertEquals(rotated.success, true, rotated.text)

    const newCrt = (await Deno.readTextFile(join(tlsDir, 'ca.crt'))).trim()
    if (newCrt === oldCrt) throw new Error('expected a new CA certificate')
    assertEquals((await Deno.readTextFile(join(tlsDir, 'ca-retired.pem'))).trim(), oldCrt)
    assertEquals(
      (await Deno.readTextFile(join(tlsDir, 'ca-bundle.pem'))).trim(),
      `${newCrt}\n${oldCrt}`
    )

    for (const name of ['ca.key', 'ca.crt', 'ca-bundle.pem', 'ca-retired.pem']) {
      assertEquals((await Deno.lstat(join(tlsDir, name))).isFile, true, name)
    }
    assertEquals(await mode(join(tlsDir, 'ca.key')), 0o640)
    assertEquals(await mode(join(certsDir, 'self-signed.key')), 0o640)

    const names: string[] = []
    for await (const d of Deno.readDir(tlsDir)) names.push(d.name)
    for await (const d of Deno.readDir(certsDir)) names.push(d.name)
    assertEquals(
      names.filter((n) => n.startsWith('.')),
      []
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
