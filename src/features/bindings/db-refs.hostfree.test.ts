/**
 * Host-free coverage for `{$db.<binding>.<field>}`: the pure resolver, the
 * Compose lookup and the site names. No database, no clock.
 */

import { assertEquals } from '@std/assert'
import type { DeployVariableEntry } from '../compose/apply-variables.ts'
import { type DbVariableRef, parseExactVariableRef } from '../compose/variable-refs.ts'
import type { ResolvedVariableEntry, ResolvedVariableMap } from '../variables/resolve-inherited.ts'
import type { BindingDelivery } from './host-run.ts'
import {
  applyDbRefs,
  type BindingRefInfo,
  type BindingRefTable,
  dbRefLookupFor,
  dropDbRefs,
  resolveDbRefsForService,
} from './db-refs.ts'

const test = Deno.test.bind(Deno)

const SEALED_PASSWORD = 'tpsecret.v1.password-envelope'
const SEALED_URL = 'tpsecret.v1.url-envelope'
const SEALED_CA = 'tpsecret.v1.ca-envelope'

function info(delivery: BindingDelivery, engine = 'postgres', prefix = 'DATABASE'): BindingRefInfo {
  const rows = new Map<string, { value: string; isSecret: boolean }>([
    [`${prefix}_HOST`, { value: 'db-in', isSecret: false }],
    [`${prefix}_PORT`, { value: '15432', isSecret: false }],
    [`${prefix}_NAME`, { value: 'shop', isSecret: false }],
    [`${prefix}_USER`, { value: 'app', isSecret: false }],
    [`${prefix}_READ_SPLIT`, { value: 'false', isSecret: false }],
    [`${prefix}_SSL_MODE`, { value: 'verify-full', isSecret: false }],
    [`${prefix}_PASSWORD`, { value: SEALED_PASSWORD, isSecret: true }],
    [`${prefix}_URL`, { value: SEALED_URL, isSecret: true }],
  ])
  if (delivery !== 'host-site') {
    rows.set(`${prefix}_CA_CERT`, { value: SEALED_CA, isSecret: true })
  }
  if (delivery === 'container') {
    rows.set(`${prefix}_CA_FILE`, {
      value: `/run/secrets/${prefix}_CA_CERT`,
      isSecret: false,
    })
  }
  return { bindingId: `b-${delivery}`, engine, delivery, rows }
}

const tableFor = (delivery: BindingDelivery, engine = 'postgres'): BindingRefTable =>
  new Map([['DATABASE', info(delivery, engine)]])

function plain(value: string): ResolvedVariableEntry {
  return { value, isSecret: false, isLiteral: true, forBuild: false, forRuntime: true }
}

const mapOf = (entries: Record<string, ResolvedVariableEntry>): ResolvedVariableMap =>
  new Map(Object.entries(entries))

const none = new Set<string>()
const ownCa = new Set(['CA'])

test('a whole secret field passes the sealed envelope through and the variable stays secret', () => {
  const out = applyDbRefs(
    mapOf({ APP_DB_PASS: plain('{$db.DATABASE.password}') }),
    tableFor('container'),
    { ownScopeKeys: none }
  )
  const entry = out.map.get('APP_DB_PASS')
  assertEquals(entry?.value === SEALED_PASSWORD, true)
  assertEquals(entry?.isSecret, true)
  assertEquals(entry?.bindingId, 'b-container')
  assertEquals(entry?.forBuild, false)
  assertEquals(out.errors, [])
})

test('a secret reference keeps the runtime flag of the variable it sits in', () => {
  const out = applyDbRefs(
    mapOf({ OFF: { ...plain('{$db.DATABASE.password}'), forRuntime: false } }),
    tableFor('container'),
    { ownScopeKeys: none }
  )
  assertEquals(out.map.get('OFF')?.forRuntime, false)
})

test('a plain field is replaced anywhere in the text', () => {
  const out = applyDbRefs(
    mapOf({
      PDO_DSN: plain(
        'mysql:host={$db.DATABASE.host};port={$db.DATABASE.port};dbname={$db.DATABASE.name}'
      ),
    }),
    tableFor('container', 'mysql'),
    { ownScopeKeys: none }
  )
  assertEquals(out.map.get('PDO_DSN')?.value, 'mysql:host=db-in;port=15432;dbname=shop')
})

test('a secret field inside a longer value is refused by name, without a value', () => {
  const out = applyDbRefs(
    mapOf({ DSN: plain('pgsql://app:{$db.DATABASE.password}@db') }),
    tableFor('container'),
    { ownScopeKeys: none }
  )
  assertEquals(out.errors.length, 1)
  assertEquals(out.errors[0]?.code, 'variable_ref_invalid')
  assertEquals(out.errors[0]?.message.includes('must be the whole value'), true)
  assertEquals(out.errors[0]?.message.includes(SEALED_PASSWORD), false)
  assertEquals(out.map.has('DSN'), false)
})

test('what is inserted is not scanned again and the escape writes a literal token', () => {
  const table: BindingRefTable = new Map([
    [
      'DATABASE',
      {
        ...info('container'),
        rows: new Map([['DATABASE_NAME', { value: '{$db.OTHER.host}', isSecret: false }]]),
      },
    ],
  ])
  const out = applyDbRefs(
    mapOf({
      A: plain('x-{$db.DATABASE.name}'),
      B: plain('keep {$$db.DATABASE.host} as text'),
      C: plain('{$OTHER}'),
    }),
    table,
    { ownScopeKeys: none }
  )
  assertEquals(out.map.get('A')?.value, 'x-{$db.OTHER.host}')
  assertEquals(out.map.get('B')?.value, 'keep {$db.DATABASE.host} as text')
  assertEquals(out.map.get('C')?.value, '{$OTHER}')
})

test('the input map and its entries are never changed', () => {
  const entry = plain('{$db.DATABASE.host}')
  const input = mapOf({ HOST: entry })
  applyDbRefs(input, tableFor('container'), { ownScopeKeys: none })
  assertEquals(entry.value, '{$db.DATABASE.host}')
  assertEquals(input.get('HOST'), entry)
})

test('driver is the engine, and ssl_mode and read_split come from the rows', () => {
  for (const engine of ['postgres', 'mysql', 'mariadb']) {
    const out = applyDbRefs(
      mapOf({ D: plain('{$db.DATABASE.driver}') }),
      tableFor('container', engine),
      {
        ownScopeKeys: none,
      }
    )
    assertEquals(out.map.get('D')?.value, engine)
  }
  const out = applyDbRefs(
    mapOf({ M: plain('{$db.DATABASE.ssl_mode}'), R: plain('{$db.DATABASE.read_split}') }),
    tableFor('host-node'),
    { ownScopeKeys: none }
  )
  assertEquals(out.map.get('M')?.value, 'verify-full')
  assertEquals(out.map.get('R')?.value, 'false')
})

test('ca_file: a container reads its path, a site collects the name, a Node app is refused', () => {
  const container = applyDbRefs(
    mapOf({ CA: plain('{$db.DATABASE.ca_file}') }),
    tableFor('container'),
    {
      ownScopeKeys: none,
    }
  )
  assertEquals(container.map.get('CA')?.value, '/run/secrets/DATABASE_CA_CERT')

  const site = applyDbRefs(mapOf({ CA: plain('{$db.DATABASE.ca_file}') }), tableFor('host-site'), {
    ownScopeKeys: none,
  })
  assertEquals(site.map.has('CA'), false)
  assertEquals(site.siteCaFileNames, ['CA'])
  assertEquals(site.errors, [])

  const embedded = applyDbRefs(
    mapOf({ CA: plain('path={$db.DATABASE.ca_file}') }),
    tableFor('host-site'),
    { ownScopeKeys: ownCa }
  )
  assertEquals(embedded.errors[0]?.message.includes('only be the whole value'), true)

  const node = applyDbRefs(mapOf({ CA: plain('{$db.DATABASE.ca_file}') }), tableFor('host-node'), {
    ownScopeKeys: ownCa,
  })
  assertEquals(node.errors[0]?.message.includes('ca_text'), true)
})

test('ca_text: a site is told to use ca_file, a Node app and a container get the sealed text', () => {
  const site = applyDbRefs(mapOf({ CA: plain('{$db.DATABASE.ca_text}') }), tableFor('host-site'), {
    ownScopeKeys: ownCa,
  })
  assertEquals(site.errors[0]?.message.includes('use ca_file'), true)
  const node = applyDbRefs(mapOf({ CA: plain('{$db.DATABASE.ca_text}') }), tableFor('host-node'), {
    ownScopeKeys: ownCa,
  })
  assertEquals(node.map.get('CA')?.value === SEALED_CA, true)
  assertEquals(node.map.get('CA')?.isSecret, true)
})

test('a whole url on a Postgres site is listed for the daemon; MySQL and containers are not', () => {
  const pg = applyDbRefs(mapOf({ DB_URL: plain('{$db.DATABASE.url}') }), tableFor('host-site'), {
    ownScopeKeys: none,
  })
  assertEquals(pg.siteUrlNames, ['DB_URL'])
  assertEquals(pg.map.get('DB_URL')?.value === SEALED_URL, true)
  const mysql = applyDbRefs(
    mapOf({ DB_URL: plain('{$db.DATABASE.url}') }),
    tableFor('host-site', 'mysql'),
    { ownScopeKeys: none }
  )
  assertEquals(mysql.siteUrlNames, [])
  const container = applyDbRefs(
    mapOf({ DB_URL: plain('{$db.DATABASE.url}') }),
    tableFor('container'),
    {
      ownScopeKeys: none,
    }
  )
  assertEquals(container.siteUrlNames, [])
})

test('a reference to a binding the service lacks: an error on its own scope, a warning above it', () => {
  const input = mapOf({
    OWN: plain('{$db.MISSING.host}'),
    HIGHER: plain('h={$db.MISSING.host}'),
  })
  const out = applyDbRefs(input, tableFor('container'), {
    ownScopeKeys: new Set(['OWN']),
    serviceName: 'web',
  })
  assertEquals(
    out.errors.map((e) => [e.code, e.key]),
    [['variable_unresolved', 'OWN']]
  )
  assertEquals(
    out.warnings.map((e) => [e.code, e.key]),
    [['variable_db_ref_unresolved', 'HIGHER']]
  )
  assertEquals(out.warnings[0]?.message.includes('web'), true)
  assertEquals(out.map.has('OWN'), false)
  assertEquals(out.map.has('HIGHER'), false)
})

test('a field the binding has no value for says why, naming the same-name variable hint', () => {
  const bare: BindingRefTable = new Map([['DATABASE', { ...info('container'), rows: new Map() }]])
  const out = applyDbRefs(mapOf({ OWN: plain('{$db.DATABASE.ssl_mode}') }), bare, {
    ownScopeKeys: new Set(['OWN']),
  })
  assertEquals(out.errors[0]?.code, 'variable_unresolved')
  assertEquals(out.errors[0]?.message.includes('set by hand on this service'), true)
  assertEquals(out.errors[0]?.message.includes('no database binding'), false)
})

test('a field this kind cannot have is left out with a warning when set above the service', () => {
  const out = applyDbRefs(
    mapOf({ HIGHER: plain('{$db.DATABASE.ca_text}') }),
    tableFor('host-site'),
    {
      ownScopeKeys: none,
    }
  )
  assertEquals(out.errors, [])
  assertEquals(out.warnings[0]?.code, 'variable_db_ref_unresolved')
  assertEquals(out.map.has('HIGHER'), false)
})

test('secret, binding-owned and reference-free entries are left alone', () => {
  const secret: ResolvedVariableEntry = { ...plain('{$db.DATABASE.host}'), isSecret: true }
  const owned: ResolvedVariableEntry = { ...plain('{$db.DATABASE.host}'), bindingId: 'b' }
  const out = applyDbRefs(
    mapOf({ S: secret, O: owned, P: plain('plain') }),
    tableFor('container'),
    { ownScopeKeys: none }
  )
  assertEquals(out.map.get('S'), secret)
  assertEquals(out.map.get('O'), owned)
  assertEquals(out.map.get('P')?.value, 'plain')
})

test('a reference in a build variable stops being a build variable', () => {
  const out = applyDbRefs(
    mapOf({ B: { ...plain('{$db.DATABASE.host}'), forBuild: true } }),
    tableFor('container'),
    { ownScopeKeys: none }
  )
  assertEquals(out.map.get('B')?.forBuild, false)
})

test('every scope map is expanded, and issues are reported once from the merged map', () => {
  const shared = plain('{$db.MISSING.host}')
  const merged = mapOf({ K: shared })
  const out = resolveDbRefsForService(tableFor('container'), {
    merged,
    scopes: {
      project: mapOf({ K: shared }),
      server: mapOf({ K: shared, S: plain('{$db.DATABASE.host}') }),
    },
    ownScopeKeys: none,
    serviceName: 'web',
  })
  assertEquals(out.warnings.length, 1)
  assertEquals(out.scopes.project?.has('K'), false)
  assertEquals(out.scopes.server?.get('S')?.value, 'db-in')
})

test('with no service to read from, every reference is left out', () => {
  const out = dropDbRefs(mapOf({ A: plain('{$db.DATABASE.host}'), B: plain('ok') }))
  assertEquals([...out.keys()], ['B'])
})

function parsed(raw: string): DbVariableRef {
  const result = parseExactVariableRef(raw)
  if (!result.ok || result.ref.scope !== 'db') throw new TypeError(raw)
  return result.ref
}

test('a Compose reference reads the binding row, so a secret keeps its own key', () => {
  const password: DeployVariableEntry = {
    key: 'DATABASE_PASSWORD',
    value: 'marker',
    isSecret: true,
    isLiteral: true,
    forBuild: false,
    forRuntime: true,
    bindingId: 'b-container',
  }
  const lookup = dbRefLookupFor(tableFor('container'), new Map([['DATABASE_PASSWORD', password]]))
  assertEquals(lookup(parsed('{$db.DATABASE.password}')), password)
  assertEquals(lookup(parsed('{$db.DATABASE.host}')), undefined)
  assertEquals(lookup(parsed('{$db.OTHER.host}')), undefined)
  const driver = lookup(parsed('{$db.DATABASE.driver}'))
  assertEquals(driver?.value, 'postgres')
  assertEquals(driver?.key.startsWith('TURBOPANEL_'), true)
  assertEquals(
    dbRefLookupFor(tableFor('host-site'), new Map())(parsed('{$db.DATABASE.ca_file}')),
    undefined
  )
})
