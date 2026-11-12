/**
 * Host-free coverage for `POST /servers/:id/colocated-repair`: owner only,
 * always behind step-up, self-hosted only, audited, and every refusal a
 * plain message. The repair itself runs on fakes (no database, no state dir);
 * its own rules are covered in `colocated-self-repair.hostfree.test.ts`.
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import type { Db } from '../../db/connection.ts'
import { audit, organization, server, verification } from '../../db/schema.ts'
import { createMemoryDb } from '../../test-fixtures/memory-db.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
  seedMockUser,
} from '../authn/authn-hostfree-doubles.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { stampStepUp } from '../authn/step-up.ts'
import type {
  ColocatedDiskState,
  ColocatedRepairDisk,
  ColocatedRepairQueries,
  ColocatedRepairStore,
  ColocatedSeat,
} from '../authn/colocated-self-repair.ts'
import {
  COLOCATED_REPAIR_COOLDOWN_MS,
  COLOCATED_REPAIR_REFUSAL_MESSAGES,
  colocatedRepairResponse,
  colocatedRepairTooSoon,
  registerServerColocatedRepairRoutes,
} from './colocated-repair-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG = '44444444-4444-4444-8444-444444444444'
const COLOCATED = '44444444-4444-4444-8444-4444444400c1'
const OTHER = '44444444-4444-4444-8444-4444444400f1'
const SEAT: ColocatedSeat = {
  licenseId: '44444444-4444-4444-8444-4444444400a1',
  serverId: COLOCATED,
}
const NOW = '2026-11-03T12:00:00.000Z'

/** Files from another database: both ids foreign, a key id the panel never saw. */
const FOREIGN_DISK: ColocatedDiskState = {
  licenseId: '44444444-4444-4444-8444-4444444400fa',
  licenseToken: 'foreign-token',
  serverId: '44444444-4444-4444-8444-4444444400fb',
  keyId: 'foreign-key',
  keyFingerprint: undefined,
}

type Fixture = {
  allowed?: boolean
  runtime?: 'deno' | 'workers'
  /** Session inside the step-up window. */
  stepUpDone?: boolean
  revoked?: boolean
  write?: boolean
  /** The route's clock, in ms; tests move it to step past the cooldown. */
  clock?: { at: number }
}

function fakeRepair(fx: Fixture) {
  const events: string[] = []
  const written: string[] = []
  const queries: ColocatedRepairQueries = {
    findSeat: () => Promise.resolve(SEAT),
    storedKey: () =>
      Promise.resolve({ id: 'key-stored', fingerprint: 'fp-stored', active: !fx.revoked }),
    licenseTokenHash: () => Promise.resolve(null),
    verifyToken: () => Promise.resolve(false),
    licenseExists: () => Promise.resolve(false),
    serverExists: () => Promise.resolve(false),
    rotateToken: () => {
      events.push('rotate')
      return Promise.resolve('reissued-secret-token')
    },
    clearKey: (_serverId, keyId) => {
      events.push(`clear:${keyId}`)
      return Promise.resolve(true)
    },
  }
  const store: ColocatedRepairStore = {
    ...queries,
    locked: (fn) => {
      events.push('lock')
      return fn(queries)
    },
  }
  const disk: ColocatedRepairDisk = {
    assertWritable: () => {},
    hasDaemonFiles: () => Promise.resolve(true),
    read: () => Promise.resolve(FOREIGN_DISK),
    write: (seat, token) => {
      written.push(`${seat.licenseId}/${seat.serverId}/${token}`)
      return Promise.resolve(fx.write ?? true)
    },
  }
  return { store, disk, events, written }
}

async function buildApp(fx: Fixture = {}) {
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const sessionId = crypto.randomUUID()
  const email = 'owner@example.com'
  const state = createEmptyMockAuthState()
  // An old session: step-up is needed unless the fixture stamps one.
  seedMockSession(state, token, {
    sessionId,
    userId,
    email,
    role: 'user',
    createdAt: '2020-01-01T00:00:00.000Z',
  })
  seedMockUser(state, { id: userId, email, isDisabled: false, isEmailVerified: true, role: 'user' })
  state.organizations.push({ id: ORG, name: 'Repair Org' })
  // `execute` answers the `organization:own` grant probe.
  const authDb = Object.assign(createMockAuthDb(state), {
    execute: () => Promise.resolve([{ allowed: fx.allowed ?? true }]),
  }) as unknown as Db
  const serverRow = (id: string) => ({
    id,
    organizationId: ORG,
    name: id === COLOCATED ? 'This Server' : 'edge-1',
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
  })
  const db = createMemoryDb(
    [
      [server, [serverRow(COLOCATED), serverRow(OTHER)]],
      [organization, [{ id: ORG, name: 'Repair Org', createdAt: NOW, updatedAt: NOW }]],
      [verification, []],
      [audit, []],
    ],
    { fallback: authDb }
  )
  if (fx.stepUpDone) await stampStepUp(db, sessionId, 'password')

  const repair = fakeRepair(fx)
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('runtime', fx.runtime ?? 'deno')
    return next()
  })
  registerServerColocatedRepairRoutes(
    app,
    { secrets, runtime: fx.runtime ?? 'deno', signupEnvOverride: undefined },
    {
      store: () => repair.store,
      disk: () => repair.disk,
      now: () => fx.clock?.at ?? Date.parse(NOW),
    }
  )
  const headers = {
    Cookie: `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`,
    [ORG_ID_HEADER]: ORG,
    'content-type': 'application/json',
  }
  const post = (id: string) =>
    Promise.resolve(app.request(`/servers/${id}/colocated-repair`, { method: 'POST', headers }))
  return { db, post, ...repair }
}

test('repair: the owner repairs foreign files onto the same seat and it is audited', async () => {
  const { db, post, events, written } = await buildApp({ stepUpDone: true })
  const res = await post(COLOCATED)
  assertEquals(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assertEquals(body.ok, true)
  assertEquals(body.serverId, COLOCATED)
  assertEquals(body.clearedKey, true)
  // The token goes to the files only, never into the answer or the audit row.
  assertEquals(JSON.stringify(body).includes('reissued-secret-token'), false)
  assertEquals(events, ['lock', 'rotate', 'clear:key-stored'])
  assertEquals(written, [`${SEAT.licenseId}/${COLOCATED}/reissued-secret-token`])
  const rows = db.rows(audit)
  assertEquals(rows.length, 1)
  assertEquals(rows[0]?.action, 'server.colocated_repair')
  assertEquals(rows[0]?.targetId, COLOCATED)
  assertEquals(JSON.stringify(rows[0]?.context).includes('reissued-secret-token'), false)
})

test('repair: step-up is always required, whatever the organization switch says', async () => {
  const { post, events } = await buildApp()
  const res = await post(COLOCATED)
  assertEquals(res.status, 403)
  const body = (await res.json()) as { code: string; action: string }
  assertEquals([body.code, body.action], ['reauth_required', 'server.colocated_repair'])
  assertEquals(events, [])
})

test('repair: someone who is not the owner is refused before anything runs', async () => {
  const { post, events } = await buildApp({ allowed: false, stepUpDone: true })
  assertEquals((await post(COLOCATED)).status, 403)
  assertEquals(events, [])
})

test('repair: refused on High Availability', async () => {
  const { post, events } = await buildApp({ runtime: 'workers', stepUpDone: true })
  const res = await post(COLOCATED)
  assertEquals(res.status, 409)
  assertEquals(((await res.json()) as { code: string }).code, 'not_deno')
  assertEquals(events, [])
})

test('repair: another server is refused with a plain message', async () => {
  const { db, post, events } = await buildApp({ stepUpDone: true })
  const res = await post(OTHER)
  assertEquals(res.status, 409)
  const body = (await res.json()) as { code: string; error: string }
  assertEquals(body.code, 'not_colocated_server')
  assertEquals(body.error, COLOCATED_REPAIR_REFUSAL_MESSAGES.not_colocated_server)
  assertEquals(events, [])
  // A refused attempt is audited too, with the refusal code.
  const rows = db.rows(audit)
  assertEquals(rows.length, 1)
  assertEquals(rows[0]?.targetId, OTHER)
  assertEquals(rows[0]?.context, { result: 'refused', code: 'not_colocated_server' })
})

test('repair: a refusal on High Availability is audited', async () => {
  const { db, post } = await buildApp({ runtime: 'workers', stepUpDone: true })
  assertEquals((await post(COLOCATED)).status, 409)
  assertEquals(db.rows(audit)[0]?.context, { result: 'refused', code: 'not_deno' })
})

test('repair: repeated presses on High Availability are held by the cooldown, not audited each time', async () => {
  const clock = { at: Date.parse(NOW) }
  const { db, post } = await buildApp({ runtime: 'workers', stepUpDone: true, clock })
  assertEquals((await post(COLOCATED)).status, 409)
  clock.at += 1_000
  assertEquals((await post(COLOCATED)).status, 429)
  assertEquals((await post(COLOCATED)).status, 429)
  assertEquals(db.rows(audit).length, 1)
  clock.at += COLOCATED_REPAIR_COOLDOWN_MS
  assertEquals((await post(COLOCATED)).status, 409)
  assertEquals(db.rows(audit).length, 2)
})

test('repair: two presses at once run the repair only once', async () => {
  const { db, post, events } = await buildApp({ stepUpDone: true })
  const [first, second] = await Promise.all([post(COLOCATED), post(COLOCATED)])
  assertEquals(
    [first.status, second.status].sort((a, b) => a - b),
    [200, 429]
  )
  assertEquals(events, ['lock', 'rotate', 'clear:key-stored'])
  assertEquals(db.rows(audit).length, 1)
})

test('repair: a second press on the same server inside the cooldown is a plain 429', async () => {
  const clock = { at: Date.parse(NOW) }
  const { db, post, events } = await buildApp({ stepUpDone: true, clock })
  assertEquals((await post(COLOCATED)).status, 200)
  clock.at += 20_000
  const again = await post(COLOCATED)
  assertEquals(again.status, 429)
  assertEquals(again.headers.get('Retry-After'), '40')
  assertEquals(await again.json(), colocatedRepairTooSoon(40))
  // Nothing ran the second time, and only the press that ran is audited.
  assertEquals(events, ['lock', 'rotate', 'clear:key-stored'])
  assertEquals(db.rows(audit).length, 1)
  // Another server is not held back by this one's cooldown.
  assertEquals((await post(OTHER)).status, 409)
  clock.at += COLOCATED_REPAIR_COOLDOWN_MS
  assertEquals((await post(COLOCATED)).status, 200)
})

test('the cooldown message says how long to wait', () => {
  assertEquals(colocatedRepairTooSoon(0.2), {
    error: 'Repair Connection ran a moment ago. Try again in 1 second.',
    code: 'too_soon',
    retryAfterSeconds: 1,
  })
  assertEquals(colocatedRepairTooSoon(59.5).retryAfterSeconds, 60)
})

test('repair: a revoked key is refused and nothing is written', async () => {
  const { post, events, written } = await buildApp({ stepUpDone: true, revoked: true })
  const res = await post(COLOCATED)
  assertEquals(res.status, 409)
  assertEquals(((await res.json()) as { code: string }).code, 'daemon_key_revoked')
  assertEquals(events, ['lock'])
  assertEquals(written, [])
})

test('repair: a server outside the organization is not found', async () => {
  const { post } = await buildApp({ stepUpDone: true })
  assertEquals((await post('44444444-4444-4444-8444-4444444400ee')).status, 404)
})

test('repair: a failed file write is a 500 and is audited', async () => {
  const { db, post } = await buildApp({ stepUpDone: true, write: false })
  const res = await post(COLOCATED)
  assertEquals(res.status, 500)
  assertEquals(((await res.json()) as { code: string }).code, 'write_failed')
  assertEquals(db.rows(audit)[0]?.context, {
    result: 'failed',
    reason: 'could not write license files',
  })
})

test('every refusal code has a message', () => {
  for (const [code, message] of Object.entries(COLOCATED_REPAIR_REFUSAL_MESSAGES)) {
    const answer = colocatedRepairResponse({
      status: 'refused',
      code: code as keyof typeof COLOCATED_REPAIR_REFUSAL_MESSAGES,
    })
    assertEquals(answer.status, 409)
    assertEquals(answer.body, { error: message, code })
  }
})
