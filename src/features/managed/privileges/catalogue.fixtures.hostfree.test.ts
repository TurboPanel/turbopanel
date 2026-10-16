import { assert, assertEquals } from '@std/assert'
import { MANAGED_ENGINE_RELEASES } from '../releases.ts'
import {
  privilegeCatalogueFor,
  privilegeCataloguePairs,
  privilegeCatalogueSeries,
  uncataloguedCreatableSeries,
} from './catalogue.ts'
import { compareSeries, existsInSeries } from './series.ts'
import type { PrivilegeCatalogue, PrivilegeLevel } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

// deno-lint-ignore no-explicit-any
type Fixture = Record<string, any>

function loadFixture(engine: string, series: string): Fixture {
  const url = new URL(`./fixtures/${engine}-${series}.json`, import.meta.url)
  return JSON.parse(Deno.readTextFileSync(url))
}

function keywords(catalogue: PrivilegeCatalogue, level: PrivilegeLevel): string[] {
  return catalogue.privileges
    .filter((entry) => entry.level === level)
    .map((entry) => entry.keyword)
    .sort()
}

function letters(catalogue: PrivilegeCatalogue, level: PrivilegeLevel): string[] {
  return catalogue.privileges
    .filter((entry) => entry.level === level)
    .map((entry) => entry.aclLetter ?? '')
    .join('')
    .split('')
    .sort()
}

const PG_KIND_LEVEL: Record<string, PrivilegeLevel> = {
  d: 'database',
  n: 'schema',
  r: 'table',
  s: 'sequence',
  f: 'routine',
  T: 'type',
  p: 'parameter',
  t: 'tablespace',
  l: 'language',
  F: 'foreign',
  S: 'foreign',
  L: 'largeobject',
}

for (const { engine, series } of privilegeCataloguePairs().filter((p) => p.engine === 'postgres')) {
  test(`postgres ${series}: catalogue matches the captured engine`, () => {
    const fx = loadFixture(engine, series)
    const cat = privilegeCatalogueFor(engine, series)!
    assertEquals(fx.series, series)

    for (const [kind, level] of Object.entries(PG_KIND_LEVEL)) {
      assertEquals(keywords(cat, level), [...fx.aclPrivilegeTypes[kind]].sort(), `kind ${kind}`)
      assertEquals(letters(cat, level), [...fx.aclLetters[kind]].sort(), `letters ${kind}`)
    }
    // Every kind the engine reports is modelled (`c` is columns, checked below).
    const modelled = new Set(Object.keys(PG_KIND_LEVEL))
    for (const kind of Object.keys(fx.aclPrivilegeTypes)) {
      assert(kind === 'c' || modelled.has(kind), `kind ${kind} is not in the catalogue`)
    }
    // Column grants: only the privileges the engine accepts, with its letters.
    const accepted = Object.entries(fx.columnGrants.accepted as Record<string, boolean>)
      .filter(([keyword, ok]) => ok && keyword !== 'ALL')
      .map(([keyword]) => keyword)
      .sort()
    assertEquals(keywords(cat, 'column'), accepted)
    assertEquals(letters(cat, 'column'), [...fx.columnGrants.letters].sort())

    assertEquals(
      cat.roles.map((role) => role.name).sort(),
      [...fx.predefinedRoles].sort(),
      'predefined roles'
    )
    assertEquals(
      cat.attributes.map((attribute) => attribute.column).sort(),
      [...fx.roleAttributeColumns].sort(),
      'role attributes'
    )
    const optionsExist = cat.membershipOptions.some((option) => option.id === 'inherit')
    assertEquals(optionsExist, fx.membershipOptions)
    assertEquals(optionsExist, fx.authMembersColumns.includes('inherit_option'))
    assertEquals(
      cat.privileges.some((entry) => entry.id === 'table:MAINTAIN'),
      fx.maintainGrantable
    )
    // The default-privilege kinds are exactly the ones the engine accepts.
    assertEquals(
      cat.defaultPrivilegeObjects.map((object) => object.letter).sort(),
      [...fx.defaultAclObjTypes].sort()
    )
  })
}

/** MySQL and MariaDB: normalise a grant-table member to a catalogue keyword. */
function tableMember(value: string): string {
  const upper = value.toUpperCase()
  if (upper === 'GRANT') return 'GRANT OPTION'
  if (upper === 'DELETE VERSIONING ROWS') return 'DELETE HISTORY'
  return upper
}

function names(catalogue: PrivilegeCatalogue, level: PrivilegeLevel): Set<string> {
  const out = new Set<string>()
  for (const entry of catalogue.privileges) {
    if (entry.level !== level) continue
    out.add(entry.keyword)
    for (const alias of entry.aliases ?? []) out.add(alias)
  }
  return out
}

for (const { engine, series } of privilegeCataloguePairs().filter((p) => p.engine !== 'postgres')) {
  test(`${engine} ${series}: catalogue matches the captured engine`, () => {
    const fx = loadFixture(engine, series)
    const cat = privilegeCatalogueFor(engine, series)!
    const anywhere = new Set<string>()
    for (const entry of cat.privileges) {
      anywhere.add(entry.keyword)
      for (const alias of entry.aliases ?? []) anywhere.add(alias)
    }

    // Accepted-by-level probe: each keyword is valid exactly where the catalogue says.
    const levelOf: [string, PrivilegeLevel][] = [
      ['schema', 'database'],
      ['table', 'table'],
      ['column', 'column'],
      ['procedure', 'routine'],
    ]
    for (const [keyword, flags] of Object.entries(
      fx.grantStatementProbe as Record<string, Record<string, boolean>>
    )) {
      if (keyword === 'ALL' || keyword === 'USAGE' || keyword === 'PROXY') continue
      for (const [probeLevel, level] of levelOf) {
        assertEquals(names(cat, level).has(keyword), flags[probeLevel], `${keyword} at ${level}`)
      }
      assertEquals(anywhere.has(keyword), flags.global, `${keyword} accepted on *.*`)
    }

    // Every privilege the server reports must be catalogued, and no global entry is invented.
    const reported: string[] =
      engine === 'mysql'
        ? fx.allGrants.global
        : fx.informationSchemaPrivilegeTypes.userPrivilegesRoot
    for (const keyword of reported) {
      assert(anywhere.has(keyword), `server reports ${keyword}; not in the catalogue`)
    }
    const reportedSet = new Set(reported)
    for (const entry of cat.privileges.filter((e) => e.level === 'global')) {
      if (entry.keyword === 'USAGE' || entry.keyword === 'PROXY') continue
      const known = [entry.keyword, ...(entry.aliases ?? [])].some((k) => reportedSet.has(k))
      assert(known, `catalogue has ${entry.keyword}; the server does not report it`)
    }
    for (const row of fx.showPrivileges as { Privilege: string }[]) {
      const lower = row.Privilege.toLowerCase()
      assert(
        [...anywhere].some((k) => k.toLowerCase() === lower),
        `SHOW PRIVILEGES lists ${row.Privilege}`
      )
    }

    // The grant tables list the same table, column and routine privileges.
    const expect = (member: string, level: PrivilegeLevel) =>
      assertEquals(
        [...names(cat, level)]
          .filter((k) => !cat.privileges.find((e) => e.level === level && e.aliases?.includes(k)))
          .sort(),
        (fx.enumValues[member] as string[]).map(tableMember).sort(),
        member
      )
    expect('tables_priv.Table_priv', 'table')
    expect('columns_priv.Column_priv', 'column')
    expect('procs_priv.Proc_priv', 'routine')
  })
}

test('every supported series has a fixture and a catalogue, and nothing else is catalogued', () => {
  assertEquals(uncataloguedCreatableSeries(), [])
  for (const { engine, series } of privilegeCataloguePairs()) {
    assertEquals(loadFixture(engine, series).serverVersion.startsWith(series), true)
  }
  const releases = MANAGED_ENGINE_RELEASES.map((r) => `${r.engine}:${r.series}`)
  for (const { engine, series } of privilegeCataloguePairs()) {
    assert(
      releases.includes(`${engine}:${series}`),
      `${engine} ${series} is not a catalogued release`
    )
  }
  assertEquals(privilegeCatalogueSeries('postgres'), ['15', '16', '17', '18'])
  assertEquals(privilegeCatalogueFor('mariadb', '11.4'), undefined)
  assertEquals(privilegeCatalogueFor('mysql', '8.0'), undefined)
  assertEquals(privilegeCatalogueFor('redis', '7'), undefined)
})

test('entries are well formed and the never-allowed list holds', () => {
  for (const { engine, series } of privilegeCataloguePairs()) {
    const cat = privilegeCatalogueFor(engine, series)!
    const ids = cat.privileges.map((e) => e.id)
    assertEquals(new Set(ids).size, ids.length, `${engine} ${series} duplicate ids`)
    const texts = [
      ...cat.privileges.map((e) => [e.label, e.explanation, e.reason ?? '']),
      ...cat.roles.map((e) => [e.label, e.explanation, e.reason ?? '']),
      ...cat.attributes.map((e) => [e.label, e.explanation, e.reason ?? '']),
    ].flat()
    for (const text of texts) {
      assert(!/tenant|principal|railpack|nixpacks|heroku|vercel/i.test(text), text)
    }
    for (const entry of cat.privileges) {
      assert(entry.label.length > 0 && entry.explanation.endsWith('.'), entry.id)
      assertEquals(entry.allowed === 'yes', entry.reason === undefined, entry.id)
      assertEquals(entry.id, `${entry.level}:${entry.keyword}`)
      if (entry.level === 'global' && entry.keyword !== 'USAGE') {
        assertEquals(entry.allowed, 'no', entry.id)
      }
    }
    for (const entry of cat.roles) assertEquals(entry.allowed === 'yes', entry.reason === undefined)
  }
  const must = (engine: string, series: string, keyword: string) => {
    const hit = privilegeCatalogueFor(engine, series)!.privileges.find(
      (e) => e.level === 'global' && e.keyword === keyword
    )
    assertEquals(hit?.allowed, 'no', `${engine} ${keyword}`)
  }
  for (const keyword of [
    'CREATE USER',
    'SUPER',
    'FILE',
    'PROXY',
    'RELOAD',
    'SHUTDOWN',
    'REPLICATION SLAVE',
    'PROCESS',
  ]) {
    must('mysql', '8.4', keyword)
    must('mariadb', '11.8', keyword)
  }
  must('mysql', '9.7', 'SET_ANY_DEFINER')
  must('mysql', '8.4', 'REPLICATION CLIENT')
  must('mariadb', '12.3', 'SET USER')
  must('mariadb', '12.3', 'BINLOG ADMIN')
  const pg = privilegeCatalogueFor('postgres', '18')!
  for (const name of ['SUPERUSER', 'REPLICATION', 'BYPASSRLS', 'CREATEROLE', 'CREATEDB']) {
    assertEquals(pg.attributes.find((a) => a.name === name)?.allowed, 'no', name)
  }
  for (const name of [
    'pg_read_server_files',
    'pg_write_server_files',
    'pg_execute_server_program',
  ]) {
    assertEquals(pg.roles.find((r) => r.name === name)?.allowed, 'no', name)
  }
  assertEquals(pg.blocked.reservedPrefixes.includes('tp_'), true)
  assertEquals(pg.blocked.reservedNames.includes('postgres'), true)
  for (const level of ['parameter', 'tablespace', 'language', 'foreign', 'largeobject'] as const) {
    for (const entry of pg.privileges.filter((e) => e.level === level)) {
      assertEquals(entry.allowed, 'no', entry.id)
    }
  }
  const mysql = privilegeCatalogueFor('mysql', '8.4')!
  assertEquals(mysql.blocked.reservedNames.includes('root'), true)
  assertEquals(mysql.blocked.reservedPrefixes.includes('mysql.'), true)
})

test('series comparison and bounds', () => {
  assert(compareSeries('9.7', '8.4') > 0)
  assert(compareSeries('11.8', '12.3') < 0)
  assertEquals(compareSeries('18', '18'), 0)
  assertEquals(existsInSeries({ since: '17' }, '16'), false)
  assertEquals(existsInSeries({ since: '17' }, '17'), true)
  assertEquals(existsInSeries({ removedIn: '9.7' }, '9.7'), false)
  assertEquals(existsInSeries({}, '1'), true)
})
