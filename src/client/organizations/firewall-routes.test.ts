/**
 * Organization firewall routes against a real database: owners and managers
 * only (a read-only member and another organization's manager are refused),
 * the policy defaults to observe-friendly values, rules validate on the way in
 * and stay inside their organization, a server's mode starts as `observe` and
 * each change raises its generation, and the 200-rule cap holds. Skips
 * without TURBOPANEL_DATABASE_URL.
 */

import { skipWithoutDatabase } from '../../test-fixtures/require-service.ts'
import { assertEquals, assertGreaterOrEqual } from '@std/assert'
import { eq, inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { audit, bulwark, edict, grant, ip, organization, server, user } from '../../db/schema.ts'
import { nextBulwarkGeneration } from '../../features/firewall/records.ts'
import { MAX_FIREWALL_RULES_PER_ORG } from '../../features/firewall/vocabulary.ts'
import { setTcpProbe, type TcpProbe } from '../../platform/ports/tcp-probe.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { registerOrganizationFirewallRoutes } from './firewall-routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>

type Fixture = {
  db: Db
  app: Hono<AppEnv>
  orgA: string
  orgB: string
  serverA: string
  serverB: string
  ownerCookie: string
  managerCookie: string
  memberCookie: string
  otherManagerCookie: string
}

type Called = { status: number; body: Record<string, unknown> }

async function insertUser(db: Db, organizationId: string, permission: string): Promise<string> {
  const [row] = await db
    .insert(user)
    .values({
      email: `firewall-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: row!.id,
    permission,
  })
  return row!.id
}

async function insertServer(db: Db, organizationId: string, name: string): Promise<string> {
  const now = new Date().toISOString()
  const [row] = await db
    .insert(server)
    .values({ organizationId, name, createdAt: now, updatedAt: now, statusChangedAt: now })
    .returning({ id: server.id })
  return row!.id
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('firewall route tests')
    return
  }
  const db = createDenoDb()
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerOrganizationFirewallRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })

  const orgs = await db
    .insert(organization)
    .values([{ name: 'Firewall Org A' }, { name: 'Firewall Org B' }])
    .returning({ id: organization.id })
  const [orgA, orgB] = [orgs[0]!.id, orgs[1]!.id]
  const userIds: string[] = []
  try {
    const ids = {
      owner: await insertUser(db, orgA, 'organization:own'),
      manager: await insertUser(db, orgA, 'organization:manage'),
      member: await insertUser(db, orgA, 'organization:read'),
      otherManager: await insertUser(db, orgB, 'organization:manage'),
    }
    userIds.push(...Object.values(ids))
    const cookie = async (userId: string) => {
      const { token } = await createSession(db, userId, {})
      return `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
    }
    await fn({
      db,
      app,
      orgA,
      orgB,
      serverA: await insertServer(db, orgA, 'Firewall Server A'),
      serverB: await insertServer(db, orgB, 'Firewall Server B'),
      ownerCookie: await cookie(ids.owner),
      managerCookie: await cookie(ids.manager),
      memberCookie: await cookie(ids.member),
      otherManagerCookie: await cookie(ids.otherManager),
    })
  } finally {
    await db.delete(audit).where(inArray(audit.organizationId, [orgA, orgB]))
    // A server restricts its organization's deletion, so servers go first.
    await db.delete(server).where(inArray(server.organizationId, [orgA, orgB]))
    await db.delete(organization).where(inArray(organization.id, [orgA, orgB]))
    if (userIds.length > 0) await db.delete(user).where(inArray(user.id, userIds))
    await endDbConnection(db)
  }
}

async function call(
  f: Fixture,
  method: string,
  path: string,
  cookie: string | null,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<Called> {
  const res = await f.app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const ALLOW_SSH = {
  label: 'Allow SSH',
  scope: 'host',
  action: 'accept',
  proto: 'tcp',
  ports: '22',
  sourceKind: 'any',
}

test('every firewall route refuses a request without a session', async () => {
  await withFixture(async (f) => {
    for (const [method, path] of [
      ['GET', `/organizations/${f.orgA}/firewall`],
      ['PUT', `/organizations/${f.orgA}/firewall`],
      ['GET', `/organizations/${f.orgA}/firewall/rules`],
      ['POST', `/organizations/${f.orgA}/firewall/rules`],
      ['GET', `/organizations/${f.orgA}/firewall/servers/${f.serverA}`],
    ]) {
      assertEquals((await call(f, method!, path!, null, {})).status, 401, `${method} ${path}`)
    }
  })
})

test("a read-only member and another organization's manager are refused", async () => {
  await withFixture(async (f) => {
    for (const cookie of [f.memberCookie, f.otherManagerCookie]) {
      assertEquals((await call(f, 'GET', `/organizations/${f.orgA}/firewall`, cookie)).status, 403)
      assertEquals(
        (
          await call(f, 'PUT', `/organizations/${f.orgA}/firewall`, cookie, {
            inputDefault: 'drop',
          })
        ).status,
        403
      )
      assertEquals(
        (await call(f, 'GET', `/organizations/${f.orgA}/firewall/rules`, cookie)).status,
        403
      )
      assertEquals(
        (await call(f, 'POST', `/organizations/${f.orgA}/firewall/rules`, cookie, ALLOW_SSH))
          .status,
        403
      )
      assertEquals(
        (
          await call(f, 'PUT', `/organizations/${f.orgA}/firewall/servers/${f.serverA}`, cookie, {
            mode: 'managed',
          })
        ).status,
        403
      )
    }
    assertEquals((await db_count(f)).rules, 0)
    assertEquals((await db_count(f)).bulwarks, 0)
  })
})

async function db_count(f: Fixture): Promise<{ rules: number; bulwarks: number }> {
  const rules = await f.db
    .select({ id: edict.id })
    .from(edict)
    .where(eq(edict.organizationId, f.orgA))
  const bulwarks = await f.db
    .select({ id: bulwark.id })
    .from(bulwark)
    .where(eq(bulwark.serverId, f.serverA))
  return { rules: rules.length, bulwarks: bulwarks.length }
}

test('narrowing SSH to a list without the caller is refused unless acknowledged', async () => {
  await withFixture(async (f) => {
    const path = `/organizations/${f.orgA}/firewall`
    const me = { 'X-Real-IP': '198.51.100.4' }
    const narrow = { sshSources: ['203.0.113.0/24'] }
    const refused = await call(f, 'PUT', path, f.ownerCookie, narrow, me)
    assertEquals(refused.status, 409)
    assertEquals(refused.body.error, 'firewall_ssh_excludes_you')
    assertEquals((await call(f, 'GET', path, f.ownerCookie)).body.policy, {
      inputDefault: 'accept',
      ipv6: 'mirror',
      sshSources: ['any'],
    })
    const covered = await call(
      f,
      'PUT',
      path,
      f.ownerCookie,
      { sshSources: ['198.51.100.0/24'] },
      me
    )
    assertEquals(covered.status, 200)
    const forced = await call(
      f,
      'PUT',
      path,
      f.ownerCookie,
      { ...narrow, acknowledgeSshExcludesMe: true },
      me
    )
    assertEquals(forced.status, 200)
  })
})

test('the policy starts observe-friendly, and an owner or a manager may change it', async () => {
  await withFixture(async (f) => {
    const path = `/organizations/${f.orgA}/firewall`
    const first = await call(f, 'GET', path, f.managerCookie)
    assertEquals(first.status, 200)
    assertEquals(first.body.policy, { inputDefault: 'accept', ipv6: 'mirror', sshSources: ['any'] })

    const byManager = await call(f, 'PUT', path, f.managerCookie, {
      sshSources: ['203.0.113.0/24'],
    })
    assertEquals(byManager.status, 200)
    const byOwner = await call(f, 'PUT', path, f.ownerCookie, { ipv6: 'skip' })
    assertEquals(byOwner.body.policy, {
      inputDefault: 'accept',
      ipv6: 'skip',
      sshSources: ['203.0.113.0/24'],
    })

    for (const bad of [{}, { inputDefault: 'maybe' }, { sshSources: ['any', '10.0.0.0/8'] }]) {
      const res = await call(f, 'PUT', path, f.managerCookie, bad)
      assertEquals(res.status, 400, JSON.stringify(bad))
      assertEquals(res.body.error, 'firewall_policy_invalid')
    }
    assertEquals((await call(f, 'GET', path, f.managerCookie)).body.policy, byOwner.body.policy)
  })
})

test('a rule is created, listed, changed and deleted, and its fields are normalised', async () => {
  await withFixture(async (f) => {
    const base = `/organizations/${f.orgA}/firewall/rules`
    const created = await call(f, 'POST', base, f.managerCookie, {
      ...ALLOW_SSH,
      ports: ' 5432-5440 ',
      sourceKind: 'addresses',
      sourceAddresses: ['192.0.2.9', '2001:db8::/32'],
      serverId: f.serverA,
    })
    assertEquals(created.status, 201)
    const rule = created.body.rule as Record<string, unknown>
    assertEquals(rule.ports, '5432-5440')
    assertEquals(rule.serverId, f.serverA)
    assertEquals(rule.isEnabled, true)
    assertEquals(rule.sourceAddresses, ['192.0.2.9/32', '2001:db8::/32'])

    const listed = await call(f, 'GET', base, f.ownerCookie)
    assertEquals((listed.body.rules as unknown[]).length, 1)

    const ruleId = rule.id as string
    const patched = await call(f, 'PATCH', `${base}/${ruleId}`, f.managerCookie, {
      isEnabled: false,
      label: 'Allow DB',
    })
    assertEquals((patched.body.rule as Record<string, unknown>).isEnabled, false)
    assertEquals((patched.body.rule as Record<string, unknown>).label, 'Allow DB')
    assertEquals((patched.body.rule as Record<string, unknown>).sourceAddresses, [
      '192.0.2.9/32',
      '2001:db8::/32',
    ])

    const deleted = await call(f, 'DELETE', `${base}/${ruleId}`, f.managerCookie)
    assertEquals(deleted.body, { ok: true })
    assertEquals((await call(f, 'DELETE', `${base}/${ruleId}`, f.managerCookie)).status, 404)
    assertEquals(((await call(f, 'GET', base, f.ownerCookie)).body.rules as unknown[]).length, 0)
  })
})

test('a rule that breaks a rule of the model is refused with a plain message', async () => {
  await withFixture(async (f) => {
    const base = `/organizations/${f.orgA}/firewall/rules`
    const refused: Array<[string, Record<string, unknown>]> = [
      ['port too high', { ports: '70000' }],
      ['descending range', { ports: '90-80' }],
      ['ports with proto any', { proto: 'any' }],
      ['allow without ports', { ports: undefined }],
      ['non-address source', { sourceKind: 'addresses', sourceAddresses: ['not-an-ip'] }],
      ['any inside the list', { sourceKind: 'addresses', sourceAddresses: ['any'] }],
      ['addresses without the kind', { sourceAddresses: ['10.0.0.1'] }],
      ['bad label', { label: 'semi;colon' }],
      ['unknown action', { action: 'allow' }],
      ['server of another organization', { serverId: f.serverB }],
      ['server that is not a uuid', { serverId: 'abc' }],
    ]
    for (const [name, override] of refused) {
      const res = await call(f, 'POST', base, f.managerCookie, { ...ALLOW_SSH, ...override })
      assertEquals(res.status, 400, name)
    }
    assertEquals((await db_count(f)).rules, 0)
  })
})

test('a rule of another organization is not found, and a patch is re-checked as a whole', async () => {
  await withFixture(async (f) => {
    const created = await call(
      f,
      'POST',
      `/organizations/${f.orgA}/firewall/rules`,
      f.managerCookie,
      ALLOW_SSH
    )
    const ruleId = (created.body.rule as Record<string, unknown>).id as string

    const foreign = `/organizations/${f.orgB}/firewall/rules/${ruleId}`
    assertEquals(
      (await call(f, 'PATCH', foreign, f.otherManagerCookie, { isEnabled: false })).status,
      404
    )
    assertEquals((await call(f, 'DELETE', foreign, f.otherManagerCookie)).status, 404)
    assertEquals(
      (
        (await call(f, 'GET', `/organizations/${f.orgB}/firewall/rules`, f.otherManagerCookie)).body
          .rules as unknown[]
      ).length,
      0
    )

    const own = `/organizations/${f.orgA}/firewall/rules/${ruleId}`
    assertEquals((await call(f, 'PATCH', own, f.managerCookie, { ports: null })).status, 400)
    assertEquals((await call(f, 'PATCH', own, f.managerCookie, { proto: 'any' })).status, 400)
    assertEquals(
      (await call(f, 'PATCH', own, f.managerCookie, { serverId: f.serverB })).status,
      400
    )
    assertEquals((await call(f, 'PATCH', own, f.managerCookie, {})).status, 400)
    assertEquals(
      (
        await call(
          f,
          'PATCH',
          `/organizations/${f.orgA}/firewall/rules/not-a-uuid`,
          f.managerCookie,
          { isEnabled: false }
        )
      ).status,
      404
    )
    const still = (await call(f, 'GET', `/organizations/${f.orgA}/firewall/rules`, f.managerCookie))
      .body.rules as Array<Record<string, unknown>>
    assertEquals(still[0]!.ports, '22')
    assertEquals(still[0]!.proto, 'tcp')
  })
})

test('an organization may hold at most 200 rules', async () => {
  await withFixture(async (f) => {
    await f.db.insert(edict).values(
      Array.from({ length: MAX_FIREWALL_RULES_PER_ORG }, (_, index) => ({
        organizationId: f.orgA,
        label: `Rule ${index}`,
        scope: 'host',
        action: 'drop',
        proto: 'any',
        sourceKind: 'any',
      }))
    )
    const over = await call(
      f,
      'POST',
      `/organizations/${f.orgA}/firewall/rules`,
      f.managerCookie,
      ALLOW_SSH
    )
    assertEquals(over.status, 409)
    assertEquals(over.body.error, 'firewall_rule_limit')
    const other = await call(
      f,
      'POST',
      `/organizations/${f.orgB}/firewall/rules`,
      f.otherManagerCookie,
      ALLOW_SSH
    )
    assertEquals(other.status, 201)
  })
})

test('a server reports observe until it is configured, and each mode change raises its generation', async () => {
  await withFixture(async (f) => {
    const path = `/organizations/${f.orgA}/firewall/servers/${f.serverA}`
    const fresh = await call(f, 'GET', path, f.managerCookie)
    assertEquals(fresh.body.bulwark, {
      serverId: f.serverA,
      mode: 'observe',
      generation: 0,
      lastDigest: null,
      lastResult: null,
      state: 'idle',
      deadlineAt: null,
      lastAppliedAt: null,
      confirmedAt: null,
    })
    assertEquals((await db_count(f)).bulwarks, 0)

    const managed = await call(f, 'PUT', path, f.managerCookie, { mode: 'managed' })
    assertEquals((managed.body.bulwark as Record<string, unknown>).mode, 'managed')
    assertEquals((managed.body.bulwark as Record<string, unknown>).generation, 1)
    const off = await call(f, 'PUT', path, f.ownerCookie, { mode: 'off' })
    assertEquals((off.body.bulwark as Record<string, unknown>).generation, 2)
    const audited = await f.db
      .select({ action: audit.action, context: audit.context })
      .from(audit)
      .where(eq(audit.targetId, f.serverA))
      .orderBy(audit.id)
    assertEquals(
      audited.filter((row) => row.action === 'server.firewall_mode.set').map((row) => row.context),
      [{ mode: 'managed' }, { mode: 'off' }]
    )

    for (const bad of [{ mode: 'drop' }, { mode: 5 }, {}]) {
      assertEquals(
        (await call(f, 'PUT', path, f.managerCookie, bad)).status,
        400,
        JSON.stringify(bad)
      )
    }
    assertEquals(
      ((await call(f, 'GET', path, f.managerCookie)).body.bulwark as Record<string, unknown>)
        .generation,
      2
    )
  })
})

test('a server of another organization, or a bad id, is not found', async () => {
  await withFixture(async (f) => {
    for (const serverId of [f.serverB, 'nope', crypto.randomUUID()]) {
      const path = `/organizations/${f.orgA}/firewall/servers/${serverId}`
      assertEquals((await call(f, 'GET', path, f.managerCookie)).status, 404, serverId)
      assertEquals(
        (await call(f, 'PUT', path, f.managerCookie, { mode: 'managed' })).status,
        404,
        serverId
      )
    }
    assertEquals(
      (await f.db.select({ id: bulwark.id }).from(bulwark).where(eq(bulwark.serverId, f.serverB)))
        .length,
      0
    )
  })
})

test('the generation counter never repeats or goes backwards under concurrent changes', async () => {
  await withFixture(async (f) => {
    const taken = await Promise.all(
      Array.from({ length: 12 }, () => nextBulwarkGeneration(f.db, f.serverA))
    )
    assertEquals(
      [...taken].sort((a, b) => a - b),
      Array.from({ length: 12 }, (_, i) => i + 1)
    )
    const [row] = await f.db.select().from(bulwark).where(eq(bulwark.serverId, f.serverA))
    assertEquals(row!.generation, 12)
    assertEquals(row!.mode, 'observe')
    assertEquals(await nextBulwarkGeneration(f.db, f.serverA), 13)
  })
})

test('deleting a server removes its state and the rules pinned to it, but not organization-wide rules', async () => {
  await withFixture(async (f) => {
    const base = `/organizations/${f.orgA}/firewall/rules`
    await call(f, 'POST', base, f.managerCookie, { ...ALLOW_SSH, serverId: f.serverA })
    await call(f, 'POST', base, f.managerCookie, ALLOW_SSH)
    await call(
      f,
      'PUT',
      `/organizations/${f.orgA}/firewall/servers/${f.serverA}`,
      f.managerCookie,
      { mode: 'managed' }
    )
    await f.db.delete(server).where(eq(server.id, f.serverA))
    const remaining = (await call(f, 'GET', base, f.managerCookie)).body.rules as Array<
      Record<string, unknown>
    >
    assertEquals(remaining.length, 1)
    assertEquals(remaining[0]!.serverId, null)
    assertEquals(
      (await f.db.select({ id: bulwark.id }).from(bulwark).where(eq(bulwark.serverId, f.serverA)))
        .length,
      0
    )
  })
})

type Dialed = { address: string; port: number }

/** A stand-in for the platform's TCP probe: records every dial, answers from `open`. */
function fakeProbe(open: (target: Dialed) => boolean): { dialed: Dialed[] } {
  const dialed: Dialed[] = []
  const probe: TcpProbe = {
    canReachPrivate: false,
    connect: (target) => {
      dialed.push({ address: target.address, port: target.port })
      return Promise.resolve(
        open(target) ? { state: 'open', ms: 9 } : { state: 'timeout', ms: null }
      )
    },
  }
  setTcpProbe(probe)
  return { dialed }
}

async function insertAddress(db: Db, organizationId: string, serverId: string, address: string) {
  await db
    .insert(ip)
    .values({ organizationId, serverId, address, allocation: 'dedicated', scope: 'public' })
}

async function withProbeFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  await withFixture(async (f) => {
    try {
      await fn(f)
    } finally {
      setTcpProbe(null)
      await f.db.delete(ip).where(inArray(ip.organizationId, [f.orgA, f.orgB]))
    }
  })
}

const probePath = (f: Fixture, serverId = f.serverA) =>
  `/organizations/${f.orgA}/firewall/servers/${serverId}/probe`

test('the outside check refuses no-session, a read-only member, another organization and a foreign server', async () => {
  await withProbeFixture(async (f) => {
    const { dialed } = fakeProbe(() => true)
    assertEquals((await call(f, 'POST', probePath(f), null, {})).status, 401)
    assertEquals((await call(f, 'POST', probePath(f), f.memberCookie, {})).status, 403)
    assertEquals((await call(f, 'POST', probePath(f), f.otherManagerCookie, {})).status, 403)
    assertEquals((await call(f, 'POST', probePath(f, f.serverB), f.ownerCookie, {})).status, 404)
    assertEquals((await call(f, 'POST', probePath(f, 'not-a-uuid'), f.ownerCookie, {})).status, 404)
    assertEquals(dialed, [])
    assertEquals((await db_count(f)).bulwarks, 0)
  })
})

test('with no outside vantage the check answers 503 and records nothing', async () => {
  await withProbeFixture(async (f) => {
    setTcpProbe(null)
    const res = await call(f, 'POST', probePath(f), f.ownerCookie, {})
    assertEquals(res.status, 503)
    assertEquals(res.body.error, 'firewall_probe_unavailable')
    assertEquals((await db_count(f)).bulwarks, 0)
  })
})

test("the check dials only the server's own stored, dialable addresses at its planned ports", async () => {
  await withProbeFixture(async (f) => {
    await insertAddress(f.db, f.orgA, f.serverA, '93.184.216.34')
    await insertAddress(f.db, f.orgA, f.serverA, '127.0.0.1')
    await insertAddress(f.db, f.orgA, f.serverA, '169.254.169.254')
    await insertAddress(f.db, f.orgA, f.serverA, '10.1.2.3')
    await insertAddress(f.db, f.orgB, f.serverB, '1.1.1.1')
    const { dialed } = fakeProbe((target) => target.port === 22)

    const res = await call(f, 'POST', probePath(f), f.managerCookie, {})
    assertEquals(res.status, 200)
    assertEquals(dialed, [{ address: '93.184.216.34', port: 22 }])
    const probe = res.body.probe as {
      phase: string
      status: string
      ports: Record<string, unknown>[]
    }
    assertEquals([probe.phase, probe.status], ['manual', 'done'])
    assertEquals(
      probe.ports.map((p) => [p.port, p.role, p.state]),
      [[22, 'invariant', 'open']]
    )
    assertEquals(res.body.autoConfirmPossible, true)

    const read = await call(
      f,
      'GET',
      `/organizations/${f.orgA}/firewall/servers/${f.serverA}`,
      f.ownerCookie
    )
    assertEquals((read.body.probe as { at: string }).at, (probe as unknown as { at: string }).at)
  })
})

test('a server with no stored address reports nothing reachable and cannot be auto-confirmed', async () => {
  await withProbeFixture(async (f) => {
    const { dialed } = fakeProbe(() => true)
    const res = await call(f, 'POST', probePath(f), f.ownerCookie, {})
    assertEquals(res.status, 200)
    assertEquals(dialed, [])
    assertEquals(res.body.autoConfirmPossible, false)
    const probe = res.body.probe as { ports: Record<string, unknown>[]; notes: string[] }
    assertEquals(
      probe.ports.map((p) => p.state),
      ['blocked']
    )
    assertEquals(
      probe.notes.includes('This server has no address the control plane can check'),
      true
    )
  })
})

test('a second check inside thirty seconds is refused with Retry-After and dials nothing', async () => {
  await withProbeFixture(async (f) => {
    await insertAddress(f.db, f.orgA, f.serverA, '93.184.216.34')
    const { dialed } = fakeProbe(() => true)
    assertEquals((await call(f, 'POST', probePath(f), f.ownerCookie, {})).status, 200)
    const dialedOnce = dialed.length

    const res = await f.app.request(probePath(f), {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: f.ownerCookie },
      body: '{}',
    })
    assertEquals(res.status, 429)
    assertEquals(res.headers.get('retry-after'), '30')
    assertEquals(((await res.json()) as { error: string }).error, 'firewall_probe_rate_limited')
    assertEquals(dialed.length, dialedOnce)

    await f.db.execute(sql`
      UPDATE bulwark
      SET last_result = jsonb_set(last_result, '{probe,at}', to_jsonb(now() - interval '31 seconds'))
      WHERE server_id = ${f.serverA}::uuid
    `)
    assertEquals((await call(f, 'POST', probePath(f), f.ownerCookie, {})).status, 200)
    assertGreaterOrEqual(dialed.length, dialedOnce * 2)
  })
})

test('a check keeps the stored preview beside it instead of replacing it', async () => {
  await withProbeFixture(async (f) => {
    await insertAddress(f.db, f.orgA, f.serverA, '93.184.216.34')
    await nextBulwarkGeneration(f.db, f.serverA)
    await f.db
      .update(bulwark)
      .set({
        lastResult: { kind: 'preview', status: 'previewed', desiredDigest: 'abc', ruleCount: 3 },
      })
      .where(eq(bulwark.serverId, f.serverA))
    fakeProbe(() => true)
    assertEquals((await call(f, 'POST', probePath(f), f.ownerCookie, {})).status, 200)
    const [row] = await f.db.select().from(bulwark).where(eq(bulwark.serverId, f.serverA))
    const stored = row!.lastResult as { kind: string; ruleCount: number; probe: { status: string } }
    assertEquals([stored.kind, stored.ruleCount, stored.probe.status], ['preview', 3, 'done'])
  })
})
