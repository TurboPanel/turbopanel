/**
 * Host-free coverage for container route authz short-circuits (no Postgres).
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import { container } from '../../lib/db/schema.ts'
import {
  createEmptyMockAuthState,
  createMockAuthDb,
  seedMockSession,
  seedMockUser,
} from '../authn/authn-hostfree-doubles.ts'
import {
  buildSignedCookie,
  HTTP_SESSION_COOKIE_NAME,
} from '../authn/crypto.ts'
import { deriveSecretsConfig } from '../authn/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { ORG_ID_HEADER } from '../org-context.ts'
import { registerContainerRoutes } from './routes.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const containerId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const serverId = '33333333-3333-4333-8333-333333333333'

test('GET /containers/:id/logs returns 403 without server read and does not enqueue', async () => {
  const secretsConfig = parseTestSecretsConfig('deno')
  const secrets = await deriveSecretsConfig(secretsConfig, 'session-signing')
  const token = crypto.randomUUID()
  const userId = crypto.randomUUID()
  const state = createEmptyMockAuthState()
  seedMockSession(state, token, {
    sessionId: crypto.randomUUID(),
    userId,
    email: `container-logs-${crypto.randomUUID()}@example.com`,
    role: 'superadmin',
  })
  seedMockUser(state, {
    id: userId,
    email: `container-logs-${crypto.randomUUID()}@example.com`,
    isDisabled: false,
    isEmailVerified: true,
    role: 'superadmin',
  })
  state.organizations.push({ id: organizationId, name: 'Container Org' })

  let executePhase = 0
  const authDb = createMockAuthDb(state)
  const origSelect = (
    authDb as unknown as {
      select: (fields?: unknown) => { from: (table: unknown) => unknown }
    }
  ).select.bind(authDb)

  const db = Object.assign(authDb, {
    execute: () => {
      executePhase += 1
      if (executePhase === 1) {
        return Promise.resolve([{ organization_id: organizationId }])
      }
      return Promise.resolve([{ allowed: false }])
    },
    select: (fields?: unknown) => ({
      from: (table: unknown) => {
        if (table === container) {
          return {
            innerJoin: () => ({
              where: () => ({
                limit: () =>
                  Promise.resolve([{
                    id: containerId,
                    serviceId: '44444444-4444-4444-8444-444444444444',
                    environmentId: '55555555-5555-4555-8555-555555555555',
                    serverId,
                    containerId: 'aabbccddeeff',
                    containerName: 'web-1',
                    status: 'running',
                    role: 'service',
                    composeServiceName: 'web',
                    ordinal: 1,
                    metadata: null,
                    options: null,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                  }]),
              }),
            }),
          }
        }
        return origSelect(fields).from(table)
      },
    }),
  }) as unknown as Db

  let cellRequests = 0
  const registry = {
    getCell: () => ({
      createRequestAndWait: () => {
        cellRequests += 1
        return Promise.resolve({
          status: 'done',
          result: { logs: 'should-not-run' },
        })
      },
    }),
  } as unknown as DaemonCellRegistry

  const signed = await buildSignedCookie(token, secrets)
  const cookie = `${HTTP_SESSION_COOKIE_NAME}=${signed}`
  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', db)
    c.set('daemonCellRegistry', registry)
    return next()
  })
  registerContainerRoutes(app, {
    secrets,
    runtime: 'deno',
    signupEnvOverride: undefined,
  })

  const res = await app.request(`/containers/${containerId}/logs`, {
    method: 'GET',
    headers: {
      Cookie: cookie,
      [ORG_ID_HEADER]: organizationId,
    },
  })

  assertEquals(res.status, 403)
  assertEquals(await res.json(), { error: 'Forbidden' })
  assertEquals(cellRequests, 0)
})
