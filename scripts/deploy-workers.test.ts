/**
 * Workers deploy (`pnpm deploy`, `pnpm deploy:testing|staging|live`): migrate first, stamp
 * the commit, never ship `revision: unknown`.
 */
import { assertEquals, assertThrows } from '@std/assert'
import { planDeploy, resolveRevision, runDeploy } from './deploy-workers.mjs'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const CI_SHA = 'a'.repeat(40)
const HEAD_SHA = 'b'.repeat(40)
const ENV = {
  CLOUDFLARE_ENV: 'testing',
  TURBOPANEL_DATABASE_URL: 'postgresql://migrate@db.example.com:5432/testing',
}

test('the Workers Builds commit wins over the checkout HEAD', () => {
  assertEquals(
    resolveRevision({ WORKERS_CI_COMMIT_SHA: CI_SHA }, () => HEAD_SHA),
    CI_SHA
  )
  assertEquals(
    resolveRevision({}, () => HEAD_SHA),
    HEAD_SHA
  )
})

test('a deploy that cannot name its commit is refused', () => {
  assertThrows(() => resolveRevision({}, () => ''), Error, 'TURBOPANEL_REVISION')
  assertThrows(
    () => resolveRevision({ WORKERS_CI_COMMIT_SHA: 'unknown' }, () => HEAD_SHA),
    Error,
    'TURBOPANEL_REVISION'
  )
})

test('the plan migrates, then deploys the env with the revision stamped', () => {
  const steps = planDeploy({ ...ENV, WORKERS_CI_COMMIT_SHA: CI_SHA }, () => HEAD_SHA)
  assertEquals(
    steps.map((s) => (s.argv[0] === 'pnpm' ? s.argv.join(' ') : s.argv.slice(2).join(' '))),
    ['pnpm run migrate', `deploy --env testing --minify --var TURBOPANEL_REVISION:${CI_SHA}`]
  )
})

test('the plan refuses a missing env or database URL', () => {
  assertThrows(
    () => planDeploy({ ...ENV, CLOUDFLARE_ENV: '' }, () => HEAD_SHA),
    Error,
    'CLOUDFLARE_ENV'
  )
  assertThrows(
    () => planDeploy({ ...ENV, CLOUDFLARE_ENV: 'Live!' }, () => HEAD_SHA),
    Error,
    'CLOUDFLARE_ENV'
  )
  assertThrows(
    () => planDeploy({ CLOUDFLARE_ENV: 'testing' }, () => HEAD_SHA),
    Error,
    'TURBOPANEL_DATABASE_URL'
  )
})

test('a failed migrate stops the deploy before wrangler runs', () => {
  const ran: string[][] = []
  assertThrows(
    () =>
      runDeploy(
        { ...ENV },
        {
          gitHead: () => HEAD_SHA,
          run: (argv: string[]) => {
            ran.push(argv)
            return argv[0] === 'pnpm' ? 1 : 0
          },
        }
      ),
    Error,
    'migrate failed'
  )
  assertEquals(ran.length, 1)
})

test('a clean run migrates then deploys', () => {
  const ran: string[][] = []
  runDeploy(
    { ...ENV },
    {
      gitHead: () => HEAD_SHA,
      run: (argv: string[]) => {
        ran.push(argv)
        return 0
      },
    }
  )
  assertEquals(ran.length, 2)
  assertEquals(ran[1].at(-1), `TURBOPANEL_REVISION:${HEAD_SHA}`)
})

test('each hosted environment has a deploy script that names it and goes through the migrate-first deploy', () => {
  const pkg = JSON.parse(Deno.readTextFileSync(new URL('../package.json', import.meta.url)))
  for (const name of ['testing', 'staging', 'live']) {
    assertEquals(
      pkg.scripts[`deploy:${name}`],
      `CLOUDFLARE_ENV=${name} node scripts/deploy-workers.mjs`
    )
  }
  const wrangler = JSON.parse(
    Deno.readTextFileSync(new URL('../wrangler.jsonc', import.meta.url))
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,(\s*[}\]])/g, '$1')
  )
  assertEquals(Object.keys(wrangler.env).sort(), ['live', 'staging', 'testing'])
})
