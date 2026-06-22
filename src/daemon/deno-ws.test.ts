import { assertEquals } from 'jsr:@std/assert'
import { Hono } from 'hono'
import {
  deriveSecretsConfig,
  parseSecretsEnv,
} from '../client/authn/secrets.ts'
import { generateSecret } from '../generate-secret.ts'
import { issueDaemonJwt } from './authn/daemon-jwt.ts'
import { registerDaemonWebSocket } from './deno-ws.ts'
import { DAEMON_WS_PATH } from '../surfaces.ts'

async function createDaemonJwtSecrets() {
  const parsed = parseSecretsEnv(generateSecret(), undefined, 'deno')
  return deriveSecretsConfig(parsed, 'daemon-jwt-signing')
}

Deno.test('WS upgrade accepts HTTP 101 with valid JWT', async () => {
  const app = new Hono()
  const secrets = await createDaemonJwtSecrets()
  registerDaemonWebSocket(app, { secrets })

  const issued = await issueDaemonJwt(
    { sub: 'srv-test', sid: crypto.randomUUID(), kid: 'key-test' },
    secrets,
  )
  const response = await app.request(DAEMON_WS_PATH, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${issued.token}`,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGVzdC1rZXk=',
    },
  })
  assertEquals(response.status, 101)
})

Deno.test('WS upgrade rejects HTTP 401 when no JWT is provided', async () => {
  const app = new Hono()
  const secrets = await createDaemonJwtSecrets()
  registerDaemonWebSocket(app, { secrets })

  const response = await app.request(DAEMON_WS_PATH, { method: 'GET' })
  assertEquals(response.status, 401)
})

Deno.test('WS upgrade rejects HTTP 401 when JWT is invalid', async () => {
  const app = new Hono()
  const secrets = await createDaemonJwtSecrets()
  registerDaemonWebSocket(app, { secrets })

  const response = await app.request(DAEMON_WS_PATH, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer invalid-token',
    },
  })
  assertEquals(response.status, 401)
})
