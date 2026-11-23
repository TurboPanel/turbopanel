/**
 * Host-free tests: the daemon fields a bound PHP site is sent, and what is said
 * when the daemon is too old for them.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import type { EnvironmentDeploySite } from '../../contracts/commands/schemas.ts'
import type { DerivedSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  siteDbCaUnavailableWarning,
  siteNeedsHostnameError,
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
              urlKeys: [],
              requiredKeys: ['DATABASE_HOST', 'DATABASE_HOST', 'DATABASE_PORT'],
            },
          ])
      )
    ),
  loadHostedServiceIds: (_db, ids) =>
    Promise.resolve(new Set(ids.filter((id) => id !== 's-nohost'))),
  loadRefNames: () => Promise.resolve({ siteCaFileNames: [], siteUrlNames: [] }),
  loadCaPem: () => Promise.resolve(PEM),
}

const serviceRows = [
  { id: 's-wp', composeServiceName: 'wp' },
  { id: 's-docs', composeServiceName: 'docs' },
]

function run(sites: EnvironmentDeploySite[], useDeps: SiteDbBindingsDeps = deps) {
  const warnings: SiteDbBindingsWarning[] = []
  return withSiteDbBindings(
    db,
    secrets,
    { organizationId: 'org', sites, serviceRows, warnings },
    useDeps
  ).then((out) => ({ out: out as EnvironmentDeploySite[], warnings }))
}

test('a bound site gets the CA and the required names, once each', async () => {
  const { out, warnings } = await run([site('wp'), site('docs')])
  assertEquals(out[0]?.dbCa, {
    variables: ['DATABASE_CA_FILE', 'REPORTS_CA_FILE'],
    pem: PEM,
  })
  assertEquals(out[0]?.requiredEnv, ['DATABASE_HOST', 'DATABASE_PORT'])
  assertEquals(out[1], site('docs'))
  assertEquals(warnings, [])
})

test('a site is sent neither field and the panel says why when the CA cannot be loaded', async () => {
  const { out, warnings } = await run([site('wp'), site('docs')], {
    ...deps,
    loadCaPem: () => Promise.resolve(undefined),
  })
  assertEquals(out, [site('wp'), site('docs')])
  assertEquals(warnings.length, 1)
  assertEquals(warnings[0]?.details.composeServiceName, 'wp')
})

test('no sites, or no encryption secrets, changes nothing', async () => {
  const warnings: SiteDbBindingsWarning[] = []
  const params = {
    organizationId: 'org',
    sites: [site('wp')],
    serviceRows,
    warnings,
  }
  assertEquals(await withSiteDbBindings(db, undefined, params, deps), [site('wp')])
  assertEquals(await withSiteDbBindings(db, secrets, { ...params, sites: [] }, deps), [])
})

test('the warning names the site and the fix, never a value', () => {
  const warning = siteDbCaUnavailableWarning('wp')
  assertEquals(warning.code, 'site_db_ca_unavailable')
  assertEquals(warning.message.includes('"wp"'), true)
})

test('a bound site with no hostname is refused in plain words instead of losing its settings', async () => {
  const noHostDeps: SiteDbBindingsDeps = {
    ...deps,
    loadNeeds: (_db, ids) =>
      Promise.resolve(
        new Map(
          ids.map((id) => [id, { caFileKeys: [], urlKeys: [], requiredKeys: ['DATABASE_HOST'] }])
        )
      ),
  }
  const out = await withSiteDbBindings(
    db,
    secrets,
    {
      organizationId: 'org',
      sites: [site('bare')],
      serviceRows: [{ id: 's-nohost', composeServiceName: 'bare' }],
      warnings: [],
    },
    noHostDeps
  )
  assertEquals(out, siteNeedsHostnameError('bare'))
  assertEquals((out as { message: string }).message.includes('add a hostname'), true)
})

const withRefs = (
  names: { siteCaFileNames: string[]; siteUrlNames: string[] },
  urlKeys: string[] = ['DATABASE_URL']
): SiteDbBindingsDeps => ({
  ...deps,
  loadRefNames: () => Promise.resolve(names),
  loadNeeds: (_db, ids) =>
    Promise.resolve(
      new Map(
        ids.map((id) => [
          id,
          { caFileKeys: ['DATABASE_CA_FILE'], urlKeys, requiredKeys: ['DATABASE_HOST'] },
        ])
      )
    ),
})

test('the URL names are sent too, joined with the reference names, once each', async () => {
  const { out } = await run(
    [site('wp')],
    withRefs({
      siteCaFileNames: ['CA', 'DATABASE_CA_FILE'],
      siteUrlNames: ['DB_URL', 'DATABASE_URL'],
    })
  )
  assertEquals(out[0]?.dbCa, {
    variables: ['DATABASE_CA_FILE', 'CA'],
    pem: PEM,
    urlVariables: ['DATABASE_URL', 'DB_URL'],
  })
})

test('up to 16 names are taken and more is refused', async () => {
  const many = Array.from({ length: 9 }, (_, i) => `CA_${i}`)
  const current = await run([site('wp')], withRefs({ siteCaFileNames: many, siteUrlNames: [] }))
  assertEquals(current.out[0]?.dbCa?.variables.length, 10)
  const tooMany = Array.from({ length: 17 }, (_, i) => `CA_${i}`)
  const refused = await run([site('wp')], withRefs({ siteCaFileNames: tooMany, siteUrlNames: [] }))
  assertEquals((refused.out as unknown as { kind: string }).kind, 'binding_host_site_unsupported')
})

test('a MariaDB-only binding sends no urlVariables key', async () => {
  const { out } = await run([site('wp')], withRefs({ siteCaFileNames: [], siteUrlNames: [] }, []))
  const dbCa = out[0]?.dbCa
  assertEquals(dbCa, { variables: ['DATABASE_CA_FILE'], pem: PEM })
  assertEquals('urlVariables' in (dbCa ?? {}), false)
})

test('a PostgreSQL-only binding sends its URL names', async () => {
  const { out } = await run(
    [site('wp')],
    withRefs({ siteCaFileNames: [], siteUrlNames: [] }, ['PG_URL'])
  )
  assertEquals(out[0]?.dbCa?.urlVariables, ['PG_URL'])
})

test('a mixed set sends only the PostgreSQL URL names', async () => {
  const { out } = await run(
    [site('wp')],
    withRefs({ siteCaFileNames: ['MARIA_CA_FILE'], siteUrlNames: [] }, ['PG_URL'])
  )
  assertEquals(out[0]?.dbCa, {
    variables: ['DATABASE_CA_FILE', 'MARIA_CA_FILE'],
    pem: PEM,
    urlVariables: ['PG_URL'],
  })
})
