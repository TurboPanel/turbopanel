/**
 * Script-level coverage for generate-self-signed-cert.mjs: the idempotent
 * fast path must still refuse a readable-but-undecodable platform CA.
 */

import { assertEquals, assertRejects } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const here = dirname(fromFileUrl(import.meta.url))
const script = join(here, '../../../scripts/generate-self-signed-cert.mjs')

async function runGenerator(dirs: {
  stateDir: string
  certsDir: string
}): Promise<{ success: boolean; stderr: string; stdout: string }> {
  const proc = new Deno.Command('node', {
    args: [script],
    env: {
      ...Deno.env.toObject(),
      TURBOPANEL_STATE_DIR: dirs.stateDir,
      TURBOPANEL_TLS_CERTS_DIR: dirs.certsDir,
    },
    stdout: 'piped',
    stderr: 'piped',
  })
  const out = await proc.output()
  return {
    success: out.success,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  }
}

async function setupGeneratedCerts(): Promise<{
  root: string
  stateDir: string
  certsDir: string
}> {
  const root = await Deno.makeTempDir({ prefix: 'tp-ssc-' })
  const stateDir = join(root, 'state')
  const certsDir = join(root, 'certs')
  await Deno.mkdir(stateDir, { recursive: true })
  await Deno.mkdir(certsDir, { recursive: true })
  const first = await runGenerator({ stateDir, certsDir })
  if (!first.success) {
    throw new Error(`expected first generate to succeed: ${first.stderr}\n${first.stdout}`)
  }
  return { root, stateDir, certsDir }
}

test('fast path refuses a readable-but-undecodable ca.crt when the leaf is up to date', async () => {
  const { root, stateDir, certsDir } = await setupGeneratedCerts()
  try {
    await Deno.writeTextFile(join(stateDir, 'tls', 'ca.crt'), 'not a certificate\n')
    const second = await runGenerator({ stateDir, certsDir })
    assertEquals(second.success, false)
    const combined = `${second.stderr}\n${second.stdout}`
    if (!combined.includes('unreadable or undecodable')) {
      throw new Error(`expected decode failure, got: ${combined}`)
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

test('fast path refuses an invalid ca.key when the leaf is up to date', async () => {
  const { root, stateDir, certsDir } = await setupGeneratedCerts()
  try {
    await Deno.writeTextFile(
      join(stateDir, 'tls', 'ca.key'),
      '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n'
    )
    const second = await runGenerator({ stateDir, certsDir })
    assertEquals(second.success, false)
    const combined = `${second.stderr}\n${second.stdout}`
    if (!combined.includes('unreadable or undecodable')) {
      throw new Error(`expected key decode failure, got: ${combined}`)
    }
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

async function mode(path: string): Promise<number> {
  return ((await Deno.stat(path)).mode ?? 0) & 0o777
}

async function plantVictim(root: string): Promise<string> {
  const victim = join(root, 'victim.txt')
  await Deno.writeTextFile(victim, 'root-owned original\n')
  await Deno.chmod(victim, 0o600)
  return victim
}

async function assertVictimUntouched(victim: string) {
  assertEquals(await Deno.readTextFile(victim), 'root-owned original\n')
  assertEquals(await mode(victim), 0o600)
}

test('first run writes regular leaf files at the documented modes and leaves no temp files', async () => {
  const { root, stateDir, certsDir } = await setupGeneratedCerts()
  try {
    for (const name of ['self-signed.crt', 'self-signed.key']) {
      assertEquals((await Deno.lstat(join(certsDir, name))).isFile, true)
    }
    assertEquals(await mode(join(certsDir, 'self-signed.key')), 0o640)
    assertEquals(await mode(join(stateDir, 'tls', 'ca.key')), 0o640)
    const names = []
    for await (const d of Deno.readDir(certsDir)) names.push(d.name)
    for await (const d of Deno.readDir(join(stateDir, 'tls'))) {
      names.push(d.name)
    }
    assertEquals(
      names.filter((n) => n.startsWith('.')),
      []
    )
    assertEquals(names.includes('server.csr'), false)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

test('a dangling planted key link is refused and its target is not created', async () => {
  const root = await Deno.makeTempDir({ prefix: 'tp-ssc-' })
  try {
    const stateDir = join(root, 'state')
    const certsDir = join(root, 'certs')
    await Deno.mkdir(stateDir, { recursive: true })
    await Deno.mkdir(certsDir, { recursive: true })
    const target = join(root, 'must-not-exist')
    await Deno.symlink(target, join(certsDir, 'self-signed.key'))
    const run = await runGenerator({ stateDir, certsDir })
    assertEquals(run.success, false)
    await assertRejects(() => Deno.lstat(target), Deno.errors.NotFound)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

test('a planted crt link to a file is refused and the file is untouched', async () => {
  const root = await Deno.makeTempDir({ prefix: 'tp-ssc-' })
  try {
    const stateDir = join(root, 'state')
    const certsDir = join(root, 'certs')
    await Deno.mkdir(stateDir, { recursive: true })
    await Deno.mkdir(certsDir, { recursive: true })
    const victim = await plantVictim(root)
    await Deno.symlink(victim, join(certsDir, 'self-signed.crt'))
    const run = await runGenerator({ stateDir, certsDir })
    assertEquals(run.success, false)
    await assertVictimUntouched(victim)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

test('an up-to-date leaf whose key became a link elsewhere is refused without chmod', async () => {
  const { root, stateDir, certsDir } = await setupGeneratedCerts()
  try {
    const victim = await plantVictim(root)
    await Deno.remove(join(certsDir, 'self-signed.key'))
    await Deno.symlink(victim, join(certsDir, 'self-signed.key'))
    const run = await runGenerator({ stateDir, certsDir })
    assertEquals(run.success, false)
    await assertVictimUntouched(victim)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

test("the role's links to platform-ca.* are accepted and their files keep their mode", async () => {
  const { root, stateDir, certsDir } = await setupGeneratedCerts()
  try {
    for (const ext of ['crt', 'key']) {
      const real = join(certsDir, `platform-ca.${ext}`)
      await Deno.rename(join(certsDir, `self-signed.${ext}`), real)
      await Deno.symlink(real, join(certsDir, `self-signed.${ext}`))
    }
    await Deno.chmod(join(certsDir, 'platform-ca.key'), 0o600)
    const run = await runGenerator({ stateDir, certsDir })
    assertEquals(run.success, true, `${run.stderr}\n${run.stdout}`)
    assertEquals(await mode(join(certsDir, 'platform-ca.key')), 0o600)
    assertEquals((await Deno.lstat(join(certsDir, 'self-signed.key'))).isSymlink, true)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

test('a regeneration replaces a role link instead of writing through it', async () => {
  const { root, stateDir, certsDir } = await setupGeneratedCerts()
  try {
    const victim = await plantVictim(root)
    await Deno.remove(join(certsDir, 'self-signed.crt'))
    await Deno.remove(join(certsDir, 'self-signed.key'))
    for (const ext of ['crt', 'key']) {
      await Deno.symlink(join(certsDir, `platform-ca.${ext}`), join(certsDir, `self-signed.${ext}`))
    }
    // Dangling role links: nothing to read, so the leaf is regenerated.
    const run = await runGenerator({ stateDir, certsDir })
    assertEquals(run.success, true, `${run.stderr}\n${run.stdout}`)
    assertEquals((await Deno.lstat(join(certsDir, 'self-signed.key'))).isFile, true)
    await assertVictimUntouched(victim)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

test('a certs folder that is a link is refused', async () => {
  const root = await Deno.makeTempDir({ prefix: 'tp-ssc-' })
  try {
    const stateDir = join(root, 'state')
    const realDir = join(root, 'elsewhere')
    const certsDir = join(root, 'certs')
    await Deno.mkdir(stateDir, { recursive: true })
    await Deno.mkdir(realDir, { recursive: true })
    await Deno.symlink(realDir, certsDir)
    const run = await runGenerator({ stateDir, certsDir })
    assertEquals(run.success, false)
    const left = []
    for await (const d of Deno.readDir(realDir)) left.push(d.name)
    assertEquals(left, [])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

test('a platform CA folder that is a link is refused', async () => {
  const root = await Deno.makeTempDir({ prefix: 'tp-ssc-' })
  try {
    const stateDir = join(root, 'state')
    const certsDir = join(root, 'certs')
    const realDir = join(root, 'elsewhere')
    await Deno.mkdir(stateDir, { recursive: true })
    await Deno.mkdir(certsDir, { recursive: true })
    await Deno.mkdir(realDir, { recursive: true })
    await Deno.symlink(realDir, join(stateDir, 'tls'))
    const run = await runGenerator({ stateDir, certsDir })
    assertEquals(run.success, false)
    const left = []
    for await (const d of Deno.readDir(realDir)) left.push(d.name)
    assertEquals(left, [])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

test('minting a CA does not write through a planted dangling ca.key link', async () => {
  const { root, stateDir, certsDir } = await setupGeneratedCerts()
  try {
    const target = join(root, 'must-not-exist')
    const caKey = join(stateDir, 'tls', 'ca.key')
    await Deno.remove(caKey)
    await Deno.remove(join(stateDir, 'tls', 'ca.crt'))
    await Deno.symlink(target, caKey)
    const run = await runGenerator({ stateDir, certsDir })
    assertEquals(run.success, false)
    await assertRejects(() => Deno.lstat(target), Deno.errors.NotFound)
    assertEquals((await Deno.lstat(caKey)).isSymlink, true)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

async function runRotate(dirs: { stateDir: string; certsDir: string }) {
  const out = await new Deno.Command('node', {
    args: [script],
    env: {
      ...Deno.env.toObject(),
      TURBOPANEL_STATE_DIR: dirs.stateDir,
      TURBOPANEL_TLS_CERTS_DIR: dirs.certsDir,
      TURBOPANEL_TLS_CA_ROTATE: '1',
    },
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  return {
    success: out.success,
    text: `${new TextDecoder().decode(out.stderr)}\n${new TextDecoder().decode(out.stdout)}`,
  }
}

test('a CA rotation keeps the old root, lists the new one first and leaves regular files', async () => {
  const { root, stateDir, certsDir } = await setupGeneratedCerts()
  try {
    const tlsDir = join(stateDir, 'tls')
    const oldCrt = (await Deno.readTextFile(join(tlsDir, 'ca.crt'))).trim()
    const run = await runRotate({ stateDir, certsDir })
    assertEquals(run.success, true, run.text)

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

test('a leaf key with a second hard link is refused and its mode is kept', async () => {
  const { root, stateDir, certsDir } = await setupGeneratedCerts()
  try {
    const victim = await plantVictim(root)
    const key = join(certsDir, 'self-signed.key')
    await Deno.remove(key)
    await Deno.link(victim, key)
    const run = await runGenerator({ stateDir, certsDir })
    assertEquals(run.success, false)
    await assertVictimUntouched(victim)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
