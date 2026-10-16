import { assertEquals } from '@std/assert'
import { privilegeCatalogueFor } from './catalogue.ts'
import { buildEffectivePermissions, reportMatchesSeries } from './effective.ts'
import { type ManagedPermissionsObserved, parseManagedPermissionsObserved } from './observed.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const NOW = '2026-10-16T12:00:00.000Z'

function report(login: ManagedPermissionsObserved['logins'][number], engine = 'postgres') {
  return { engine, observedAt: NOW, serverVersion: '18.1', logins: [login] }
}

test('a Postgres login: grants, a column grant, a default privilege and a predefined role', () => {
  const catalogue = privilegeCatalogueFor('postgres', '18')!
  const login = {
    username: 'app',
    exists: true,
    attributes: { superuser: false, createdb: true, canLogin: true },
    memberships: [
      { role: 'pg_read_all_data', inherit: true, set: false, admin: false },
      { role: 'tp_shop_owner', inherit: false, set: true },
      { role: 'someone_elses', inherit: true },
    ],
    grants: [
      {
        level: 'table' as const,
        database: 'shop',
        schema: 'public',
        object: 'orders',
        privileges: ['SELECT', 'MAINTAIN'],
        grantable: ['SELECT'],
      },
      {
        level: 'column' as const,
        database: 'shop',
        schema: 'public',
        object: 'orders',
        columns: ['email'],
        privileges: ['SELECT'],
      },
      { level: 'schema' as const, database: 'shop', schema: 'pg_catalog', privileges: ['USAGE'] },
      {
        level: 'table' as const,
        database: 'shop',
        schema: 'public',
        object: 't',
        privileges: ['RULE'],
      },
    ],
    defaults: [
      {
        database: 'shop',
        creator: 'tp_shop_owner',
        schema: 'public',
        objectType: 'r',
        privileges: ['SELECT'],
      },
    ],
  }
  const view = buildEffectivePermissions(catalogue, report(login), login)
  assertEquals(view.series, '18')
  assertEquals(view.ledger, { available: false })

  const orders = view.grants[0]!
  assertEquals(orders.origin, 'observed')
  assertEquals(
    orders.privileges.map((p) => [p.keyword, p.catalogueId, p.grantable]),
    [
      ['SELECT', 'table:SELECT', true],
      ['MAINTAIN', 'table:MAINTAIN', false],
    ]
  )
  assertEquals(view.grants[1]!.privileges[0]!.catalogueId, 'column:SELECT')
  assertEquals(view.grants[1]!.columns, ['email'])
  // A system schema is off limits, and a privilege PG18 does not have is unknown.
  assertEquals(view.grants[2]!.privileges[0]!.allowed, 'no')
  assertEquals(view.grants[3]!.privileges[0]!.allowed, 'unknown')
  assertEquals(view.grants[3]!.privileges[0]!.catalogueId, null)

  assertEquals(view.defaults[0]!.appliesTo, 'New tables and views')
  assertEquals(view.defaults[0]!.privileges[0]!.catalogueId, 'table:SELECT')

  assertEquals(
    view.memberships.map((m) => [m.role, m.kind, m.allowed]),
    [
      ['pg_read_all_data', 'predefined', 'needs-admin'],
      ['tp_shop_owner', 'panel', 'yes'],
      ['someone_elses', 'other', 'unknown'],
    ]
  )
  // createdb is on and forbidden; superuser is off so it is not counted.
  assertEquals(view.outsidePolicyCount, 2)
  assertEquals(
    view.attributes.filter((a) => a.allowed === 'no').map((a) => [a.name, a.value]),
    [
      ['SUPERUSER', false],
      ['CREATEDB', true],
    ]
  )
})

test('MAINTAIN is unknown on Postgres 16', () => {
  const catalogue = privilegeCatalogueFor('postgres', '16')!
  const login = {
    username: 'app',
    exists: true,
    memberships: [],
    grants: [
      {
        level: 'table' as const,
        database: 'shop',
        schema: 'public',
        object: 'o',
        privileges: ['MAINTAIN'],
      },
    ],
    defaults: [],
  }
  const view = buildEffectivePermissions(catalogue, report(login), login)
  assertEquals(view.grants[0]!.privileges[0]!.allowed, 'unknown')
})

test('MySQL: ALL PRIVILEGES on a database expands; on the whole server it is refused', () => {
  const catalogue = privilegeCatalogueFor('mysql', '8.4')!
  const login = {
    username: 'app',
    exists: true,
    accounts: [{ host: '%' }],
    memberships: [],
    grants: [
      { level: 'database' as const, database: 'shop', host: '%', privileges: ['ALL PRIVILEGES'] },
      {
        level: 'global' as const,
        host: '%',
        privileges: ['SELECT', 'SYSTEM_VARIABLES_ADMIN', 'USAGE'],
      },
      { level: 'database' as const, database: 'mysql', host: '%', privileges: ['SELECT'] },
      {
        level: 'database' as const,
        database: 'shop',
        host: '%',
        privileges: ['GRANT OPTION', 'SELECT'],
      },
    ],
    defaults: [],
  }
  const view = buildEffectivePermissions(catalogue, report(login, 'mysql'), login)
  const all = view.grants[0]!.privileges.map((p) => p.keyword)
  assertEquals(all.includes('SELECT'), true)
  assertEquals(all.includes('GRANT OPTION'), false)
  assertEquals(
    view.grants[0]!.privileges.every((p) => p.allowed === 'yes'),
    true
  )

  const wide = view.grants[1]!.privileges
  assertEquals(
    wide.map((p) => [p.keyword, p.allowed]),
    [
      ['SELECT', 'no'],
      ['SYSTEM_VARIABLES_ADMIN', 'no'],
      ['USAGE', 'yes'],
    ]
  )
  assertEquals(view.grants[2]!.privileges[0]!.allowed, 'no')
  // GRANT OPTION marks the other privileges on that scope as grantable.
  const withOption = view.grants[3]!.privileges
  assertEquals(withOption.find((p) => p.keyword === 'SELECT')!.grantable, true)
  assertEquals(withOption.find((p) => p.keyword === 'GRANT OPTION')!.allowed, 'needs-admin')
})

test('MariaDB aliases resolve to their catalogue entry', () => {
  const catalogue = privilegeCatalogueFor('mariadb', '11.8')!
  const login = {
    username: 'app',
    exists: true,
    memberships: [],
    grants: [{ level: 'global' as const, host: '%', privileges: ['REPLICATION CLIENT'] }],
    defaults: [],
  }
  const view = buildEffectivePermissions(catalogue, report(login, 'mariadb'), login)
  assertEquals(view.grants[0]!.privileges[0]!.allowed, 'no')
})

test('the parser drops malformed entries and caps names', () => {
  assertEquals(parseManagedPermissionsObserved(null), null)
  assertEquals(
    parseManagedPermissionsObserved({ engine: 'postgres', observedAt: 'nope', logins: [] }),
    null
  )
  const parsed = parseManagedPermissionsObserved({
    engine: 'postgres',
    observedAt: NOW,
    logins: [
      {
        username: 'app',
        exists: true,
        memberships: [{ role: 'r', inherit: 'yes' }, 5],
        grants: [
          { level: 'table', privileges: ['SELECT'], columns: ['a'] },
          { level: 'galaxy', privileges: ['SELECT'] },
          { level: 'table', privileges: 'SELECT' },
        ],
        defaults: [{ database: 'd', creator: 'c', objectType: 'rr', privileges: ['SELECT'] }],
      },
      { username: '', exists: true },
    ],
  })!
  assertEquals(parsed.logins.length, 1)
  assertEquals(parsed.logins[0]!.grants.length, 1)
  assertEquals(parsed.logins[0]!.memberships, [{ role: 'r' }])
  const viaParsed = parseManagedPermissionsObserved({
    engine: 'postgres',
    observedAt: NOW,
    logins: [
      {
        username: 'a',
        exists: true,
        memberships: [{ role: 'pg_monitor', via: 'grp' }],
        grants: [],
        defaults: [],
      },
    ],
  })!
  assertEquals(viaParsed.logins[0]!.memberships, [{ role: 'pg_monitor', via: 'grp' }])
  assertEquals(parsed.logins[0]!.defaults, [])
})

test('reportMatchesSeries compares the engine version with the catalogue series', () => {
  assertEquals(reportMatchesSeries('18.1', '18'), true)
  assertEquals(reportMatchesSeries('17.6', '18'), false)
  assertEquals(reportMatchesSeries('9.7.0', '9.7'), true)
  assertEquals(reportMatchesSeries('11.8.3-MariaDB', '11.8'), true)
  assertEquals(reportMatchesSeries('11.4.2-MariaDB', '11.8'), false)
  assertEquals(reportMatchesSeries(undefined, '18'), true)
})

test('PUBLIC grants are labelled everyone; MySQL role grants are not expanded', () => {
  const pg = privilegeCatalogueFor('postgres', '18')!
  const pgLogin = {
    username: 'app',
    exists: true,
    memberships: [],
    grants: [
      { level: 'database' as const, database: 'shop', privileges: ['CONNECT'], via: 'PUBLIC' },
    ],
    defaults: [],
  }
  const pgView = buildEffectivePermissions(pg, report(pgLogin), pgLogin)
  assertEquals(pgView.grants[0]!.viaLabel, 'everyone')

  const my = privilegeCatalogueFor('mysql', '8.4')!
  const myLogin = {
    username: 'app',
    exists: true,
    memberships: [{ role: 'reader' }],
    grants: [
      { level: 'database' as const, database: 'shop', host: '%', privileges: ['SELECT'] },
      {
        level: 'database' as const,
        database: 'shop',
        host: '%',
        privileges: ['INSERT'],
        via: 'reader',
      },
    ],
    defaults: [],
  }
  const myView = buildEffectivePermissions(my, report(myLogin, 'mysql'), myLogin)
  assertEquals(myView.grants.length, 1)
  assertEquals(
    myView.memberships.map((m) => m.role),
    ['reader']
  )
})
