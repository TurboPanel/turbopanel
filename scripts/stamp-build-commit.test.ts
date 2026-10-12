/**
 * The Workers Builds commit and version stamp: wrangler.jsonc runs it before
 * bundling, it rewrites only `BUILD_INFO.commit` and the `version` fields,
 * and it never runs where `WORKERS_CI_COMMIT_SHA` is absent.
 */
import { assert, assertEquals } from '@std/assert'
import { dirname, fromFileUrl, join } from '@std/path'
import {
  normalizeCommit,
  resolveBuildVersion,
  stampBuildCommit,
  stampVersion,
  versionFromDescribe,
  versionFromPromotionMessage,
} from './stamp-build-commit.mjs'
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

const merge = (title: string) => `Merge pull request #440 from TurboPanel/trunk\n\n${title}\n`

test('versionFromPromotionMessage reads the release a staging / live merge names', () => {
  assertEquals(versionFromPromotionMessage(merge('Release Candidate 0.1.9-rc.2')), '0.1.9')
  assertEquals(versionFromPromotionMessage(merge('Release 0.1.9')), '0.1.9')
  assertEquals(versionFromPromotionMessage(merge('Release 0.1.10')), '0.1.10')
  assertEquals(versionFromPromotionMessage('fix(billing): Release 0.1.9 notes'), null)
  assertEquals(versionFromPromotionMessage('Merge pull request #1 from x/y'), null)
  assertEquals(versionFromPromotionMessage(undefined), null)
})

test('versionFromDescribe gives the version trunk is building', () => {
  // An rc is in flight: trunk is still building that version.
  assertEquals(versionFromDescribe('v0.1.9-rc.1\n'), '0.1.9')
  assertEquals(versionFromDescribe('v0.1.9-rc.1-3-gabc1234'), '0.1.9')
  // Past a release: the next patch.
  assertEquals(versionFromDescribe('v0.1.9-4-gabc1234'), '0.1.10')
  // Exactly on the release commit.
  assertEquals(versionFromDescribe('v0.1.9'), '0.1.9')
  assertEquals(versionFromDescribe('canary'), null)
  assertEquals(versionFromDescribe(''), null)
})

test('resolveBuildVersion: staging and live read the merge title, everything else the tags', () => {
  const git =
    (out: Record<string, string | Error>) =>
    (args: string[]): string => {
      const value = out[args[0]!]
      if (value === undefined || value instanceof Error) throw value ?? new Error('no git')
      return value
    }
  const both = git({ log: merge('Release Candidate 0.1.9-rc.2'), describe: 'v0.1.8-7-gabc1234' })
  assertEquals(resolveBuildVersion('staging', both), '0.1.9')
  assertEquals(resolveBuildVersion('live', git({ log: merge('Release 0.1.9') })), '0.1.9')
  // Trunk never trusts the HEAD message.
  assertEquals(resolveBuildVersion('trunk', both), '0.1.9')
  assertEquals(resolveBuildVersion(undefined, git({ describe: 'v0.1.9-rc.1-2-gabc1234' })), '0.1.9')
  // A live commit without a promotion title falls back to the tags.
  assertEquals(
    resolveBuildVersion('live', git({ log: 'hotfix', describe: 'v0.1.9-1-gabc1234' })),
    '0.1.10'
  )
  // Shallow clone or no git: nothing to stamp.
  assertEquals(resolveBuildVersion('trunk', git({})), null)
  assertEquals(resolveBuildVersion('staging', git({ log: new Error('no HEAD') })), null)
})

test('stampVersion rewrites only the version in the real deno.json and package.json', async () => {
  for (const name of ['deno.json', 'package.json']) {
    const source = await Deno.readTextFile(join(repoRoot, name))
    const stamped = stampVersion(source, '9.8.7')
    assert(stamped !== null)
    assertEquals(JSON.parse(stamped).version, '9.8.7')
    assertEquals({ ...JSON.parse(stamped), version: 0 }, { ...JSON.parse(source), version: 0 })
  }
  assertEquals(stampVersion('{"name": "x"}', '1.2.3'), null)
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
