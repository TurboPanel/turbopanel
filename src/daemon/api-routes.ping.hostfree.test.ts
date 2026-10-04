import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../app/app.ts'
import { DAEMON_API_PREFIX } from '../app/surfaces.ts'
import { parseTestSecretsConfig } from '../test-fixtures/secrets.ts'
import { registerDaemonApiRoutes } from './api-routes.ts'
import { deriveDaemonJwtKeyring } from './authn/daemon-jwt-keyring.ts'
import { issueDaemonJwt } from './authn/daemon-jwt.ts'

/** Sonar S2187 only recognizes `test()`; alias Deno.test so analysis sees real tests. */
const test = Deno.test.bind(Deno)

async function pingApp() {
  const keyring = await deriveDaemonJwtKeyring(parseTestSecretsConfig())
  const issued = await issueDaemonJwt(
    { sub: '00000000-0000-4000-8000-0000000000aa', kid: 'key-1' },
    keyring
  )
  const app = new Hono<AppEnv>()
  registerDaemonApiRoutes(app, { secrets: keyring })
  return { app, token: issued.token }
}

test('GET /ping rejects a request without a daemon token', async () => {
  const { app } = await pingApp()
  const response = await app.request(`${DAEMON_API_PREFIX}/ping`)
  assertEquals(response.status, 401)
})

test('GET /ping rejects an invalid daemon token', async () => {
  const { app } = await pingApp()
  const response = await app.request(`${DAEMON_API_PREFIX}/ping`, {
    headers: { Authorization: 'Bearer not-a-token' },
  })
  assertEquals(response.status, 401)
})

test('GET /ping answers a valid daemon token with ok and a timestamp only', async () => {
  const { app, token } = await pingApp()
  const response = await app.request(`${DAEMON_API_PREFIX}/ping`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assertEquals(response.status, 200)
  const body = (await response.json()) as { ok?: unknown; at?: unknown }
  assertEquals(Object.keys(body).sort(), ['at', 'ok'])
  assertEquals(body.ok, true)
  assertEquals(Number.isNaN(Date.parse(String(body.at))), false)
})
