import { assertEquals } from 'jsr:@std/assert'
import {
  isConfiguredProjectType,
  isProductionEnvironmentName,
  projectNeedsSetup,
} from './empty-setup.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('projectNeedsSetup is true when type is absent or empty', () => {
  assertEquals(projectNeedsSetup(null), true)
  assertEquals(projectNeedsSetup(undefined), true)
  assertEquals(projectNeedsSetup({}), true)
  assertEquals(projectNeedsSetup({ type: null }), true)
  assertEquals(projectNeedsSetup({ type: '' }), true)
  assertEquals(projectNeedsSetup({ type: 'empty' }), true)
})

test('projectNeedsSetup is false once a real type is set', () => {
  assertEquals(projectNeedsSetup({ type: 'docker-compose' }), false)
  assertEquals(projectNeedsSetup({ type: 'template', code: 'static-site' }), false)
  assertEquals(projectNeedsSetup({ type: 'managed', code: 'postgres' }), false)
})

test('isConfiguredProjectType accepts only configure targets', () => {
  assertEquals(isConfiguredProjectType('docker-compose'), true)
  assertEquals(isConfiguredProjectType('template'), true)
  assertEquals(isConfiguredProjectType('managed'), true)
  assertEquals(isConfiguredProjectType('empty'), false)
  assertEquals(isConfiguredProjectType('other'), false)
})

test('isProductionEnvironmentName is case-insensitive', () => {
  assertEquals(isProductionEnvironmentName('Production'), true)
  assertEquals(isProductionEnvironmentName('production'), true)
  assertEquals(isProductionEnvironmentName(' PRODUCTION '), true)
  assertEquals(isProductionEnvironmentName('Staging'), false)
  assertEquals(isProductionEnvironmentName(null), false)
})
