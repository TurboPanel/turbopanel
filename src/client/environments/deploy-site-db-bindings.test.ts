/**
 * Host-free tests: the daemon fields a bound PHP site is sent, and what is said
 * when the daemon is too old for them.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { EnvironmentDeploySite } from '../../contracts/commands/schemas.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import { SITE_DB_BINDINGS_FEATURE } from '../../lib/version-wire.ts'
import {
  siteDbCaUnavailableWarning,
  type SiteDbBindingsDeps,
  type SiteDbBindingsWarning,
  withSiteDbBindings,
} from './deploy-site-db-bindings.ts'

/** Sonar only recognizes `test()`; see `materialize.test.ts`. */
const test = Deno.test.bind(Deno)

const PEM = '-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----\n'
const db = {} as Db
const secrets = {} as DerivedSecretsConfig

const site = (name: string): EnvironmentDeploySite => ({
  composeServiceName: name,
  engine: 'apache',
  root: 'public',
  listenPort: 18081,
})

const deps: SiteDbBindingsDeps = {
  loadNeeds: (_db, ids) =>
    Promise.resolve(
      new Map(
        ids
          .filter((id) => id === 's-wp')
          .map((id) => [
            id,
            {
              caFileKeys: ['DATABASE_CA_FILE', 'DATABASE_CA_FILE', 'REPORTS_CA_FILE'],
              requiredKeys: ['DATABASE_HOST', 'DATABASE_HOST', 'DATABASE_PORT'],
            },
          ])
      )
    ),
  loadCaPem: () => Promise.resolve(PEM),
}

const serviceRows = [
  { id: 's-wp', composeServiceName: 'wp' },
  { id: 's-docs', composeServiceName: 'docs' },
]

function run(features: string[], sites: EnvironmentDeploySite[]) {
  const warnings: SiteDbBindingsWarning[] = []
  return withSiteDbBindings(
    db,
    secrets,
    { organizationId: 'org', sites, serviceRows, daemonFeatures: features, warnings },
    deps
  ).then((out) => ({ out, warnings }))
}

test('a bound site on a new daemon gets the CA and the required names, once each', async () => {
  const { out, warnings } = await run([SITE_DB_BINDINGS_FEATURE], [site('wp'), site('docs')])
  assertEquals(out[0]?.dbCa, {
    variables: ['DATABASE_CA_FILE', 'REPORTS_CA_FILE'],
    pem: PEM,
  })
  assertEquals(out[0]?.requiredEnv, ['DATABASE_HOST', 'DATABASE_PORT'])
  assertEquals(out[1], site('docs'))
  assertEquals(warnings, [])
})

test('an old daemon is sent neither field and the panel says why', async () => {
  const { out, warnings } = await run([], [site('wp'), site('docs')])
  assertEquals(out, [site('wp'), site('docs')])
  assertEquals(warnings.length, 1)
  assertEquals(warnings[0]?.details.composeServiceName, 'wp')
})

test('a daemon without the feature but another one listed is still old', async () => {
  const { out } = await run(['php-site-modes-v1'], [site('wp')])
  assertEquals('dbCa' in (out[0] ?? {}), false)
  assertEquals('requiredEnv' in (out[0] ?? {}), false)
})

test('no sites, or no encryption secrets, changes nothing', async () => {
  const warnings: SiteDbBindingsWarning[] = []
  const params = {
    organizationId: 'org',
    sites: [site('wp')],
    serviceRows,
    daemonFeatures: [SITE_DB_BINDINGS_FEATURE],
    warnings,
  }
  assertEquals(await withSiteDbBindings(db, undefined, params, deps), [site('wp')])
  assertEquals(await withSiteDbBindings(db, secrets, { ...params, sites: [] }, deps), [])
})

test('the warning names the site and the fix, never a value', () => {
  const warning = siteDbCaUnavailableWarning('wp')
  assertEquals(warning.code, 'site_db_ca_unavailable')
  assertEquals(warning.message.includes('"wp"'), true)
  assertEquals(warning.message.includes('Update the daemon'), true)
  assertEquals(SITE_DB_BINDINGS_FEATURE, 'site-db-bindings-v1')
})
