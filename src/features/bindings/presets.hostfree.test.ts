/**
 * Host-free coverage for binding name presets: the exact names and secret flags
 * per preset, engine and delivery kind, the legacy toggle and the site names.
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { computeBindingVariableSet, listBindingEmittedKeys } from './materialize.ts'
import { loadHostSiteBindingNeeds } from './host-run.ts'
import {
  BINDING_PRESETS,
  effectivePreset,
  presetEntryNames,
  presetFitsEngine,
  presetSiteNames,
  renderPresetRows,
} from './presets.ts'
import type { BindingDelivery } from './host-run.ts'
import type { ManagedSslMode } from '../managed/ssl.ts'

const test = Deno.test.bind(Deno)

const CA = '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----'

function render(
  preset: (typeof BINDING_PRESETS)[number],
  engineCode: string,
  delivery: BindingDelivery,
  sslMode: ManagedSslMode = 'require'
) {
  const result = computeBindingVariableSet({
    keyPrefix: 'DATABASE',
    preset,
    databaseName: 'appdb',
    username: 'appuser',
    password: 'pw',
    host: 'db.internal',
    port: 5432,
    caCertPem: CA,
    readSplit: false,
    engineCode,
    sslMode,
    delivery,
  })
  if ('kind' in result) throw new TypeError(result.kind)
  const prefixed = new Set(
    result.filter((row) => row.key.startsWith('DATABASE_')).map((r) => r.key)
  )
  return new Map(result.filter((row) => !prefixed.has(row.key)).map((row) => [row.key, row]))
}

function names(rows: Map<string, unknown>): string[] {
  return [...rows.keys()]
}

test('every preset fits at least one engine and lists its names', () => {
  for (const preset of BINDING_PRESETS) {
    const fitting = ['postgres', 'mysql', 'mariadb'].filter((e) => presetFitsEngine(preset, e))
    assertEquals(fitting.length > 0, true, preset)
    for (const engine of fitting) assertEquals(presetEntryNames(preset, engine).length > 0, true)
  }
})

test('plain postgres preset keeps today names and adds the CA file in verify modes', () => {
  assertEquals(names(render('postgres', 'postgres', 'container')), [
    'PGHOST',
    'PGPORT',
    'PGDATABASE',
    'PGUSER',
    'PGPASSWORD',
    'PGSSLMODE',
  ])
  const verify = render('postgres', 'postgres', 'container', 'verify-full')
  assertEquals(verify.get('PGSSLROOTCERT')?.value, '/run/secrets/DATABASE_CA_CERT')
  assertEquals(verify.get('PGSSLROOTCERT')?.isSecret, false)
  assertEquals(verify.get('PGPASSWORD')?.isSecret, true)
})

test('a legacy toggle on a native app renders today names only, in every mode', () => {
  const rows = render('postgres', 'postgres', 'host-node', 'verify-full')
  assertEquals(names(rows), ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE'])
  assertEquals(rows.get('PGHOST')?.value, '127.0.0.1')
})

test('a PHP site never stores the CA file name; the daemon fills it', () => {
  const rows = render('postgres', 'postgres', 'host-site', 'verify-full')
  assertEquals(rows.has('PGSSLROOTCERT'), false)
  assertEquals(presetSiteNames('postgres', 'postgres', 'verify-full').caFile, ['PGSSLROOTCERT'])
  assertEquals(presetSiteNames('postgres', 'postgres', 'require').caFile, [])
  assertEquals(presetSiteNames('postgres', 'postgres', null).caFile, [])
})

test('plain mysql preset is the MYSQL_ set', () => {
  assertEquals(names(render('mysql', 'mariadb', 'container')), [
    'MYSQL_HOST',
    'MYSQL_PORT',
    'MYSQL_DATABASE',
    'MYSQL_USER',
    'MYSQL_PASSWORD',
  ])
})

test('laravel preset names per engine and kind', () => {
  const pg = render('laravel', 'postgres', 'container')
  assertEquals(names(pg), [
    'DB_CONNECTION',
    'DB_HOST',
    'DB_PORT',
    'DB_DATABASE',
    'DB_USERNAME',
    'DB_PASSWORD',
    'DB_URL',
    'DB_SSLMODE',
  ])
  assertEquals(pg.get('DB_CONNECTION')?.value, 'pgsql')
  assertEquals(pg.get('DB_URL')?.isSecret, true)
  assertEquals(pg.get('DB_PASSWORD')?.isSecret, true)
  assertEquals(pg.get('DB_HOST')?.isSecret, false)
  const my = render('laravel', 'mariadb', 'container')
  assertEquals(my.get('DB_CONNECTION')?.value, 'mariadb')
  assertEquals(my.get('MYSQL_ATTR_SSL_CA')?.value, '/run/secrets/DATABASE_CA_CERT')
  assertEquals(my.has('DB_SSLMODE'), false)
  assertEquals(render('laravel', 'mysql', 'host-node').has('MYSQL_ATTR_SSL_CA'), false)
  assertEquals(render('laravel', 'mysql', 'host-site').has('MYSQL_ATTR_SSL_CA'), false)
  assertEquals(presetSiteNames('laravel', 'mysql', 'require').caFile, ['MYSQL_ATTR_SSL_CA'])
  assertEquals(presetSiteNames('laravel', 'postgres', 'verify-ca').url, ['DB_URL'])
  assertEquals(presetSiteNames('laravel', 'mysql', 'verify-ca').url, [])
})

test('wordpress preset sets the wp-config names, host with its port', () => {
  const rows = render('wordpress', 'mysql', 'container')
  assertEquals(names(rows), ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'])
  assertEquals(rows.get('DB_HOST')?.value, 'db.internal:5432')
  assertEquals(rows.get('DB_PASSWORD')?.isSecret, true)
  assertEquals(rows.get('DB_NAME')?.value, 'appdb')
  assertEquals(presetSiteNames('wordpress', 'mysql', null).required, [
    'DB_HOST',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME',
  ])
})

test('metabase preset uses mysql for both MySQL-family engines', () => {
  assertEquals(render('metabase', 'postgres', 'container').get('MB_DB_TYPE')?.value, 'postgres')
  assertEquals(render('metabase', 'mariadb', 'container').get('MB_DB_TYPE')?.value, 'mysql')
  assertEquals(render('metabase', 'mysql', 'container').get('MB_DB_TYPE')?.value, 'mysql')
  const rows = render('metabase', 'postgres', 'container')
  assertEquals(names(rows), [
    'MB_DB_TYPE',
    'MB_DB_HOST',
    'MB_DB_PORT',
    'MB_DB_DBNAME',
    'MB_DB_USER',
    'MB_DB_PASS',
  ])
  assertEquals(rows.get('MB_DB_PASS')?.isSecret, true)
})

test('uptime kuma preset: TLS switch follows the mode, CA text not on a site', () => {
  const on = render('uptime-kuma', 'mariadb', 'container', 'require')
  assertEquals(on.get('UPTIME_KUMA_DB_SSL')?.value, 'true')
  assertEquals(on.get('UPTIME_KUMA_DB_CA')?.isSecret, true)
  assertEquals(on.get('UPTIME_KUMA_DB_TYPE')?.value, 'mariadb')
  assertEquals(
    render('uptime-kuma', 'mariadb', 'container', 'disable').has('UPTIME_KUMA_DB_SSL'),
    false
  )
  assertEquals(render('uptime-kuma', 'mariadb', 'host-site').has('UPTIME_KUMA_DB_CA'), false)
  assertEquals(render('uptime-kuma', 'mariadb', 'host-node').has('UPTIME_KUMA_DB_CA'), true)
})

test('an entry whose field is missing is left out, not an error', () => {
  const rows = renderPresetRows('laravel', {
    engineCode: 'postgres',
    sslMode: null,
    fields: { host: 'h' },
  })
  assertEquals(
    rows.map((r) => r.key),
    ['DB_CONNECTION', 'DB_HOST']
  )
})

test('effectivePreset reads legacy rows by the toggle and the engine', () => {
  assertEquals(
    effectivePreset({ preset: null, isEmitEngineDefaults: true }, 'postgres'),
    'postgres'
  )
  assertEquals(effectivePreset({ preset: null, isEmitEngineDefaults: true }, 'mariadb'), 'mysql')
  assertEquals(effectivePreset({ preset: null, isEmitEngineDefaults: false }, 'postgres'), null)
  assertEquals(
    effectivePreset({ preset: 'laravel', isEmitEngineDefaults: true }, 'mysql'),
    'laravel'
  )
})

test('every preset on every fitting engine and kind has unique keys and the right secret flags', () => {
  const secretNames = new Set([
    'PGPASSWORD',
    'MYSQL_PASSWORD',
    'DB_PASSWORD',
    'DB_URL',
    'MB_DB_PASS',
    'UPTIME_KUMA_DB_PASSWORD',
    'UPTIME_KUMA_DB_CA',
  ])
  const kinds: BindingDelivery[] = ['container', 'host-site', 'host-node']
  for (const preset of BINDING_PRESETS) {
    for (const engine of ['postgres', 'mysql', 'mariadb']) {
      if (!presetFitsEngine(preset, engine)) continue
      for (const kind of kinds) {
        const rows = render(preset, engine, kind, 'verify-full')
        const listed = presetEntryNames(preset, engine)
        for (const [key, row] of rows) {
          assertEquals(listed.includes(key), true, `${preset} ${engine} ${kind} ${key}`)
          assertEquals(row.isSecret, secretNames.has(key), `${preset} ${engine} ${kind} ${key}`)
        }
      }
    }
  }
})

test('a preset name equal to a prefixed name never makes a second row of one key', () => {
  const result = computeBindingVariableSet({
    keyPrefix: 'DB',
    preset: 'wordpress',
    databaseName: 'appdb',
    username: 'appuser',
    password: 'pw',
    host: 'db.internal',
    port: 3306,
    caCertPem: CA,
    readSplit: false,
    engineCode: 'mysql',
    sslMode: 'require',
    delivery: 'container',
  })
  if ('kind' in result) throw new TypeError(result.kind)
  const keys = result.map((row) => row.key)
  assertEquals(new Set(keys).size, keys.length)
  assertEquals(result.find((row) => row.key === 'DB_HOST')?.value, 'db.internal')
})

test('swapping the preset swaps the emitted names', () => {
  const laravel = listBindingEmittedKeys({
    keyPrefix: 'DATABASE',
    preset: 'laravel',
    engineCode: 'postgres',
  })
  const metabase = listBindingEmittedKeys({
    keyPrefix: 'DATABASE',
    preset: 'metabase',
    engineCode: 'postgres',
  })
  assertEquals(laravel?.includes('DB_URL'), true)
  assertEquals(laravel?.includes('MB_DB_PASS'), false)
  assertEquals(metabase?.includes('MB_DB_PASS'), true)
  assertEquals(metabase?.includes('DB_URL'), false)
})

function needsDb(bindings: unknown[], variables: unknown[]): Db {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({ where: () => Promise.resolve(bindings) }),
        }),
        where: () => Promise.resolve(variables),
      }),
    }),
  } as unknown as Db
}

test('a PHP site gets the preset CA file and URL names to the daemon', async () => {
  const row = {
    id: 'b1',
    serviceId: 's1',
    keyPrefix: 'DATABASE',
    isEmitEngineDefaults: true,
    preset: 'laravel',
    engine: 'postgres',
  }
  const verify = await loadHostSiteBindingNeeds(
    needsDb([row], [{ bindingId: 'b1', key: 'DATABASE_SSL_MODE', value: 'verify-full' }]),
    ['s1']
  )
  assertEquals(verify.get('s1')?.urlKeys, ['DATABASE_URL', 'DB_URL'])
  assertEquals(verify.get('s1')?.caFileKeys, ['DATABASE_CA_FILE'])
  const plain = await loadHostSiteBindingNeeds(
    needsDb(
      [{ ...row, preset: null }],
      [{ bindingId: 'b1', key: 'DATABASE_SSL_MODE', value: 'verify-full' }]
    ),
    ['s1']
  )
  assertEquals(plain.get('s1')?.caFileKeys, ['DATABASE_CA_FILE', 'PGSSLROOTCERT'])
  const require = await loadHostSiteBindingNeeds(
    needsDb(
      [{ ...row, preset: null }],
      [{ bindingId: 'b1', key: 'DATABASE_SSL_MODE', value: 'require' }]
    ),
    ['s1']
  )
  assertEquals(require.get('s1')?.caFileKeys, ['DATABASE_CA_FILE'])
})
