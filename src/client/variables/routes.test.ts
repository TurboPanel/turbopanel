import { assertEquals } from 'jsr:@std/assert'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import {
  deriveEncryptionSecretsConfig,
  deriveSecretsConfig,
  parseSecretsEnv,
} from '../authn/secrets.ts'
import { decryptSecret, encryptSecret } from '../authn/data-encryption.ts'
import { buildServerDaemonState } from '../../daemon/authn/daemon-state.ts'
import { computePublicKeyFingerprint } from '../../daemon/authn/server-key.ts'
import {
  environment,
  grant,
  member,
  organization,
  project,
  server,
  service,
  user,
  variable,
  workspace,
} from '../../lib/db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerVariableRoutes } from './routes.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

async function generateDaemonKey() {
  const pair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const fingerprint = await computePublicKeyFingerprint(publicJwk)
  const daemonState = buildServerDaemonState({ publicJwk, fingerprint })
  return { daemonState }
}

async function createVariableTestApp(db: ReturnType<typeof createDenoDb>) {
  const secretsConfig = parseSecretsEnv(TEST_ONLY_TURBOPANEL_SECRET, undefined, 'deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('secretsConfig', secretsConfig)
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  registerVariableRoutes(app, { secrets, runtime: 'deno' })
  return { app, secrets, secretsConfig, dataEncryptionSecrets }
}

async function sessionCookie(
  db: ReturnType<typeof createDenoDb>,
  secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>,
  userId: string,
): Promise<string> {
  const { token } = await createSession(db, userId, {})
  const signed = await buildSignedCookie(token, secrets)
  return `${HTTP_SESSION_COOKIE_NAME}=${signed}`
}

async function withVariableFixtures(
  fn: (ctx: {
    db: ReturnType<typeof createDenoDb>
    app: Hono<AppEnv>
    secrets: Awaited<ReturnType<typeof deriveSecretsConfig>>
    secretsConfig: ReturnType<typeof parseSecretsEnv>
    dataEncryptionSecrets: Awaited<ReturnType<typeof deriveEncryptionSecretsConfig>>
    userId: string
    organizationId: string
    workspaceId: string
    projectId: string
    environmentId: string
    serviceId: string
    serverId: string
  }) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping variable route tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const { app, secrets, secretsConfig, dataEncryptionSecrets } =
    await createVariableTestApp(db)
  const { daemonState } = await generateDaemonKey()

  const insertedOrg = await db
    .insert(organization)
    .values({ displayName: 'Variable Route Test Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg[0]!.id

  const insertedUser = await db
    .insert(user)
    .values({
      email: `variable-route-${crypto.randomUUID()}@example.com`,
      isEmailVerified: true,
      role: 'user',
    })
    .returning({ id: user.id })
  const userId = insertedUser[0]!.id

  await db.insert(member).values({ organizationId, userId })
  await db.insert(grant).values({
    entityType: 'organization',
    entityId: organizationId,
    actorType: 'user',
    actorId: userId,
    permission: 'organization:own',
    allow: true,
  })

  const [insertedWorkspace] = await db
    .insert(workspace)
    .values({ displayName: 'Variable Route Workspace', organizationId })
    .returning({ id: workspace.id })
  const workspaceId = insertedWorkspace!.id

  const now = new Date().toISOString()

  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      daemon: daemonState,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const [insertedProject] = await db
    .insert(project)
    .values({
      displayName: 'Variable Route Project',
      workspaceId,
      metadata: { serverId },
    })
    .returning({ id: project.id })
  const projectId = insertedProject!.id

  const [insertedEnvironment] = await db
    .insert(environment)
    .values({
      displayName: 'Variable Route Env',
      projectId,
    })
    .returning({ id: environment.id })
  const environmentId = insertedEnvironment!.id

  const [insertedService] = await db
    .insert(service)
    .values({
      displayName: 'Variable Route Service',
      environmentId,
    })
    .returning({ id: service.id })
  const serviceId = insertedService!.id

  try {
    await fn({
      db,
      app,
      secrets,
      secretsConfig,
      dataEncryptionSecrets,
      userId,
      organizationId,
      workspaceId,
      projectId,
      environmentId,
      serviceId,
      serverId,
    })
  } finally {
    await db.delete(variable).where(eq(variable.environmentId, environmentId))
    await db.delete(variable).where(eq(variable.organizationId, organizationId))
    await db.delete(variable).where(eq(variable.workspaceId, workspaceId))
    await db.delete(variable).where(eq(variable.projectId, projectId))
    await db.delete(variable).where(eq(variable.serviceId, serviceId))
    await db.delete(variable).where(eq(variable.serverId, serverId))
    await db.delete(service).where(eq(service.id, serviceId))
    await db.delete(environment).where(eq(environment.id, environmentId))
    await db.delete(project).where(eq(project.id, projectId))
    await db.delete(server).where(eq(server.id, serverId))
    await db.delete(grant).where(and(
      eq(grant.actorId, userId),
      eq(grant.entityId, organizationId),
    ))
    await db.delete(member).where(and(
      eq(member.userId, userId),
      eq(member.organizationId, organizationId),
    ))
    await db.delete(workspace).where(eq(workspace.id, workspaceId))
    await db.delete(user).where(eq(user.id, userId))
    await db.delete(organization).where(eq(organization.id, organizationId))
  }
}

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('GET /variables lists visible variables for org owner', async () => {
  await withVariableFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const [insertedVariable] = await db
      .insert(variable)
      .values({ environmentId, key: 'VISIBLE_VAR', value: 'hello' })
      .returning({ id: variable.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const response = await app.request('/variables', {
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
      },
    })

    assertEquals(response.status, 200)
    const body = await response.json() as { variables: Array<{ id: string }> }
    assertEquals(body.variables.some((row) => row.id === insertedVariable!.id), true)
  })
})

test('PATCH /variables/:id seals plaintext when isSecret toggles true without value', async () => {
  await withVariableFixtures(async ({
    db,
    app,
    secrets,
    dataEncryptionSecrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const [insertedVariable] = await db
      .insert(variable)
      .values({
        environmentId,
        key: 'TOGGLE_SECRET',
        value: 'plain-secret',
        isSecret: false,
      })
      .returning({ id: variable.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const response = await app.request(`/variables/${insertedVariable!.id}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ isSecret: true }),
    })

    assertEquals(response.status, 200)

    const rows = await db
      .select({ value: variable.value, isSecret: variable.isSecret })
      .from(variable)
      .where(eq(variable.id, insertedVariable!.id))
      .limit(1)

    const row = rows[0]!
    assertEquals(row.isSecret, true)
    assertEquals(row.value?.startsWith('tpsecret.v1.'), true)

    const decrypted = await decryptSecret(dataEncryptionSecrets, row.value!)
    assertEquals(decrypted, 'plain-secret')
  })
})

test('PATCH /variables/:id rejects secret to non-secret without replacement value', async () => {
  await withVariableFixtures(async ({
    db,
    app,
    secrets,
    dataEncryptionSecrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const sealed = await encryptSecret(dataEncryptionSecrets, 'stored-secret')

    const [insertedVariable] = await db
      .insert(variable)
      .values({
        environmentId,
        key: 'FROM_SECRET',
        value: sealed,
        isSecret: true,
      })
      .returning({ id: variable.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const response = await app.request(`/variables/${insertedVariable!.id}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ isSecret: false }),
    })

    assertEquals(response.status, 400)

    const rows = await db
      .select({ value: variable.value, isSecret: variable.isSecret })
      .from(variable)
      .where(eq(variable.id, insertedVariable!.id))
      .limit(1)

    assertEquals(rows[0]!.isSecret, true)
    assertEquals(rows[0]!.value, sealed)
  })
})

async function postVariable(
  app: Hono<AppEnv>,
  cookie: string,
  organizationId: string,
  body: Record<string, unknown>,
) {
  return app.request('/variables', {
    method: 'POST',
    headers: {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

test('POST /variables with organizationId only succeeds', async () => {
  await withVariableFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const response = await postVariable(app, cookie, organizationId, {
      organizationId,
      key: 'ORG_VAR',
      value: 'org-value',
    })

    assertEquals(response.status, 200)
    const { id } = await response.json() as { id: string }

    const listResponse = await app.request('/variables?organizationId=' + organizationId, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    const listBody = await listResponse.json() as { variables: Array<{ id: string }> }
    assertEquals(listBody.variables.some((row) => row.id === id), true)
  })
})

test('POST /variables with workspaceId only succeeds', async () => {
  await withVariableFixtures(async ({ db, app, secrets, userId, organizationId, workspaceId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const response = await postVariable(app, cookie, organizationId, {
      workspaceId,
      key: 'WS_VAR',
      value: 'ws-value',
    })
    assertEquals(response.status, 200)
  })
})

test('POST /variables with projectId only succeeds', async () => {
  await withVariableFixtures(async ({ db, app, secrets, userId, organizationId, projectId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const response = await postVariable(app, cookie, organizationId, {
      projectId,
      key: 'PROJ_VAR',
      value: 'proj-value',
    })
    assertEquals(response.status, 200)
  })
})

test('POST /variables with serviceId only succeeds', async () => {
  await withVariableFixtures(async ({ db, app, secrets, userId, organizationId, serviceId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const response = await postVariable(app, cookie, organizationId, {
      serviceId,
      key: 'SVC_VAR',
      value: 'svc-value',
    })
    assertEquals(response.status, 200)
  })
})

test('POST /variables with serverId only succeeds', async () => {
  await withVariableFixtures(async ({ db, app, secrets, userId, organizationId, serverId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const response = await postVariable(app, cookie, organizationId, {
      serverId,
      key: 'SRV_VAR',
      value: 'srv-value',
    })
    assertEquals(response.status, 200)
  })
})

test('POST /variables with two parent fields returns 400', async () => {
  await withVariableFixtures(async ({ db, app, secrets, userId, organizationId, projectId, environmentId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const response = await postVariable(app, cookie, organizationId, {
      projectId,
      environmentId,
      key: 'DUAL_PARENT',
      value: 'x',
    })
    assertEquals(response.status, 400)
    const body = await response.json() as { error: string }
    assertEquals(body.error, 'Exactly one parent resource must be specified')
  })
})

test('POST /variables with no parent field returns 400', async () => {
  await withVariableFixtures(async ({ db, app, secrets, userId, organizationId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const response = await postVariable(app, cookie, organizationId, {
      key: 'NO_PARENT',
      value: 'x',
    })
    assertEquals(response.status, 400)
    const body = await response.json() as { error: string }
    assertEquals(body.error, 'Exactly one parent resource must be specified')
  })
})

test('POST /variables duplicate key within same parent returns 409', async () => {
  await withVariableFixtures(async ({ db, app, secrets, userId, organizationId, projectId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const first = await postVariable(app, cookie, organizationId, {
      projectId,
      key: 'DUP_KEY',
      value: 'one',
    })
    assertEquals(first.status, 200)

    const second = await postVariable(app, cookie, organizationId, {
      projectId,
      key: 'DUP_KEY',
      value: 'two',
    })
    assertEquals(second.status, 409)
  })
})

test('POST /variables same key in different parents both succeed', async () => {
  await withVariableFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    projectId,
    serviceId,
  }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const projectResponse = await postVariable(app, cookie, organizationId, {
      projectId,
      key: 'SHARED_KEY',
      value: 'project',
    })
    assertEquals(projectResponse.status, 200)

    const serviceResponse = await postVariable(app, cookie, organizationId, {
      serviceId,
      key: 'SHARED_KEY',
      value: 'service',
    })
    assertEquals(serviceResponse.status, 200)
  })
})

test('PATCH /variables/:id rejects environmentId change', async () => {
  await withVariableFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    environmentId,
    projectId,
  }) => {
    const [otherEnvironment] = await db
      .insert(environment)
      .values({ displayName: 'Other Env', projectId })
      .returning({ id: environment.id })

    const [insertedVariable] = await db
      .insert(variable)
      .values({ environmentId, key: 'IMMUTABLE_PARENT', value: 'v' })
      .returning({ id: variable.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const response = await app.request(`/variables/${insertedVariable!.id}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ environmentId: otherEnvironment!.id }),
    })

    assertEquals(response.status, 400)

    await db.delete(variable).where(eq(variable.id, insertedVariable!.id))
    await db.delete(environment).where(eq(environment.id, otherEnvironment!.id))
  })
})

test('POST /variables rejects non-boolean isSecret string', async () => {
  await withVariableFixtures(async ({ db, app, secrets, userId, organizationId, environmentId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const response = await postVariable(app, cookie, organizationId, {
      environmentId,
      key: 'BAD_IS_SECRET_STR',
      value: 'secret-value',
      isSecret: 'true',
    })

    assertEquals(response.status, 400)

    const rows = await db
      .select({ id: variable.id })
      .from(variable)
      .where(and(eq(variable.environmentId, environmentId), eq(variable.key, 'BAD_IS_SECRET_STR')))

    assertEquals(rows.length, 0)
  })
})

test('POST /variables rejects non-boolean isSecret number', async () => {
  await withVariableFixtures(async ({ db, app, secrets, userId, organizationId, environmentId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const response = await postVariable(app, cookie, organizationId, {
      environmentId,
      key: 'BAD_IS_SECRET_NUM',
      value: 'secret-value',
      isSecret: 1,
    })

    assertEquals(response.status, 400)

    const rows = await db
      .select({ id: variable.id })
      .from(variable)
      .where(and(eq(variable.environmentId, environmentId), eq(variable.key, 'BAD_IS_SECRET_NUM')))

    assertEquals(rows.length, 0)
  })
})

test('POST /variables preserves empty-string value', async () => {
  await withVariableFixtures(async ({ db, app, secrets, userId, organizationId, environmentId }) => {
    const cookie = await sessionCookie(db, secrets, userId)
    const response = await postVariable(app, cookie, organizationId, {
      environmentId,
      key: 'EMPTY_VALUE',
      value: '',
    })

    assertEquals(response.status, 200)
    const { id } = await response.json() as { id: string }

    const rows = await db
      .select({ value: variable.value, isSecret: variable.isSecret })
      .from(variable)
      .where(eq(variable.id, id))
      .limit(1)

    assertEquals(rows[0]!.value, '')
    assertEquals(rows[0]!.isSecret, false)

    const getResponse = await app.request(`/variables/${id}`, {
      headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId },
    })
    const getBody = await getResponse.json() as { variable: { value: string } }
    assertEquals(getBody.variable.value, '')
  })
})

test('PATCH /variables/:id preserves empty-string value', async () => {
  await withVariableFixtures(async ({ db, app, secrets, userId, organizationId, environmentId }) => {
    const [insertedVariable] = await db
      .insert(variable)
      .values({ environmentId, key: 'PATCH_EMPTY', value: 'before' })
      .returning({ id: variable.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const response = await app.request(`/variables/${insertedVariable!.id}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: '' }),
    })

    assertEquals(response.status, 200)

    const rows = await db
      .select({ value: variable.value })
      .from(variable)
      .where(eq(variable.id, insertedVariable!.id))
      .limit(1)

    assertEquals(rows[0]!.value, '')
  })
})

test('PATCH /variables/:id preserves empty-string when toggling to secret', async () => {
  await withVariableFixtures(async ({
    db,
    app,
    secrets,
    dataEncryptionSecrets,
    userId,
    organizationId,
    environmentId,
  }) => {
    const [insertedVariable] = await db
      .insert(variable)
      .values({
        environmentId,
        key: 'EMPTY_TO_SECRET',
        value: '',
        isSecret: false,
      })
      .returning({ id: variable.id })

    const cookie = await sessionCookie(db, secrets, userId)
    const response = await app.request(`/variables/${insertedVariable!.id}`, {
      method: 'PATCH',
      headers: {
        Cookie: cookie,
        [ORG_ID_HEADER]: organizationId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ isSecret: true }),
    })

    assertEquals(response.status, 200)

    const rows = await db
      .select({ value: variable.value, isSecret: variable.isSecret })
      .from(variable)
      .where(eq(variable.id, insertedVariable!.id))
      .limit(1)

    const row = rows[0]!
    assertEquals(row.isSecret, true)
    assertEquals(row.value.startsWith('tpsecret.v1.'), true)

    const decrypted = await decryptSecret(dataEncryptionSecrets, row.value)
    assertEquals(decrypted, '')
  })
})

test('GET /variables/resolved applies service override chain and excludes server scope', async () => {
  await withVariableFixtures(async ({
    db,
    app,
    secrets,
    userId,
    organizationId,
    workspaceId,
    projectId,
    environmentId,
    serviceId,
    serverId,
  }) => {
    await db.insert(variable).values([
      { organizationId, key: 'SHARED', value: 'org' },
      { workspaceId, key: 'SHARED', value: 'workspace' },
      { projectId, key: 'SHARED', value: 'project' },
      { environmentId, key: 'SHARED', value: 'environment' },
      { serviceId, key: 'SHARED', value: 'service' },
      { serverId, key: 'SHARED', value: 'server-only' },
      { organizationId, key: 'ORG_ONLY', value: 'org-only' },
    ])

    const cookie = await sessionCookie(db, secrets, userId)

    const serviceResponse = await app.request(
      `/variables/resolved?serviceId=${serviceId}`,
      { headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId } },
    )
    assertEquals(serviceResponse.status, 200)
    const serviceBody = await serviceResponse.json() as {
      variables: Record<string, { value: string | null; isSecret: boolean }>
    }
    assertEquals(serviceBody.variables.SHARED?.value, 'service')
    assertEquals(serviceBody.variables.ORG_ONLY?.value, 'org-only')
    assertEquals(serviceBody.variables['server-only'], undefined)

    const environmentResponse = await app.request(
      `/variables/resolved?environmentId=${environmentId}`,
      { headers: { Cookie: cookie, [ORG_ID_HEADER]: organizationId } },
    )
    assertEquals(environmentResponse.status, 200)
    const environmentBody = await environmentResponse.json() as {
      variables: Record<string, { value: string | null; isSecret: boolean }>
    }
    assertEquals(environmentBody.variables.SHARED?.value, 'environment')
    assertEquals(environmentBody.variables['server-only'], undefined)
  })
})
