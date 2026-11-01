/// <reference types="@cloudflare/vitest-pool-workers/types" />
/// <reference path="./vitest-env.d.ts" />
/// <reference path="../../worker-configuration.d.ts" />
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { parseSecretsFromEnv } from '../lib/secrets/secrets.ts'
import { deriveDaemonJwtKeyring } from './authn/daemon-jwt-keyring.ts'
import { issueDaemonJwt } from './authn/daemon-jwt.ts'
import { setDaemonCellProjectionDbFactoryForTests } from './cell/do.ts'
import { createWorkersDb, endDbConnection } from '../db/connection.ts'
import { instanceHostname, organization, server, tls } from '../db/schema.ts'

const CELL_HEADER = 'X-Turbopanel-Cell-Server-Id'

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

// Own file for the same reason as `acme-issuance-event.workers-e2e.test.ts`:
// real Hyperdrive projections from a Durable Object are only deterministic
// without other DO churn in the same isolate. Skips without HYPERDRIVE.
describe('instance-acme-issuance-event real-Postgres end-to-end', () => {
  it('the Durable Object drops an instance ACME result from a server that does not run the panel', async () => {
    if (!env.HYPERDRIVE) {
      console.warn('skipping real-Postgres instance ACME test: no HYPERDRIVE binding')
      return
    }
    setDaemonCellProjectionDbFactoryForTests(null)
    const realDb = createWorkersDb(env.HYPERDRIVE)
    try {
      const [org] = await realDb.insert(organization).values({}).returning({ id: organization.id })
      const suffix = crypto.randomUUID().slice(0, 8)
      const instanceHost = `instance-acme-e2e-${suffix}.example.com`
      const tenantHost = `tenant-acme-e2e-${suffix}.example.com`
      await realDb.insert(instanceHostname).values({ host: instanceHost, source: 'lets-encrypt' })
      // A tenant row the same socket reports on afterwards: once its error
      // lands, the instance frame sent before it has been handled too.
      const [tenantRow] = await realDb
        .insert(tls)
        .values({
          organizationId: org!.id,
          source: 'lets_encrypt',
          status: 'automatic',
          metadata: { dnsNames: [tenantHost] },
        })
        .returning({ id: tls.id })
      const [srv] = await realDb
        .insert(server)
        .values({ organizationId: org!.id, name: 'instance-acme-e2e' })
        .returning({ id: server.id })
      const serverId = srv!.id
      const secrets = await deriveDaemonJwtKeyring(
        parseSecretsFromEnv(
          { TURBOPANEL_SECRET: env.TURBOPANEL_SECRET, TURBOPANEL_SECRETS: env.TURBOPANEL_SECRETS },
          'workers'
        )
      )
      const { token } = await issueDaemonJwt({ sub: serverId, kid: crypto.randomUUID() }, secrets)
      const stub = env.DAEMON_CELL.getByName(serverId)
      const response = await stub.fetch('https://do.internal/ws/daemon/v1', {
        headers: { Authorization: `Bearer ${token}`, Upgrade: 'websocket' },
      })
      expect(response.status).toBe(101)
      const ws = response.webSocket
      if (!ws) throw new Error('missing websocket')
      ws.accept()

      const at = new Date().toISOString()
      ws.send(
        JSON.stringify({
          type: 'instance-acme-issuance-event',
          hostname: instanceHost,
          ok: false,
          errorMessage: 'forged failure',
          at,
        })
      )
      ws.send(
        JSON.stringify({
          type: 'acme-issuance-event',
          hostname: tenantHost,
          ok: false,
          errorMessage: 'tenant failure',
          at,
        })
      )

      const tenantLanded = await waitFor(async () => {
        const [after] = await realDb
          .select({ metadata: tls.metadata })
          .from(tls)
          .where(eq(tls.id, tenantRow!.id))
        return (
          (after?.metadata as { acme?: { lastError?: string } } | null)?.acme?.lastError ===
          'tenant failure'
        )
      })
      expect(tenantLanded).toBe(true)
      // Frames on one socket can overlap at I/O; give the instance frame time
      // to finish too, so a late write would show up below.
      await new Promise((resolve) => setTimeout(resolve, 500))
      const [instanceRow] = await realDb
        .select({
          acmeLastError: instanceHostname.acmeLastError,
          acmeLastAttemptAt: instanceHostname.acmeLastAttemptAt,
        })
        .from(instanceHostname)
        .where(eq(instanceHostname.host, instanceHost))
      expect(instanceRow?.acmeLastError ?? null).toBeNull()
      expect(instanceRow?.acmeLastAttemptAt ?? null).toBeNull()

      ws.close(1000, 'test done')
      // Drain the Durable Object before the isolate goes away (see the
      // tenant ACME e2e test for why): wait for the disconnect projection,
      // then purge the cell.
      const disconnected = await waitFor(async () => {
        const [after] = await realDb
          .select({ isConnected: server.isConnected })
          .from(server)
          .where(eq(server.id, serverId))
        return after?.isConnected === false
      })
      expect(disconnected).toBe(true)
      const purge = await stub.fetch('https://do.internal/rpc/purge-cell', {
        method: 'POST',
        headers: { [CELL_HEADER]: serverId, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(purge.status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 250))
      await realDb.delete(instanceHostname).where(eq(instanceHostname.host, instanceHost))
    } finally {
      await endDbConnection(realDb)
      setDaemonCellProjectionDbFactoryForTests(null)
    }
  }, 20_000)
})
