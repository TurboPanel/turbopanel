/**
 * Every daemon feature name this control plane gates on must be in
 * `DAEMON_WIRE_FEATURES`. The hello handler keeps only the names in that list
 * (`filterHelloFeatures`), so a gate on a name outside it would never see the
 * name and a capable daemon would look incapable.
 */
import { assert } from '@std/assert'
import { test } from '@std/testing/bdd'
import { DAEMON_WIRE_FEATURES } from './version-wire.ts'

const SRC_ROOT = new URL('../', import.meta.url)

/** `const NAME_FEATURE = 'some-feature-v1'` (optionally typed), exported or not. */
const FEATURE_CONSTANT =
  /\bconst\s+([A-Z][A-Z0-9_]*_FEATURE)\s*(?::[^=]+)?=\s*['"]([a-z0-9][a-z0-9._-]*)['"]/g

/** `…features….includes('some-feature-v1')` written with the literal inline. */
const INLINE_LITERAL =
  /[Ff]eatures[^\n;]{0,60}\.(?:includes|has)\(\s*['"]([a-z0-9][a-z0-9-]*-v\d+)['"]/g

async function* sourceFiles(dir: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name === 'node_modules') continue
    const child = new URL(entry.name + (entry.isDirectory ? '/' : ''), dir)
    if (entry.isDirectory) {
      yield* sourceFiles(child)
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      yield child
    }
  }
}

async function gatedFeatureNames(): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for await (const file of sourceFiles(SRC_ROOT)) {
    const text = await Deno.readTextFile(file)
    const where = file.pathname.slice(SRC_ROOT.pathname.length)
    for (const match of text.matchAll(FEATURE_CONSTANT)) {
      found.set(match[2]!, `${where} (${match[1]})`)
    }
    for (const match of text.matchAll(INLINE_LITERAL)) {
      found.set(match[1]!, `${where} (inline literal)`)
    }
  }
  return found
}

test('every feature name this panel gates on is in DAEMON_WIRE_FEATURES', async () => {
  const gated = await gatedFeatureNames()
  // A scan that finds almost nothing would pass for the wrong reason.
  assert(gated.size > 20, `expected to find the gate constants, found ${gated.size}`)
  const advertised = new Set<string>(DAEMON_WIRE_FEATURES)
  const missing = [...gated].filter(([name]) => !advertised.has(name))
  assert(
    missing.length === 0,
    `These feature names are gated on but not in DAEMON_WIRE_FEATURES, so a hello would drop ` +
      `them and a capable daemon would look incapable. Add each to DAEMON_WIRE_FEATURES in ` +
      `src/lib/version-wire.ts here and in the daemon repo: ` +
      missing.map(([name, where]) => `${name} in ${where}`).join('; ')
  )
})
