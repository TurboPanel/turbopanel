import { assertEquals } from '@std/assert'
import {
  isManagedBackupArtifactExtension,
  isManagedEngineCode,
  parseManagedStatus,
} from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isManagedEngineCode accepts only known codes', () => {
  assertEquals(isManagedEngineCode('postgres'), true)
  assertEquals(isManagedEngineCode('mysql'), true)
  assertEquals(isManagedEngineCode('redis'), true)
  assertEquals(isManagedEngineCode('Postgres'), false)
  assertEquals(isManagedEngineCode(''), false)
})

test('parseManagedStatus accepts known statuses and rejects others', () => {
  assertEquals(parseManagedStatus('ready'), 'ready')
  assertEquals(parseManagedStatus('provisioning'), 'provisioning')
  assertEquals(parseManagedStatus('applying'), 'applying')
  assertEquals(parseManagedStatus('stopped'), 'stopped')
  assertEquals(parseManagedStatus('failed'), 'failed')
  assertEquals(parseManagedStatus('weird'), null)
  assertEquals(parseManagedStatus(12), null)
  assertEquals(parseManagedStatus(null), null)
})

test('isManagedBackupArtifactExtension accepts dump/sql only', () => {
  assertEquals(isManagedBackupArtifactExtension('dump'), true)
  assertEquals(isManagedBackupArtifactExtension('sql'), true)
  assertEquals(isManagedBackupArtifactExtension('tar'), false)
  assertEquals(isManagedBackupArtifactExtension(''), false)
})
