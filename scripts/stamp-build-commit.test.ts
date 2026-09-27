/**
 * The Workers Builds commit stamp: wrangler.jsonc runs it before bundling, it
 * rewrites only `BUILD_INFO.commit`, and it never runs where
 * `WORKERS_CI_COMMIT_SHA` is absent.
 */
import { assert, assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'
import { normalizeCommit, stampBuildCommit } from './stamp-build-commit.mjs'
import { stripJsonc } from './check-deploy-env.mjs'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const repoRoot = join(dirname(fromFileUrl(import.meta.url)), '..')
const SHA = '18ad2b07c0ffee00000000000000000000000000'

test('stampBuildCommit rewrites BUILD_INFO.commit in the real build-info.ts', async () => {
  const source = await Deno.readTextFile(join(repoRoot, 'src/app/build-info.ts'))
  const stamped = stampBuildCommit(source, SHA)
  assert(stamped !== null)
  assert(stamped.includes(`  commit: '${SHA}',`))
  // Nothing else moved: undoing the one replacement gives the source back.
  assertEquals(stamped.replace(`commit: '${SHA}',`, "commit: '',"), source)
  // Re-stamping an already stamped file replaces the previous commit.
  const other = 'a'.repeat(40)
  assertEquals(stampBuildCommit(stamped, other), stamped.replace(SHA, other))
})

test('stampBuildCommit refuses a file without the stamp site', () => {
  assertEquals(stampBuildCommit('export const x = 1\n', SHA), null)
})

test('normalizeCommit accepts only a full 40-hex commit', () => {
  assertEquals(normalizeCommit(` ${SHA.toUpperCase()} `), SHA)
  assertEquals(normalizeCommit('18ad2b0'), null)
  assertEquals(normalizeCommit('not-a-sha'.padEnd(40, 'x')), null)
  assertEquals(normalizeCommit(undefined), null)
  assertEquals(normalizeCommit(''), null)
})

test('wrangler.jsonc stamps only inside Workers Builds and names each deployment', async () => {
  const config = JSON.parse(stripJsonc(await Deno.readTextFile(join(repoRoot, 'wrangler.jsonc'))))
  assertEquals(
    config.build?.command,
    '[ -z "$WORKERS_CI_COMMIT_SHA" ] || node scripts/stamp-build-commit.mjs'
  )
  assertEquals(config.env.testing.vars.TURBOPANEL_ENVIRONMENT, 'testing')
  assertEquals(config.env.live.vars.TURBOPANEL_ENVIRONMENT, 'live')
  // Local `wrangler dev` (top level) names no deployment.
  assertEquals(config.vars?.TURBOPANEL_ENVIRONMENT, undefined)
})

test('the stamp command is a no-op without WORKERS_CI_COMMIT_SHA', async () => {
  const out = await new Deno.Command('sh', {
    args: ['-c', '[ -z "$WORKERS_CI_COMMIT_SHA" ] || echo would-stamp'],
    env: { WORKERS_CI_COMMIT_SHA: '' },
    stdout: 'piped',
  }).output()
  assertEquals(out.code, 0)
  assertEquals(new TextDecoder().decode(out.stdout), '')
})
