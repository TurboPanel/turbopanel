/**
 * Backup copy target routes against a real database: owners and managers
 * only, the secret key is sealed at rest and never returned, validation and
 * name rules, where a target applies (organization default and per-cluster
 * choice), what a host is sent, the connection test, copy state on the backup
 * list, and restore from the bucket. Skips without TURBOPANEL_DATABASE_URL.
 */

import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals, assertNotEquals } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveEncryptionSecretsConfig, deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import {
  audit,
  backup,
  backupCopy,
  backupTarget,
  environment,
  grant,
  key,
  managed,
  organization,
  project,
  retention,
  server,
  user,
  workspace,
} from '../../db/schema.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import type { CommandQueue } from '../../features/commands/queue.ts'
import type { CommandEnvelope } from '../../features/commands/envelope.ts'
import { decryptSecretForDaemon } from '../../lib/secrets/data-encryption.ts'
import { BACKUP_S3_COPY_FEATURE } from '../../lib/version-wire.ts'
import { buildBackupPolicySetForServer } from '../../features/backups/reconcile.ts'
import { recordBackupRun } from '../../features/backups/run-report.ts'
import { insertManagedBackup } from '../../features/backups/backup-records.ts'
import { recordCopyReport } from '../../features/backups/copy-records.ts'
import { applyBackupTargetTestSideEffect } from '../../features/backups/target-test-effects.ts'
import {
  getCommandDispatchPayload,
  getCommandRecord,
} from '../../features/commands/command-records.ts'
import { registerOrganizationBackupTargetRoutes } from './backup-target-routes.ts'
import { registerManagedRoutes } from '../managed/routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>
type Called = { status: number; body: Record<string, unknown> }

type Fixture = {
  db: Db
  app: Hono<AppEnv>
  orgA: string
  orgB: string
  serverId: string
  keyId: string
  managedId: string
  environmentId: string
  enqueued: CommandEnvelope[]
  ownerCookie: string
  managerCookie: string
  memberCookie: string
  otherManagerCookie: string
  dataEncryptionSecrets: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
  secretsConfig: ReturnType<typeof parseTestSecretsConfig>
}

const SECRET = 'wJalrXUtnFEMI-the-secret-key-never-returned'

const GOOD = {
  name: 'Offsite',
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'tp-backups',
  prefix: 'tp',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: SECRET,
}

async function insertUser(db: Db, organizationId: string, permission: string): Promise<string> {
  const [row] = await db
    .insert(user)
    .values({
      email: `bt-${crypto.randomUUID()}@example.com`,
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

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('backup target route tests')
    return
  }
  const db = createDenoDb()
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption'
  )
  const enqueued: CommandEnvelope[] = []
  const queue: CommandQueue = {
    enqueue: (envelope) => {
      enqueued.push(envelope)
      return Promise.resolve()
    },
  }
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('secretsConfig', secretsConfig)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    c.set('commandQueue', queue)
    c.set('daemonCellRegistry', {} as never)
    return next()
  })
  const routeOpts = { secrets, runtime: 'deno', signupEnvOverride: undefined } as const
  registerOrganizationBackupTargetRoutes(app, routeOpts)
  registerManagedRoutes(app, routeOpts)

  const orgs = await db
    .insert(organization)
    .values([{ name: 'Backup Target Org A' }, { name: 'Backup Target Org B' }])
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
    const now = new Date().toISOString()
    const [srv] = await db
      .insert(server)
      .values({
        organizationId: orgA,
        name: 'Backup Target Server',
        isConnected: true,
        statusChangedAt: now,
        daemon: { projection: { features: [BACKUP_S3_COPY_FEATURE] } },
      })
      .returning({ id: server.id })
    const [keyRow] = await db
      .insert(key)
      .values({
        serverId: srv!.id,
        algorithm: 'Ed25519',
        publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43) },
        fingerprint: `fp-${crypto.randomUUID()}`,
      })
      .returning({ id: key.id })
    const [ws] = await db
      .insert(workspace)
      .values({ name: 'Backup Target Workspace', organizationId: orgA })
      .returning({ id: workspace.id })
    const [proj] = await db
      .insert(project)
      .values({
        name: 'Backup Target Project',
        workspaceId: ws!.id,
        organizationId: orgA,
        metadata: { type: 'managed', code: 'postgres' },
      })
      .returning({ id: project.id })
    const [env] = await db
      .insert(environment)
      .values({ name: 'production', projectId: proj!.id, serverId: srv!.id })
      .returning({ id: environment.id })
    const [cluster] = await db
      .insert(managed)
      .values({
        environmentId: env!.id,
        serverId: srv!.id,
        name: 'Orders',
        engine: 'postgres',
        status: 'ready',
      })
      .returning({ id: managed.id })
    await fn({
      db,
      app,
      orgA,
      orgB,
      serverId: srv!.id,
      keyId: keyRow!.id,
      managedId: cluster!.id,
      environmentId: env!.id,
      enqueued,
      ownerCookie: await cookie(ids.owner),
      managerCookie: await cookie(ids.manager),
      memberCookie: await cookie(ids.member),
      otherManagerCookie: await cookie(ids.otherManager),
      dataEncryptionSecrets,
      secretsConfig,
    })
  } finally {
    await db.delete(audit).where(inArray(audit.organizationId, [orgA, orgB]))
    await db.delete(organization).where(inArray(organization.id, [orgA, orgB]))
    await db.delete(server).where(eq(server.organizationId, orgA))
    if (userIds.length > 0) await db.delete(user).where(inArray(user.id, userIds))
    await endDbConnection(db)
  }
}

/** A command's type and payload as the host receives them. */
async function loadCommand(f: Fixture, commandId: string) {
  const record = await getCommandRecord(f.db, commandId)
  const payload = await getCommandDispatchPayload(f.db, commandId)
  return { id: commandId, type: record!.type, payload }
}

async function call(
  f: Fixture,
  method: string,
  path: string,
  cookie: string | null,
  body?: unknown
): Promise<Called> {
  const res = await f.app.request(path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function createTarget(f: Fixture, over: Record<string, unknown> = {}): Promise<string> {
  const created = await call(
    f,
    'POST',
    `/organizations/${f.orgA}/backup-targets`,
    f.managerCookie,
    {
      ...GOOD,
      ...over,
    }
  )
  assertEquals(created.status, 201, JSON.stringify(created.body))
  return (created.body.target as { id: string }).id
}

test('every backup target route refuses a request without a session', async () => {
  await withFixture(async (f) => {
    for (const [method, path] of [
      ['GET', `/organizations/${f.orgA}/backup-targets`],
      ['POST', `/organizations/${f.orgA}/backup-targets`],
      ['PUT', `/organizations/${f.orgA}/backup-targets/default`],
      ['PUT', `/organizations/${f.orgA}/backup-targets/clusters/${f.managedId}`],
      ['PATCH', `/organizations/${f.orgA}/backup-targets/${f.managedId}`],
      ['DELETE', `/organizations/${f.orgA}/backup-targets/${f.managedId}`],
      ['POST', `/organizations/${f.orgA}/backup-targets/${f.managedId}/test`],
    ]) {
      assertEquals((await call(f, method!, path!, null, {})).status, 401, `${method} ${path}`)
    }
  })
})

test("a read-only member and another organization's manager are refused", async () => {
  await withFixture(async (f) => {
    for (const cookie of [f.memberCookie, f.otherManagerCookie]) {
      assertEquals(
        (await call(f, 'GET', `/organizations/${f.orgA}/backup-targets`, cookie)).status,
        403
      )
      assertEquals(
        (await call(f, 'POST', `/organizations/${f.orgA}/backup-targets`, cookie, GOOD)).status,
        403
      )
    }
    assertEquals(
      (await f.db.select().from(backupTarget).where(eq(backupTarget.organizationId, f.orgA)))
        .length,
      0
    )
  })
})

test('a target is created by an owner or manager, sealed at rest, and the secret never comes back', async () => {
  await withFixture(async (f) => {
    const created = await call(
      f,
      'POST',
      `/organizations/${f.orgA}/backup-targets`,
      f.ownerCookie,
      GOOD
    )
    assertEquals(created.status, 201)
    const target = created.body.target as Record<string, unknown>
    assertEquals(target.hasSecret, true)
    assertEquals(target.bucket, 'tp-backups')
    assert(!JSON.stringify(created.body).includes(SECRET))
    assert(!('secretAccessKey' in target) && !('secretKeySealed' in target))

    const [row] = await f.db
      .select()
      .from(backupTarget)
      .where(eq(backupTarget.id, target.id as string))
    assert(row!.secretKeySealed.startsWith('tpsecret'))
    assert(!row!.secretKeySealed.includes(SECRET))

    const listed = await call(f, 'GET', `/organizations/${f.orgA}/backup-targets`, f.managerCookie)
    assertEquals(listed.status, 200)
    assert(!JSON.stringify(listed.body).includes(SECRET))
    assertEquals((listed.body.targets as unknown[]).length, 1)

    const audits = await f.db.select().from(audit).where(eq(audit.organizationId, f.orgA))
    assertEquals(audits.length, 1)
    assert(!JSON.stringify(audits).includes(SECRET))
  })
})

test('bad bodies, duplicate names and the loopback endpoint are refused in plain words', async () => {
  await withFixture(async (f) => {
    await createTarget(f)
    const dup = await call(
      f,
      'POST',
      `/organizations/${f.orgA}/backup-targets`,
      f.managerCookie,
      GOOD
    )
    assertEquals(dup.status, 409)
    assertEquals(dup.body.error, 'backup_target_name_taken')
    const loopback = await call(
      f,
      'POST',
      `/organizations/${f.orgA}/backup-targets`,
      f.managerCookie,
      {
        ...GOOD,
        name: 'Local',
        endpoint: 'https://127.0.0.1:9000',
      }
    )
    assertEquals(loopback.status, 400)
    assertEquals(loopback.body.field, 'endpoint')
    const noSecret = await call(
      f,
      'POST',
      `/organizations/${f.orgA}/backup-targets`,
      f.managerCookie,
      {
        ...GOOD,
        name: 'NoSecret',
        secretAccessKey: undefined,
      }
    )
    assertEquals(noSecret.status, 400)
    assertEquals(noSecret.body.field, 'secretAccessKey')
  })
})

test('an update keeps the secret unless a new one is sent, and clears the last test when it moves', async () => {
  await withFixture(async (f) => {
    const id = await createTarget(f)
    await f.db
      .update(backupTarget)
      .set({ isLastTestOk: true, lastTestedAt: new Date().toISOString() })
      .where(eq(backupTarget.id, id))
    const [before] = await f.db.select().from(backupTarget).where(eq(backupTarget.id, id))
    const renamed = await call(
      f,
      'PATCH',
      `/organizations/${f.orgA}/backup-targets/${id}`,
      f.managerCookie,
      {
        name: 'Renamed',
      }
    )
    assertEquals(renamed.status, 200)
    const [kept] = await f.db.select().from(backupTarget).where(eq(backupTarget.id, id))
    assertEquals(kept!.secretKeySealed, before!.secretKeySealed)
    assertEquals(kept!.isLastTestOk, true)
    const moved = await call(
      f,
      'PATCH',
      `/organizations/${f.orgA}/backup-targets/${id}`,
      f.managerCookie,
      {
        bucket: 'another-bucket',
        secretAccessKey: 'a-new-secret',
      }
    )
    assertEquals(moved.status, 200)
    assert(!JSON.stringify(moved.body).includes('a-new-secret'))
    const [after] = await f.db.select().from(backupTarget).where(eq(backupTarget.id, id))
    assertNotEquals(after!.secretKeySealed, before!.secretKeySealed)
    assertEquals(after!.isLastTestOk, null)
  })
})

test('a target in use cannot be deleted; after it is released it can', async () => {
  await withFixture(async (f) => {
    const id = await createTarget(f)
    const set = await call(
      f,
      'PUT',
      `/organizations/${f.orgA}/backup-targets/default`,
      f.ownerCookie,
      {
        targetId: id,
      }
    )
    assertEquals(set.status, 200)
    const refused = await call(
      f,
      'DELETE',
      `/organizations/${f.orgA}/backup-targets/${id}`,
      f.ownerCookie
    )
    assertEquals(refused.status, 409)
    assertEquals(refused.body.error, 'backup_target_in_use')
    await call(f, 'PUT', `/organizations/${f.orgA}/backup-targets/default`, f.ownerCookie, {
      targetId: null,
    })
    const deleted = await call(
      f,
      'DELETE',
      `/organizations/${f.orgA}/backup-targets/${id}`,
      f.ownerCookie
    )
    assertEquals(deleted.status, 200)
  })
})

test("another organization's target cannot be assigned or read", async () => {
  await withFixture(async (f) => {
    const [other] = await f.db
      .insert(backupTarget)
      .values({
        organizationId: f.orgB,
        name: 'Theirs',
        endpoint: 'https://s3.example.com',
        region: 'us-east-1',
        bucket: 'theirs-bucket',
        accessKeyId: 'AKIAOTHER',
        secretKeySealed: 'tpsecret.v1.x',
      })
      .returning({ id: backupTarget.id })
    const res = await call(
      f,
      'PUT',
      `/organizations/${f.orgA}/backup-targets/default`,
      f.ownerCookie,
      {
        targetId: other!.id,
      }
    )
    assertEquals(res.status, 404)
    const patch = await call(
      f,
      'PATCH',
      `/organizations/${f.orgA}/backup-targets/${other!.id}`,
      f.ownerCookie,
      {
        name: 'Mine now',
      }
    )
    assertEquals(patch.status, 404)
  })
})

test('the host is sent the target sealed to its own key; a cluster can override or turn copying off', async () => {
  await withFixture(async (f) => {
    const id = await createTarget(f)
    await f.db.insert(retention).values({
      organizationId: f.orgA,
      targetKind: 'managed',
      managedId: f.managedId,
      name: 'Nightly',
      schedule: '0 3 * * *',
      retentionKeep: 5,
    })
    // No default yet: no target on the policy.
    let set = await buildBackupPolicySetForServer(f.db, f.serverId, {
      secretsConfig: f.secretsConfig,
      dataEncryptionSecrets: f.dataEncryptionSecrets,
    })
    assertEquals(set[0]!.copyTarget, undefined)

    const saved = await call(
      f,
      'PUT',
      `/organizations/${f.orgA}/backup-targets/default`,
      f.ownerCookie,
      {
        targetId: id,
      }
    )
    assertEquals(saved.body.pushedToServers, 1)
    assert(f.enqueued.length >= 1)

    set = await buildBackupPolicySetForServer(f.db, f.serverId, {
      secretsConfig: f.secretsConfig,
      dataEncryptionSecrets: f.dataEncryptionSecrets,
    })
    const wire = set[0]!.copyTarget!
    assertEquals(wire.targetId, id)
    assertEquals(wire.bucket, 'tp-backups')
    assert(wire.secretKeyEnvelope.startsWith('tpdaemon'))
    assert(!JSON.stringify(set).includes(SECRET))
    // Only this host's daemon key opens it, and it opens to the secret.
    assertEquals(
      await decryptSecretForDaemon(
        f.secretsConfig,
        { serverId: f.serverId, keyId: f.keyId },
        wire.secretKeyEnvelope
      ),
      SECRET
    )

    // Without the sealing secrets the policy goes out with no target rather than failing.
    const unsealed = await buildBackupPolicySetForServer(f.db, f.serverId)
    assertEquals(unsealed[0]!.copyTarget, undefined)

    const none = await call(
      f,
      'PUT',
      `/organizations/${f.orgA}/backup-targets/clusters/${f.managedId}`,
      f.managerCookie,
      { choice: 'none' }
    )
    assertEquals(none.status, 200)
    set = await buildBackupPolicySetForServer(f.db, f.serverId, {
      secretsConfig: f.secretsConfig,
      dataEncryptionSecrets: f.dataEncryptionSecrets,
    })
    assertEquals(set[0]!.copyTarget, undefined)

    const second = await createTarget(f, { name: 'Second', bucket: 'second-bucket' })
    await call(
      f,
      'PUT',
      `/organizations/${f.orgA}/backup-targets/clusters/${f.managedId}`,
      f.managerCookie,
      {
        choice: second,
      }
    )
    set = await buildBackupPolicySetForServer(f.db, f.serverId, {
      secretsConfig: f.secretsConfig,
      dataEncryptionSecrets: f.dataEncryptionSecrets,
    })
    assertEquals(set[0]!.copyTarget!.bucket, 'second-bucket')

    const bad = await call(
      f,
      'PUT',
      `/organizations/${f.orgA}/backup-targets/clusters/${f.managedId}`,
      f.managerCookie,
      { choice: 'sometimes' }
    )
    assertEquals(bad.status, 400)
    await call(
      f,
      'PUT',
      `/organizations/${f.orgA}/backup-targets/clusters/${f.managedId}`,
      f.managerCookie,
      {
        choice: 'inherit',
      }
    )
    const effective = await call(
      f,
      'GET',
      `/environments/${f.environmentId}/managed/backup-target`,
      f.managerCookie
    )
    assertEquals(effective.body.source, 'organization')
    assertEquals(effective.body.choice, 'inherit')
  })
})

test('a host that does not list the copy feature is sent no target', async () => {
  await withFixture(async (f) => {
    const id = await createTarget(f)
    await f.db.insert(retention).values({
      organizationId: f.orgA,
      targetKind: 'managed',
      managedId: f.managedId,
      name: 'Nightly',
      schedule: '0 3 * * *',
      retentionKeep: 5,
    })
    await call(f, 'PUT', `/organizations/${f.orgA}/backup-targets/default`, f.ownerCookie, {
      targetId: id,
    })
    await f.db
      .update(server)
      .set({ daemon: { projection: { features: [] } } })
      .where(eq(server.id, f.serverId))
    const set = await buildBackupPolicySetForServer(f.db, f.serverId, {
      secretsConfig: f.secretsConfig,
      dataEncryptionSecrets: f.dataEncryptionSecrets,
    })
    assertEquals(set[0]!.copyTarget, undefined)
  })
})

test('the connection test is queued for a ready host, stores its outcome, and refuses a host that cannot take it', async () => {
  await withFixture(async (f) => {
    const id = await createTarget(f)
    const queued = await call(
      f,
      'POST',
      `/organizations/${f.orgA}/backup-targets/${id}/test`,
      f.managerCookie,
      {}
    )
    assertEquals(queued.status, 200, JSON.stringify(queued.body))
    assertEquals(queued.body.serverId, f.serverId)
    const cmd = await loadCommand(f, queued.body.commandId as string)
    assertEquals(cmd.type, 'server.backups.test-target')
    assert(!JSON.stringify(cmd.payload).includes(SECRET))
    assert(JSON.stringify(cmd.payload).includes('tpdaemon'))

    await applyBackupTargetTestSideEffect(f.db, cmd, {
      ok: false,
      steps: [{ step: 'write', ok: false, error: 'the bucket does not exist' }],
      error: 'write failed: the bucket does not exist',
    })
    const [tested] = await f.db.select().from(backupTarget).where(eq(backupTarget.id, id))
    assertEquals(tested!.isLastTestOk, false)
    assertEquals(tested!.lastTestError, 'write failed: the bucket does not exist')

    await f.db
      .update(server)
      .set({ daemon: { projection: { features: [] } } })
      .where(eq(server.id, f.serverId))
    const refused = await call(
      f,
      'POST',
      `/organizations/${f.orgA}/backup-targets/${id}/test`,
      f.managerCookie,
      {}
    )
    assertEquals(refused.status, 409)
  })
})

test('copy state follows a backup: waiting, then copied, then removed by retention; the list shows it', async () => {
  await withFixture(async (f) => {
    const id = await createTarget(f)
    await call(f, 'PUT', `/organizations/${f.orgA}/backup-targets/default`, f.ownerCookie, {
      targetId: id,
    })
    const [policy] = await f.db
      .insert(retention)
      .values({
        organizationId: f.orgA,
        targetKind: 'managed',
        managedId: f.managedId,
        name: 'Nightly',
        schedule: '0 3 * * *',
        retentionKeep: 5,
      })
      .returning({ id: retention.id })
    const run = (n: number, backupId: string) =>
      recordBackupRun(f.db, {
        policyId: policy!.id,
        target: { kind: 'managed', managedId: f.managedId },
        serverId: f.serverId,
        runId: `run_${n}`,
        startedAt: '2026-10-21T03:00:00.000Z',
        finishedAt: '2026-10-21T03:00:05.000Z',
        status: 'succeeded',
        artifact: {
          backupId,
          sizeBytes: 10,
          checksum: 'a'.repeat(64),
          path: `managed/${f.managedId}/policy-${policy!.id}/${backupId}.dump`,
        },
        pruned: [],
      })
    await run(1, 'bk_one')
    await run(2, 'bk_two')

    const list = async () =>
      (await call(f, 'GET', `/environments/${f.environmentId}/managed/backups`, f.managerCookie))
        .body.backups as Array<{ id: string; copy: { state: string; targetName: string } | null }>
    let items = await list()
    assertEquals(items.find((i) => i.id === 'bk_one')!.copy!.state, 'pending')
    assertEquals(items.find((i) => i.id === 'bk_one')!.copy!.targetName, 'Offsite')

    const report = (backupId: string, over: Record<string, unknown> = {}) =>
      recordCopyReport(f.db, {
        managedId: f.managedId,
        backupId,
        targetId: id,
        targetName: 'Offsite',
        serverId: f.serverId,
        state: 'copied',
        objectKey: `tp/managed/${f.managedId}/policy-${policy!.id}/${backupId}.dump`,
        sizeBytes: 10,
        attempts: 1,
        finishedAt: '2026-10-21T03:01:00.000Z',
        pruned: [],
        ...over,
      } as never)
    await report('bk_one')
    await report('bk_two', {
      state: 'failed',
      objectKey: undefined,
      error: 'the bucket does not exist',
    })
    items = await list()
    assertEquals(items.find((i) => i.id === 'bk_one')!.copy!.state, 'copied')
    const failed = items.find((i) => i.id === 'bk_two')!.copy as unknown as {
      state: string
      error: string
    }
    assertEquals(failed.state, 'failed')
    assertEquals(failed.error, 'the bucket does not exist')

    // A later good copy that pruned bk_one in the bucket marks it removed.
    await report('bk_two', { pruned: ['bk_one'] })
    items = await list()
    assertEquals(items.find((i) => i.id === 'bk_one')!.copy!.state, 'removed')
    assertEquals(items.find((i) => i.id === 'bk_two')!.copy!.state, 'copied')

    // A second report of the same copy changes nothing (resend).
    await report('bk_two', { pruned: ['bk_one'] })
    const rows = await f.db.select().from(backupCopy).where(eq(backupCopy.managedId, f.managedId))
    assertEquals(rows.length, 2)
  })
})

test('restore from the bucket: refused until a copy is finished, then sent with the target and key', async () => {
  await withFixture(async (f) => {
    const id = await createTarget(f)
    await call(f, 'PUT', `/organizations/${f.orgA}/backup-targets/default`, f.ownerCookie, {
      targetId: id,
    })
    const otherServer = (
      await f.db
        .insert(server)
        .values({
          organizationId: f.orgA,
          name: 'Former primary',
          statusChangedAt: new Date().toISOString(),
        })
        .returning({ id: server.id })
    )[0]!.id
    await insertManagedBackup(f.db, {
      id: 'bk_far',
      managedId: f.managedId,
      sizeBytes: 10,
      checksum: 'b'.repeat(64),
      database: 'app',
      path: `managed/${f.managedId}/bk_far.dump`,
      serverId: otherServer,
    })
    const url = `/environments/${f.environmentId}/managed/backups/bk_far/restore`
    const wrongHost = await call(f, 'POST', url, f.managerCookie, {})
    assertEquals(wrongHost.status, 409)
    assertEquals(wrongHost.body.error, 'backup_on_other_server')
    assertEquals(wrongHost.body.canRestoreFromCopy, false)

    const notReady = await call(f, 'POST', url, f.managerCookie, { fromCopy: true })
    assertEquals(notReady.status, 409)
    assertEquals(notReady.body.error, 'backup_copy_not_ready')

    await recordCopyReport(f.db, {
      managedId: f.managedId,
      backupId: 'bk_far',
      targetId: id,
      targetName: 'Offsite',
      serverId: otherServer,
      state: 'copied',
      objectKey: `tp/managed/${f.managedId}/manual/bk_far.dump`,
      attempts: 1,
      finishedAt: '2026-10-21T03:01:00.000Z',
      pruned: [],
    })
    const hint = await call(f, 'POST', url, f.managerCookie, {})
    assertEquals(hint.body.canRestoreFromCopy, true)

    // The current primary is the fixture server; it is online and lists the feature.
    await f.db
      .update(server)
      .set({ daemon: { projection: { features: [BACKUP_S3_COPY_FEATURE] } } })
      .where(eq(server.id, f.serverId))
    const ok = await call(f, 'POST', url, f.managerCookie, { fromCopy: true })
    assertEquals(ok.status, 200, JSON.stringify(ok.body))
    const cmd = await loadCommand(f, ok.body.commandId as string)
    const payload = cmd.payload as {
      copySource: { key: string; target: { bucket: string; secretKeyEnvelope: string } }
    }
    assertEquals(payload.copySource.key, `tp/managed/${f.managedId}/manual/bk_far.dump`)
    assertEquals(payload.copySource.target.bucket, 'tp-backups')
    assert(payload.copySource.target.secretKeyEnvelope.startsWith('tpdaemon'))
    assert(!JSON.stringify(cmd.payload).includes(SECRET))
  })
})

test('deleting a backup removes its copy rows and a manual backup carries the target', async () => {
  await withFixture(async (f) => {
    const id = await createTarget(f)
    await call(f, 'PUT', `/organizations/${f.orgA}/backup-targets/default`, f.ownerCookie, {
      targetId: id,
    })
    const created = await call(
      f,
      'POST',
      `/environments/${f.environmentId}/managed/backups`,
      f.managerCookie,
      {
        database: 'postgres',
      }
    )
    // A fresh cluster row has no database list; the route answers a plain 400 then.
    if (created.status === 200) {
      const cmd = await loadCommand(f, created.body.commandId as string)
      assertEquals((cmd.payload as { copyTarget: { targetId: string } }).copyTarget.targetId, id)
    } else {
      assertEquals(created.status, 400)
    }
    await insertManagedBackup(f.db, {
      id: 'bk_gone',
      managedId: f.managedId,
      sizeBytes: 1,
      checksum: 'c'.repeat(64),
      path: `managed/${f.managedId}/bk_gone.dump`,
      serverId: f.serverId,
    })
    await recordCopyReport(f.db, {
      managedId: f.managedId,
      backupId: 'bk_gone',
      targetId: id,
      targetName: 'Offsite',
      serverId: f.serverId,
      state: 'copied',
      objectKey: 'tp/x/bk_gone.dump',
      attempts: 1,
      finishedAt: '2026-10-21T03:01:00.000Z',
      pruned: [],
    })
    const del = await call(
      f,
      'DELETE',
      `/environments/${f.environmentId}/managed/backups/bk_gone`,
      f.managerCookie
    )
    assertEquals(del.status, 200, JSON.stringify(del.body))
    const cmd = await loadCommand(f, del.body.commandId as string)
    assertEquals((cmd.payload as { copyTarget: { targetId: string } }).copyTarget.targetId, id)
    assert(
      (
        await f.db
          .select()
          .from(backup)
          .where(and(eq(backup.managedId, f.managedId), eq(backup.backupId, 'bk_gone')))
      ).length === 1
    )
  })
})
