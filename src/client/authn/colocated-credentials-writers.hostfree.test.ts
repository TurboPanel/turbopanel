/**
 * Inventory of the code that writes the co-located daemon's credential files.
 *
 * Every production module that names the credentials dir or one of the daemon
 * identity files, and also writes, removes or creates anything on disk, must
 * call `assertColocatedCredentialsDirWritable` in the same top-level function
 * before its first write. A new writer that skips the guard fails here, and
 * the known writers stay listed so a new one is a deliberate change (add it to
 * the "install writers throw" test in colocated-self-repair.hostfree.test.ts).
 * Reads source files only.
 */
import { assert, assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join, relative } from '@std/path'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const REPO = join(dirname(fromFileUrl(import.meta.url)), '..', '..', '..')
const SRC = join(REPO, 'src')

/** The dir resolver, the file-name constants, or a quoted daemon identity file name. */
const NAMES_CREDENTIALS =
  /resolveColocatedLicenseCredentialsDir|COLOCATED_[A-Z_]+_FILE\b|['"`/](?:license\.id|license\.token|server\.id|server-key\.json|server-key-id)['"`]/

/** Deno calls that change the filesystem. */
const WRITES =
  /\bDeno\.(?:writeTextFile|writeFile|mkdir|remove|rename|create|open|copyFile|symlink|link|truncate|chmod|chown|makeTempFile|makeTempDir|utime)(?:Sync)?\s*\(/

const TOP_LEVEL_DECLARATION =
  /\n(?=(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|type|interface|enum)\b)/

const GUARD = 'assertColocatedCredentialsDirWritable('

/** The file that defines the guard and the constants; it writes nothing. */
const GUARD_MODULE = 'src/client/authn/colocated-credentials-dir.ts'

function isTestOnly(rel: string): boolean {
  return (
    /\.test\.tsx?$/.test(rel) ||
    rel.includes('.test.support.') ||
    rel.startsWith('src/test-fixtures/') ||
    rel.startsWith('src/testing/')
  )
}

function productionSources(dir: string, out: string[] = []): string[] {
  for (const entry of Deno.readDirSync(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory) {
      if (entry.name !== 'node_modules') productionSources(path, out)
    } else if (/\.tsx?$/.test(entry.name)) {
      const rel = relative(REPO, path)
      if (!isTestOnly(rel)) out.push(rel)
    }
  }
  return out
}

/** Source with comment lines blanked, so doc text never counts as code. */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .map((line) => (/^\s*(?:\/\/|\/\*|\*)/.test(line) ? '' : line))
    .join('\n')
}

/** Top-level declarations: a chunk starts at each unindented declaration keyword. */
function topLevelChunks(code: string): Array<{ name: string; body: string }> {
  const chunks: Array<{ name: string; body: string }> = []
  for (const block of code.split(TOP_LEVEL_DECLARATION)) {
    const name = /^(?:export\s+)?(?:async\s+)?(?:function\s*\*?|const|let|class)\s+(\w+)/.exec(
      block
    )?.[1]
    chunks.push({ name: name ?? block.split('\n')[0].slice(0, 40), body: block })
  }
  return chunks
}

type Finding = { file: string; writer: string; guarded: boolean }

/** Chunks of credential-naming files that write, and whether the guard runs first. */
function findCredentialWriters(file: string, source: string): Finding[] {
  const code = codeOnly(source)
  if (!NAMES_CREDENTIALS.test(code)) return []
  return topLevelChunks(code)
    .filter((chunk) => WRITES.test(chunk.body))
    .map((chunk) => {
      const guard = chunk.body.indexOf(GUARD)
      const write = chunk.body.search(WRITES)
      return { file, writer: chunk.name, guarded: guard >= 0 && guard < write }
    })
}

function inventory(): Finding[] {
  return productionSources(SRC)
    .sort()
    .filter((rel) => rel !== GUARD_MODULE)
    .flatMap((rel) => findCredentialWriters(rel, Deno.readTextFileSync(join(REPO, rel))))
}

test('every writer of the co-located credentials dir calls the guard before writing', () => {
  const unguarded = inventory().filter((f) => !f.guarded)
  assertEquals(unguarded, [], 'call assertColocatedCredentialsDirWritable(dir) before any write')
})

test('the known co-located credential writers are exactly these', () => {
  assertEquals(
    inventory().map((f) => `${f.file}#${f.writer}`),
    [
      'src/client/authn/install-state.ts#clearColocatedDaemonIdentityFiles',
      'src/client/authn/install-state.ts#persistColocatedLicenseCredentials',
    ]
  )
})

test('the guard module itself writes nothing', () => {
  const code = codeOnly(Deno.readTextFileSync(join(REPO, GUARD_MODULE)))
  assert(!WRITES.test(code))
})

test('the scan flags a writer that skips the guard or calls it too late', () => {
  const missing = [
    "import { resolveColocatedLicenseCredentialsDir } from './colocated-credentials-dir.ts'",
    'export async function sneak(): Promise<void> {',
    '  const dir = resolveColocatedLicenseCredentialsDir()',
    "  await Deno.writeTextFile(`${dir}/license.id`, 'x')",
    '}',
  ].join('\n')
  assertEquals(findCredentialWriters('x.ts', missing), [
    { file: 'x.ts', writer: 'sneak', guarded: false },
  ])

  const late = [
    'export function late(dir: string): void {',
    '  Deno.removeSync(`${dir}/server.id`)',
    '  assertColocatedCredentialsDirWritable(dir)',
    '}',
  ].join('\n')
  assertEquals(findCredentialWriters('y.ts', late), [
    { file: 'y.ts', writer: 'late', guarded: false },
  ])

  const good = [
    'export async function ok(dir: string): Promise<void> {',
    '  assertColocatedCredentialsDirWritable(dir)',
    '  await Deno.mkdir(dir, { recursive: true })',
    "  await Deno.writeTextFile(`${dir}/server.id`, 'x')",
    '}',
  ].join('\n')
  assertEquals(findCredentialWriters('z.ts', good), [{ file: 'z.ts', writer: 'ok', guarded: true }])
})

test('a file that writes but never names the credentials is out of scope', () => {
  const unrelated = "export async function log(p: string) { await Deno.writeTextFile(p, 'x') }"
  assertEquals(findCredentialWriters('w.ts', unrelated), [])
})
