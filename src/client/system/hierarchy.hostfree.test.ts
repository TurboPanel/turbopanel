/**
 * Host-free coverage for system hierarchy pure helpers + race-safe workspace ensure.
 */

import { assertEquals, assertRejects } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import {
  ensureSystemWorkspace,
  findSystemEnvironmentForServer,
  isSystemSelfHostComposeServiceName,
  SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES,
} from './hierarchy.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('isSystemSelfHostComposeServiceName allowlists only stack services', () => {
  for (const name of SYSTEM_SELF_HOST_COMPOSE_SERVICE_NAMES) {
    assertEquals(isSystemSelfHostComposeServiceName(name), true)
  }
  assertEquals(isSystemSelfHostComposeServiceName('traefik'), false)
  assertEquals(isSystemSelfHostComposeServiceName('proxysql'), false)
  assertEquals(isSystemSelfHostComposeServiceName(''), false)
})

test('findSystemEnvironmentForServer returns first match or null', async () => {
  const hit = {
    execute: async () => [{ id: 'env-1' }],
  } as unknown as Db
  assertEquals(await findSystemEnvironmentForServer(hit, 'srv'), 'env-1')
  assertEquals(
    await findSystemEnvironmentForServer(hit, 'srv', 'hosting-ingress'),
    'env-1',
  )

  const miss = {
    execute: async () => [],
  } as unknown as Db
  assertEquals(await findSystemEnvironmentForServer(miss, 'srv'), null)
})

test('ensureSystemWorkspace returns insert id or existing row', async () => {
  const inserted = {
    execute: async () => [{ id: 'ws-new' }],
    select: () => {
      throw new TypeError('should not select after insert')
    },
  } as unknown as Db
  assertEquals(await ensureSystemWorkspace(inserted, 'org'), 'ws-new')

  const raced = {
    execute: async () => [],
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ id: 'ws-existing' }]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await ensureSystemWorkspace(raced, 'org'), 'ws-existing')

  const missing = {
    execute: async () => [],
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  await assertRejects(
    () => ensureSystemWorkspace(missing, 'org'),
    Error,
    'system workspace missing after insert race',
  )
})
