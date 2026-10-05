import { assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import {
  assertManagedIdle,
  assertManagedNotBusy,
  assertTargetServerOnline,
  isManagedStatus,
  requireManagedCreateServerId,
  resolveManagedTargetServerId,
  SERVER_OFFLINE_BODY,
} from './context.ts'
import { recovery } from '../../db/schema.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import { createServerPresenceDb } from './server-status-test-db.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function mockContext(registry?: unknown): Context<AppEnv> {
  return {
    get(key: string) {
      if (key === 'daemonCellRegistry') return registry
      return undefined
    },
    json(body: unknown, status?: number) {
      return Response.json(body, { status })
    },
  } as unknown as Context<AppEnv>
}

test('requireManagedCreateServerId returns the pin or 409', async () => {
  const c = mockContext()
  assertEquals(requireManagedCreateServerId(c, 'server-1'), 'server-1')

  const missing = requireManagedCreateServerId(c, null)
  if (!(missing instanceof Response)) {
    throw new TypeError('expected Response')
  }
  assertEquals(missing.status, 409)
  assertEquals(await missing.json(), { error: 'server_placement_required' })
})

test('resolveManagedTargetServerId returns managed.server_id or 409', async () => {
  const c = mockContext()
  assertEquals(resolveManagedTargetServerId(c, 'server-9'), 'server-9')

  const missing = resolveManagedTargetServerId(c, null)
  if (!(missing instanceof Response)) {
    throw new TypeError('expected Response')
  }
  assertEquals(missing.status, 409)
  assertEquals(await missing.json(), { error: 'server_placement_required' })
})

test('assertManagedNotBusy rejects applying only', async () => {
  const c = mockContext()
  assertEquals(assertManagedNotBusy(c, 'ready'), null)
  assertEquals(assertManagedNotBusy(c, null), null)

  const busy = assertManagedNotBusy(c, 'applying')
  if (!(busy instanceof Response)) {
    throw new TypeError('expected Response')
  }
  assertEquals(busy.status, 409)
  assertEquals(await busy.json(), { error: 'managed_busy' })
})

test('isManagedStatus accepts the persisted status set', () => {
  assertEquals(isManagedStatus('provisioning'), true)
  assertEquals(isManagedStatus('applying'), true)
  assertEquals(isManagedStatus('ready'), true)
  assertEquals(isManagedStatus('stopped'), true)
  assertEquals(isManagedStatus('failed'), true)
  assertEquals(isManagedStatus(null), false)
  assertEquals(isManagedStatus('weird'), false)
})

test('assertTargetServerOnline rejects offline servers', async () => {
  const c = mockContext()
  const offline = await assertTargetServerOnline(
    c,
    createServerPresenceDb('server-1', false),
    'server-1'
  )
  if (!(offline instanceof Response)) {
    throw new TypeError('expected Response')
  }
  assertEquals(offline.status, 409)
  assertEquals(await offline.json(), SERVER_OFFLINE_BODY)
})

test('assertTargetServerOnline accepts online servers', async () => {
  const c = mockContext()
  assertEquals(
    await assertTargetServerOnline(c, createServerPresenceDb('server-1', true), 'server-1'),
    null
  )
})

const MANAGED_ID = '00000000-0000-4000-8000-000000000001'

function recoveryRow(state: string) {
  return {
    id: 'rec-1',
    managedId: MANAGED_ID,
    kind: 'automatic-failover',
    sourcePrimaryMemberId: 'mem-a',
    targetMemberId: 'mem-b',
    state,
    startedAt: '2026-10-01T00:00:00.000Z',
    completedAt: null,
    metadata: {},
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }
}

test('assertManagedIdle refuses every in-flight recovery state whatever the managed status', async () => {
  for (const state of [
    'detecting',
    'fencing',
    'promoting',
    'repointing',
    'reconciling-ingress',
    'verifying',
  ]) {
    for (const status of ['ready', 'failed', 'stopped']) {
      const db = createMemoryDb([[recovery, [recoveryRow(state)]]])
      const busy = await assertManagedIdle(mockContext(), db, { id: MANAGED_ID, status })
      if (!(busy instanceof Response)) throw new TypeError(`expected 409 for ${state}/${status}`)
      assertEquals(busy.status, 409)
      assertEquals((await busy.json()).error, 'managed_busy')
    }
  }
})

test('assertManagedIdle allows a cluster whose recoveries are all terminal', async () => {
  for (const state of ['completed', 'failed', 'blocked']) {
    const db = createMemoryDb([[recovery, [recoveryRow(state)]]])
    const idle = await assertManagedIdle(mockContext(), db, { id: MANAGED_ID, status: 'ready' })
    assertEquals(idle, null)
  }
})

test('assertManagedIdle still refuses a managed row that is applying', async () => {
  const db = createMemoryDb([[recovery, []]])
  const busy = await assertManagedIdle(mockContext(), db, { id: MANAGED_ID, status: 'applying' })
  if (!(busy instanceof Response)) throw new TypeError('expected 409')
  assertEquals(busy.status, 409)
})

test('every mutating managed route that can disturb a running cluster checks the recovery journal', async () => {
  const source = await Deno.readTextFile(new URL('./routes.ts', import.meta.url))
  const handlers = new Map<string, string>()
  for (const chunk of source.split(/\n {2}router\./).slice(1)) {
    const head = /^(post|patch|delete)\('([^']+)'/.exec(chunk)
    if (head) handlers.set(`${head[1]} ${head[2]}`, chunk)
  }
  const gated = [
    'patch /environments/:id/managed',
    'post /environments/:id/managed/lifecycle',
    'delete /environments/:id/managed',
    'post /environments/:id/managed/members',
    'patch /environments/:id/managed/members/:memberId',
    'delete /environments/:id/managed/members/:memberId',
    'post /environments/:id/managed/members/:memberId/resync',
    'post /environments/:id/managed/members/:memberId/promote',
    'post /environments/:id/managed/disaster-recovery/promote',
    'post /environments/:id/managed/backups',
    'delete /environments/:id/managed/backups/:backupId',
    'post /environments/:id/managed/backups/:backupId/restore',
  ]
  // These reach the journal gate through the shared apply helpers.
  const gatedViaApply = [
    'post /environments/:id/managed/apply',
    'post /environments/:id/managed/root-password',
    'post /environments/:id/managed/users',
    'post /environments/:id/managed/users/:principalId/password',
    'delete /environments/:id/managed/users/:principalId',
    'post /environments/:id/managed/databases',
    'delete /environments/:id/managed/databases/:databaseName',
  ]
  for (const key of gatedViaApply) {
    const handler = handlers.get(key)
    if (handler === undefined) throw new TypeError(`route not found: ${key}`)
    const viaApply = /assertManagedApplyReady\(|prepareApplyForManaged\(|runApplyForManaged\(/.test(
      handler
    )
    assertEquals(viaApply, true, `${key} must go through the journal-gated apply helpers`)
  }
  for (const key of gated) {
    const handler = handlers.get(key)
    if (handler === undefined) throw new TypeError(`route not found: ${key}`)
    assertEquals(handler.includes('assertManagedIdle('), true, `${key} must check the journal`)
  }
})
