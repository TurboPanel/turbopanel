import { assertEquals } from '@std/assert'
import { join, relative } from '@std/path'
import { it } from '@std/testing/bdd'

/**
 * Source scan behind the compiled instance's scoped `--allow-env` (deno.json
 * `compile` / `compile:dev`). Under `--ignore-env` a name missing from the
 * list reads as unset instead of throwing, so a forgotten entry would quietly
 * drop an operator setting; this test makes it fail loudly instead.
 *
 * Names Cloudflare provides as Workers bindings or `vars` (wrangler.jsonc)
 * are not process env on Deno and are skipped.
 */
const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
const NAME = String.raw`[A-Z][A-Z0-9_]*`
const Q = `['"]`

const READ_PATTERNS: readonly RegExp[] = [
  // Deno.env.get('X') / Deno.env.has('X') and the readEnv('X') wrappers
  new RegExp(String.raw`(?:Deno\.env\.(?:get|has)|\breadEnv)\(\s*${Q}(${NAME})${Q}`, 'g'),
  // env.X / env?.X / process.env.X on an env bag, skipping assignments
  new RegExp(String.raw`\benv(?:\?\.|\.)(${NAME})\b(?!\s*=(?!=))`, 'g'),
  // env['X'] / env?.['X']
  new RegExp(String.raw`\benv(?:\?\.)?\[\s*${Q}(${NAME})${Q}\s*\](?!\s*=(?!=))`, 'g'),
  // constants naming a variable read elsewhere: `STRIPE_SECRET_KEY_ENV = 'X'`
  new RegExp(String.raw`\b[A-Z0-9_]*_ENV(?:_NAME)?\s*=\s*${Q}(${NAME})${Q}`, 'g'),
]

/** Reads by a computed name; each must sit in a wrapper listed here. */
const DYNAMIC_READ = /(?:Deno\.env\.(?:get|has)|process\.env)\s*[([]\s*[^'"\s)\]]/
const DYNAMIC_READ_WRAPPERS = new Set(['lib/logger.ts', 'db/url.ts'])

async function compileEnvAllowlists(): Promise<Record<string, string[]>> {
  const denoJson = JSON.parse(await Deno.readTextFile(join(ROOT, 'deno.json')))
  const out: Record<string, string[]> = {}
  for (const task of ['compile', 'compile:dev']) {
    const match = /(?:^|\s)--allow-env=(\S+)/.exec(denoJson.tasks[task])
    out[task] = match?.[1]?.split(',') ?? []
  }
  return out
}

async function workersBindingNames(): Promise<Set<string>> {
  const text = await Deno.readTextFile(join(ROOT, 'wrangler.jsonc'))
  const names = new Set<string>()
  const pattern = new RegExp(
    String.raw`"(?:binding|name)"\s*:\s*"(${NAME})"|"(${NAME})"\s*:\s*"`,
    'g'
  )
  for (const match of text.matchAll(pattern)) names.add(match[1] ?? match[2] ?? '')
  return names
}

function covered(allowlist: readonly string[], name: string): boolean {
  return allowlist.some((entry) =>
    entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : name === entry
  )
}

function literalEnvReads(text: string, file: string, into: Map<string, string>): void {
  for (const pattern of READ_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1]
      if (!name || into.has(name)) continue
      into.set(name, `${file}:${text.slice(0, match.index).split('\n').length}`)
    }
  }
}

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory) yield* sourceFiles(path)
    else if (/\.(ts|tsx|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)) yield path
  }
}

it('every env var the instance source reads is on the compiled --allow-env list', async () => {
  const reads = new Map<string, string>()
  const dynamic: string[] = []
  for await (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path)
    const text = await Deno.readTextFile(path)
    literalEnvReads(text, file, reads)
    if (!DYNAMIC_READ_WRAPPERS.has(file) && DYNAMIC_READ.test(text)) dynamic.push(file)
  }
  const bindings = await workersBindingNames()
  for (const [task, allowlist] of Object.entries(await compileEnvAllowlists())) {
    assertEquals(allowlist.length > 0, true, `${task} must carry --allow-env=<names>`)
    const uncovered = [...reads]
      .filter(([name]) => !bindings.has(name) && !covered(allowlist, name))
      .map(([name, at]) => `${name} (${at})`)
      .sort((a, b) => a.localeCompare(b))
    assertEquals(uncovered, [], `add these to --allow-env in deno.json ${task}`)
  }
  assertEquals(dynamic, [], 'read env by a literal name (or a listed wrapper) so this scan sees it')
  for (const name of ['PATH', 'SMTP_PORT', 'TURBOPANEL_DATABASE_URL']) {
    assertEquals(reads.has(name), true, `scan lost ${name}`)
  }
})

it('the scan recognises each read shape and ignores child-env writes', () => {
  const reads = new Map<string, string>()
  literalEnvReads(
    [
      "Deno.env.get('A_ONE')",
      "readEnv('A_TWO')",
      'env.A_THREE?.trim()',
      "env?.['A_FOUR']",
      "export const X_ENV = 'A_FIVE'",
      'env.B_WRITE = value',
    ].join('\n'),
    'fixture.ts',
    reads
  )
  assertEquals(
    [...reads.keys()].sort((a, b) => a.localeCompare(b)),
    ['A_FIVE', 'A_FOUR', 'A_ONE', 'A_THREE', 'A_TWO']
  )
  assertEquals(covered(['TURBOPANEL_*'], 'TURBOPANEL_SECRET'), true)
  assertEquals(covered(['TURBOPANEL_*', 'PATH'], 'AWS_SECRET_ACCESS_KEY'), false)
})
