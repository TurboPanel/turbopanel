/**
 * Release builds and installs run against the lockfiles as committed, so the
 * shipped dependencies (and the SBOM built from pnpm-lock.yaml) are the
 * reviewed ones (audit L3/L4). Without `--frozen`, `deno compile` silently
 * adds a missing deno.lock entry during the release build.
 */
import { assert, assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { dirname, fromFileUrl, join } from '@std/path'

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), '..')

async function ciLines(): Promise<{ file: string; line: string }[]> {
  const files: string[] = []
  for (const dir of ['.github/workflows', '.github/actions/setup-toolchain']) {
    for await (const entry of Deno.readDir(join(repoRoot, dir))) {
      if (/\.ya?ml$/.test(entry.name)) files.push(join(dir, entry.name))
    }
  }
  const out: { file: string; line: string }[] = []
  for (const file of files) {
    for (const line of (await Deno.readTextFile(join(repoRoot, file))).split('\n')) {
      if (!/^(#|description:)/.test(line.trim())) out.push({ file, line })
    }
  }
  return out
}

describe('frozen lockfiles in release builds', () => {
  it('the release compile task is --frozen', async () => {
    const config = JSON.parse(await Deno.readTextFile(join(repoRoot, 'deno.json'))) as {
      tasks: Record<string, string>
    }
    assert(config.tasks.compile.startsWith('deno compile --frozen '))
  })

  it('no workflow installs or compiles without the frozen lockfile', async () => {
    const unfrozen = (await ciLines()).filter(
      ({ line }) =>
        (/\bdeno (install|cache|compile)\b/.test(line) && !/--frozen/.test(line)) ||
        (/\bpnpm (install|i)\b/.test(line) && !/--frozen-lockfile/.test(line))
    )
    assertEquals(unfrozen, [])
  })

  it('the release workflow generates the SBOM from the lockfile only', async () => {
    const text = await Deno.readTextFile(join(repoRoot, '.github/workflows/release.yml'))
    assert(/pnpm sbom [^\n]*--lockfile-only/.test(text))
    assert(text.indexOf('pnpm sbom') > text.indexOf('pnpm install --prod --frozen-lockfile'))
  })
})
