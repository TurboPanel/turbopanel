import { assertEquals } from '@std/assert'
import {
  decideEnvironmentPush,
  environmentBranchBindings,
  normalizeBranchName,
  trackedBranches,
} from './environment-branch-tracking.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SOURCE = '11111111-2222-4333-8444-555555555555'
const OTHER_SOURCE = '99999999-2222-4333-8444-555555555555'

function composeOptions(services: Record<string, unknown>): { compose: unknown } {
  return {
    compose: { version: 1, data: { services }, presentation: { keyOrder: [], comments: {} } },
  }
}

function overlay(source: Record<string, unknown>): Record<string, unknown> {
  return { image: 'node:24', 'x-turbopanel': { source: { sourceId: SOURCE, ...source } } }
}

function bound(source: Record<string, unknown>): Record<string, unknown> {
  return { image: 'node:24', 'x-turbopanel': { source: { sourceId: SOURCE, ...source } } }
}

test('normalizeBranchName accepts names and refs/heads, nothing else', () => {
  assertEquals(normalizeBranchName('main'), 'main')
  assertEquals(normalizeBranchName('  release/1.4 '), 'release/1.4')
  assertEquals(normalizeBranchName('refs/heads/staging'), 'staging')
  assertEquals(normalizeBranchName('refs/tags/v1'), null)
  assertEquals(normalizeBranchName('refs/heads/'), null)
  assertEquals(normalizeBranchName(''), null)
  assertEquals(normalizeBranchName('   '), null)
  assertEquals(normalizeBranchName(null), null)
  assertEquals(normalizeBranchName(undefined), null)
})

test('the project binding decides the branch when the environment says nothing', () => {
  const bindings = environmentBranchBindings({
    projectOptions: composeOptions({ web: bound({ branch: 'main' }) }),
    environmentOptions: null,
    sourceId: SOURCE,
    repositoryDefaultBranch: 'trunk',
  })
  assertEquals(bindings, [{ composeServiceName: 'web', branch: 'main', deployOnPush: true }])
})

test('an environment overlay overrides the project branch for that environment only', () => {
  const projectOptions = composeOptions({ web: bound({ branch: 'main' }) })
  const staging = environmentBranchBindings({
    projectOptions,
    environmentOptions: composeOptions({
      web: overlay({ branch: 'staging' }),
    }),
    sourceId: SOURCE,
    repositoryDefaultBranch: 'main',
  })
  const production = environmentBranchBindings({
    projectOptions,
    environmentOptions: null,
    sourceId: SOURCE,
    repositoryDefaultBranch: 'main',
  })
  assertEquals(staging[0]?.branch, 'staging')
  assertEquals(production[0]?.branch, 'main')
})

test('a binding with no branch follows the repository default', () => {
  const bindings = environmentBranchBindings({
    projectOptions: composeOptions({ web: bound({}) }),
    environmentOptions: null,
    sourceId: SOURCE,
    repositoryDefaultBranch: 'refs/heads/trunk',
  })
  assertEquals(bindings[0]?.branch, 'trunk')
})

test('no branch anywhere means the environment tracks nothing', () => {
  const bindings = environmentBranchBindings({
    projectOptions: composeOptions({ web: bound({}) }),
    environmentOptions: null,
    sourceId: SOURCE,
    repositoryDefaultBranch: null,
  })
  assertEquals(bindings[0]?.branch, null)
  assertEquals(decideEnvironmentPush(bindings, 'main'), 'branch_not_tracked')
  assertEquals(trackedBranches(bindings), [])
})

test('only bindings to the pushed repository count', () => {
  const bindings = environmentBranchBindings({
    projectOptions: composeOptions({
      web: bound({ branch: 'main' }),
      worker: {
        image: 'node:24',
        'x-turbopanel': { source: { sourceId: OTHER_SOURCE, branch: 'main' } },
      },
      db: { image: 'postgres:18' },
    }),
    environmentOptions: null,
    sourceId: SOURCE,
    repositoryDefaultBranch: null,
  })
  assertEquals(
    bindings.map((entry) => entry.composeServiceName),
    ['web']
  )
})

test('deployOnPush false is read, and survives the overlay merge', () => {
  const bindings = environmentBranchBindings({
    projectOptions: composeOptions({ web: bound({ branch: 'main' }) }),
    environmentOptions: composeOptions({
      web: overlay({ deployOnPush: false }),
    }),
    sourceId: SOURCE,
    repositoryDefaultBranch: null,
  })
  assertEquals(bindings[0], { composeServiceName: 'web', branch: 'main', deployOnPush: false })
  assertEquals(decideEnvironmentPush(bindings, 'main'), 'push_deploys_off')
})

test('a non-boolean deployOnPush makes the document invalid, so nothing deploys from it', () => {
  const bindings = environmentBranchBindings({
    projectOptions: composeOptions({ web: bound({ branch: 'main', deployOnPush: 'false' }) }),
    environmentOptions: null,
    sourceId: SOURCE,
    repositoryDefaultBranch: null,
  })
  assertEquals(bindings, [])
})

test('decideEnvironmentPush matches the branch exactly and ignores refs that are not branches', () => {
  const bindings = [{ composeServiceName: 'web', branch: 'staging', deployOnPush: true }]
  assertEquals(decideEnvironmentPush(bindings, 'staging'), 'deploy')
  assertEquals(decideEnvironmentPush(bindings, 'refs/heads/staging'), 'deploy')
  assertEquals(decideEnvironmentPush(bindings, 'Staging'), 'branch_not_tracked')
  assertEquals(decideEnvironmentPush(bindings, 'staging-2'), 'branch_not_tracked')
  assertEquals(decideEnvironmentPush(bindings, 'refs/tags/staging'), 'branch_not_tracked')
  assertEquals(decideEnvironmentPush(bindings, ''), 'branch_not_tracked')
  assertEquals(decideEnvironmentPush([], 'staging'), 'branch_not_tracked')
})

test('one opted-in service is enough to deploy the environment', () => {
  const bindings = [
    { composeServiceName: 'api', branch: 'main', deployOnPush: false },
    { composeServiceName: 'web', branch: 'main', deployOnPush: true },
  ]
  assertEquals(decideEnvironmentPush(bindings, 'main'), 'deploy')
})

test('a malformed stored document tracks nothing instead of throwing', () => {
  const bindings = environmentBranchBindings({
    projectOptions: { compose: 'not a document' },
    environmentOptions: { compose: 42 },
    sourceId: SOURCE,
    repositoryDefaultBranch: 'main',
  })
  assertEquals(bindings, [])
})

test('trackedBranches lists each branch once, sorted', () => {
  assertEquals(
    trackedBranches([
      { composeServiceName: 'b', branch: 'main', deployOnPush: true },
      { composeServiceName: 'a', branch: 'develop', deployOnPush: true },
      { composeServiceName: 'c', branch: 'main', deployOnPush: false },
      { composeServiceName: 'd', branch: null, deployOnPush: true },
    ]),
    ['develop', 'main']
  )
})
