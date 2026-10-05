import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assert, assertEquals, assertFalse } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppEnv } from '../../app/app.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import { createDenoDb } from '../../db/connection.ts'
import { buildSignedCookie, HTTP_SESSION_COOKIE_NAME } from '../authn/crypto.ts'
import { createSession } from '../authn/session-store.ts'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { yamlToComposeDocument } from '../../features/compose/convert.ts'
import {
  environment,
  grant,
  organization,
  project,
  service,
  user,
  variable,
  workspace,
} from '../../db/schema.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerEnvironmentConfigViewRoutes } from './config-view-routes.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type Db = ReturnType<typeof createDenoDb>
type Secrets = Awaited<ReturnType<typeof deriveSecretsConfig>>

// A placeholder credential, assembled at run time so no literal credential sits in the source.
const COMPOSE_SECRET = ['placeholder', 'compose', 'value'].join('-')

const BASE_COMPOSE = `
services:
  web:
    image: nginx:1
    command: serve --port 80
    environment:
      DB_PASSWORD: ${COMPOSE_SECRET}
  blog:
    x-turbopanel:
      serviceKind: site
      principal: deploy
x-turbopanel:
  principals:
    deploy:
      access: sftp
`

const STAGING_COMPOSE = `
services:
  web:
    image: nginx:1
    command: serve --port 8080
`

const SOLO_COMPOSE = `
services: !override
  api:
    image: alpine
`

const SEALED_SECRET = 'sealed-ciphertext-must-not-appear'

async function withFixtures(
  fn: (ctx: {
    db: Db
    app: Hono<AppEnv>
    secrets: Secrets
    organizationId: string
    cookie: string
    ids: { production: string; staging: string; solo: string; empty: string; broken: string }
    otherOrg: { organizationId: string; cookie: string }
    plainMember: { cookie: string }
  }) => Promise<void>
): Promise<void> {
  if (!dbUrl) {
    skipWithoutDatabase('environment config-view route tests')
    return
  }
  const db = createDenoDb()
  const secrets = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    return next()
  })
  registerEnvironmentConfigViewRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })

  const nonce = crypto.randomUUID()
  const createdOrgs: string[] = []
  const createdUsers: string[] = []
  const cookieFor = async (userId: string) => {
    const { token } = await createSession(db, userId, {})
    return `${HTTP_SESSION_COOKIE_NAME}=${await buildSignedCookie(token, secrets)}`
  }
  const makeOrg = async (label: string, role: 'organization:manage' | null) => {
    const [org] = await db
      .insert(organization)
      .values({ name: `Config View ${label} ${nonce}` })
      .returning({ id: organization.id })
    createdOrgs.push(org!.id)
    const [person] = await db
      .insert(user)
      .values({ email: `cfg-${label}-${nonce}@example.com`, isEmailVerified: true, role: 'user' })
      .returning({ id: user.id })
    createdUsers.push(person!.id)
    if (role) {
      await db.insert(grant).values({
        entityType: 'organization',
        entityId: org!.id,
        actorType: 'user',
        actorId: person!.id,
        permission: role,
      })
    }
    return { organizationId: org!.id, userId: person!.id }
  }

  const owner = await makeOrg('a', 'organization:manage')
  const other = await makeOrg('b', 'organization:manage')
  const member = await makeOrg('member', null)
  const [ws] = await db
    .insert(workspace)
    .values({ name: 'Config View Workspace', organizationId: owner.organizationId })
    .returning({ id: workspace.id })
  const [proj] = await db
    .insert(project)
    .values({
      name: 'Config View Project',
      workspaceId: ws!.id,
      organizationId: owner.organizationId,
      options: { compose: yamlToComposeDocument(BASE_COMPOSE) },
    })
    .returning({ id: project.id })

  const makeEnvironment = async (name: string, options: Record<string, unknown> | null) => {
    const [row] = await db
      .insert(environment)
      .values({ name, projectId: proj!.id, options })
      .returning({ id: environment.id })
    return row!.id
  }
  const ids = {
    production: await makeEnvironment('Production', null),
    staging: await makeEnvironment('Staging', { compose: yamlToComposeDocument(STAGING_COMPOSE) }),
    solo: await makeEnvironment('Solo', { compose: yamlToComposeDocument(SOLO_COMPOSE) }),
    empty: await makeEnvironment('Empty', {}),
    broken: await makeEnvironment('Broken', { compose: { version: 2, data: 'nope' } }),
  }
  await db.insert(service).values({ environmentId: ids.staging, composeServiceName: 'web' })
  await db.insert(variable).values([
    { projectId: proj!.id, key: 'SITE_URL', value: 'https://base.example.com' },
    { projectId: proj!.id, key: 'API_TOKEN', value: SEALED_SECRET, isSecret: true },
    { environmentId: ids.staging, key: 'SITE_URL', value: 'https://staging.example.com' },
    { environmentId: ids.staging, key: 'STAGE_ONLY', value: SEALED_SECRET, isSecret: true },
  ])

  try {
    await fn({
      db,
      app,
      secrets,
      organizationId: owner.organizationId,
      cookie: await cookieFor(owner.userId),
      ids,
      otherOrg: {
        organizationId: other.organizationId,
        cookie: await cookieFor(other.userId),
      },
      // A signed-in person with no grant anywhere, asking inside organization A.
      plainMember: { cookie: await cookieFor(member.userId) },
    })
  } finally {
    const envIds = Object.values(ids)
    await db.delete(variable).where(inArray(variable.environmentId, envIds))
    await db.delete(variable).where(eq(variable.projectId, proj!.id))
    await db.delete(service).where(inArray(service.environmentId, envIds))
    await db.delete(environment).where(eq(environment.projectId, proj!.id))
    await db.delete(project).where(eq(project.id, proj!.id))
    await db.delete(workspace).where(eq(workspace.id, ws!.id))
    await db.delete(grant).where(inArray(grant.actorId, createdUsers))
    await db.delete(user).where(inArray(user.id, createdUsers))
    await db.delete(organization).where(inArray(organization.id, createdOrgs))
  }
}

function get(
  app: Hono<AppEnv>,
  environmentId: string,
  headers: { cookie?: string; organizationId?: string }
) {
  return app.request(`/environments/${environmentId}/config-view`, {
    headers: {
      ...(headers.cookie ? { Cookie: headers.cookie } : {}),
      ...(headers.organizationId ? { [ORG_ID_HEADER]: headers.organizationId } : {}),
    },
  })
}

test('GET /environments/:id/config-view shows what a following environment changes from the Base', async () => {
  await withFixtures(async ({ app, cookie, organizationId, ids }) => {
    const res = await get(app, ids.staging, { cookie, organizationId })
    assertEquals(res.status, 200)
    const text = await res.text()
    // Secret values are never sent, and neither is the raw extension block.
    assertFalse(text.includes(SEALED_SECRET))
    assertFalse(text.includes(COMPOSE_SECRET))
    assertFalse(text.includes('x-turbopanel'))
    const body = JSON.parse(text)
    assertEquals(body.ok, true)
    assertEquals(body.environmentId, ids.staging)
    assertEquals(body.followsBase, true)
    assertEquals(
      body.effective.services.map((s: { name: string }) => s.name),
      ['web', 'blog']
    )
    const web = body.effective.services[0]
    assert(typeof web.serviceId === 'string')
    assertEquals(body.base.services[0].serviceId, null)
    const changes = body.changes.map((c: { key: string; kind: string; masked: boolean }) => [
      c.key,
      c.kind,
      c.masked,
    ])
    assertEquals(changes, [
      ['svc:web:command', 'changed', false],
      ['var:SITE_URL', 'changed', false],
      ['var:STAGE_ONLY', 'added', true],
    ])
    const command = body.changes[0]
    assertEquals(
      [command.baseValue, command.baseSource, command.envValue, command.envSource],
      ['serve --port 80', 'base', 'serve --port 8080', 'environment']
    )
    assertEquals(command.serviceId, web.serviceId)
    const variables = new Map(
      body.effective.variables.map((v: { name: string }) => [v.name, v])
    ) as Map<string, { value: string | null; isSecret: boolean; source: string }>
    assertEquals(variables.get('SITE_URL')!.source, 'environment')
    assertEquals(variables.get('API_TOKEN')!.source, 'project')
    assertEquals(
      [variables.get('API_TOKEN')!.value, variables.get('API_TOKEN')!.isSecret],
      [null, true]
    )
    assertEquals(body.effective.linuxUsers[0].usedBy, ['blog'])
  })
})

test('GET /environments/:id/config-view: no compose of its own means no changes', async () => {
  await withFixtures(async ({ app, cookie, organizationId, ids }) => {
    for (const id of [ids.production, ids.empty]) {
      const res = await get(app, id, { cookie, organizationId })
      assertEquals(res.status, 200)
      const body = await res.json()
      assertEquals(body.followsBase, true)
      assertEquals(body.changes, [])
      assertEquals(body.effective.services.length, 2)
    }
  })
})

test('GET /environments/:id/config-view: services: !override stands alone', async () => {
  await withFixtures(async ({ app, cookie, organizationId, ids }) => {
    const res = await get(app, ids.solo, { cookie, organizationId })
    assertEquals(res.status, 200)
    const body = await res.json()
    assertEquals(body.followsBase, false)
    assertEquals(
      body.effective.services.map((s: { name: string; source: string }) => [s.name, s.source]),
      [['api', 'environment']]
    )
    assert(
      body.changes.some(
        (c: { key: string; kind: string }) => c.key === 'svc:api' && c.kind === 'added'
      )
    )
    assert(
      body.changes.some(
        (c: { key: string; kind: string }) => c.key === 'svc:web' && c.kind === 'removed'
      )
    )
  })
})

test('GET /environments/:id/config-view: an unreadable saved compose is a plain 422', async () => {
  await withFixtures(async ({ app, cookie, organizationId, ids }) => {
    const res = await get(app, ids.broken, { cookie, organizationId })
    assertEquals(res.status, 422)
    const body = await res.json()
    assertEquals(body.error, 'compose_invalid')
    assert(String(body.message).startsWith('A saved compose file'))
  })
})

test('GET /environments/:id/config-view: sign-in, organization and permission checks', async () => {
  await withFixtures(async ({ app, cookie, organizationId, ids, otherOrg, plainMember }) => {
    assertEquals((await get(app, ids.staging, {})).status, 401)

    // Another organization's owner, in their own organization or spoofing this one.
    for (const org of [otherOrg.organizationId, organizationId]) {
      const res = await get(app, ids.staging, { cookie: otherOrg.cookie, organizationId: org })
      assert(res.status === 404 || res.status === 403, `status ${res.status}`)
      assertFalse((await res.text()).includes('serve --port'))
    }

    // A person with no grant in this organization.
    const denied = await get(app, ids.staging, { cookie: plainMember.cookie, organizationId })
    assert(denied.status === 403 || denied.status === 404, `status ${denied.status}`)

    // An id that exists nowhere.
    const missing = await get(app, crypto.randomUUID(), { cookie, organizationId })
    assertEquals(missing.status, 404)
  })
})
