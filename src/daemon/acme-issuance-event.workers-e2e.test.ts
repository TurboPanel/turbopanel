/// <reference types="@cloudflare/vitest-pool-workers/types" />
/// <reference path="./vitest-env.d.ts" />
/// <reference path="../../worker-configuration.d.ts" />
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { parseSecretsFromEnv } from '../client/authn/secrets.ts'
import { deriveDaemonJwtKeyring } from './authn/daemon-jwt-keyring.ts'
import { issueDaemonJwt } from './authn/daemon-jwt.ts'
import { setDaemonCellProjectionDbFactoryForTests } from './cell/do.ts'
import { createWorkersDb, endDbConnection } from '../db.ts'
import { organization, server, tls } from '../lib/db/schema.ts'

const CELL_HEADER = 'X-Turbopanel-Cell-Server-Id'

// Isolated on purpose, in its own file: the one piece
// `sec-acme-failure-visibility` (Road-to-0.1.x artifact) was left unticked
// for — the daemon -> control-plane WebSocket dispatch for
// `acme-issuance-event` — exercised end to end against a REAL Postgres via
// the real `env.HYPERDRIVE` binding, no mock `Db` anywhere in this test.
// Run alongside `durable-object.test.ts`'s 80+ mocked-Db tests in the same
// file, this test was observed to be flaky: the DO's own real-Hyperdrive
// connect projection and this test's own real-Hyperdrive dispatch query
// intermittently failed to see each other's writes/bindings under that
// file's heavier sequential DO churn, for reasons not fully root-caused in
// the time available. Isolated here, alone, it has been run and re-verified
// deterministically multiple times in a row against a real migrated
// Postgres. Requires CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE
// to point at one; skips itself otherwise.
describe('acme-issuance-event real-Postgres end-to-end', () => {
  it('the real WS dispatch patches metadata.acme.lastError on a real Postgres row, never status', async () => {
    if (!env.HYPERDRIVE) {
      console.warn('skipping real-Postgres acme-issuance-event test: no HYPERDRIVE binding')
      return
    }
    setDaemonCellProjectionDbFactoryForTests(null)
    const realDb = createWorkersDb(env.HYPERDRIVE)
    try {
      const [org] = await realDb.insert(organization).values({}).returning({ id: organization.id })
      // Unique per run: the handler patches the first `managed` row covering
      // the hostname, and this file never deletes its rows (throwaway-database
      // convention), so a fixed hostname would match a previous run's row on
      // the second run against the same database.
      const hostname = `acme-e2e-${crypto.randomUUID().slice(0, 8)}.example.com`
      const [row] = await realDb
        .insert(tls)
        .values({
          organizationId: org!.id,
          source: 'lets_encrypt',
          status: 'managed',
          metadata: { dnsNames: [hostname] },
        })
        .returning({ id: tls.id })

      // A real `server` row, so the DO's connect/disconnect projections this
      // WS open triggers have a row to write — and so the drain below can
      // observe the disconnect landing on `is_connected`.
      const [srv] = await realDb
        .insert(server)
        .values({ organizationId: org!.id, name: 'acme-e2e' })
        .returning({ id: server.id })
      const serverId = srv!.id
      const keyId = crypto.randomUUID()
      const secrets = await deriveDaemonJwtKeyring(
        parseSecretsFromEnv(
          { TURBOPANEL_SECRET: env.TURBOPANEL_SECRET, TURBOPANEL_SECRETS: env.TURBOPANEL_SECRETS },
          'workers'
        )
      )
      const { token } = await issueDaemonJwt({ sub: serverId, kid: keyId }, secrets)
      const stub = env.DAEMON_CELL.getByName(serverId)
      const response = await stub.fetch('https://do.internal/ws/daemon/v1', {
        headers: { Authorization: `Bearer ${token}`, Upgrade: 'websocket' },
      })
      expect(response.status).toBe(101)
      const ws = response.webSocket
      if (!ws) throw new Error('missing websocket')
      ws.accept()

      ws.send(
        JSON.stringify({
          type: 'acme-issuance-event',
          hostname,
          ok: false,
          errorMessage: 'received fatal alert: InternalError',
          at: new Date().toISOString(),
        })
      )

      const deadline = Date.now() + 10_000
      let lastError: unknown
      let matched = false
      while (Date.now() < deadline && !matched) {
        try {
          const [after] = await realDb
            .select({ metadata: tls.metadata, status: tls.status })
            .from(tls)
            .where(eq(tls.id, row!.id))
          expect((after?.metadata as { acme?: { lastError?: string } } | null)?.acme?.lastError).toBe(
            'received fatal alert: InternalError'
          )
          // The whole point of the merge-patch design: a recorded issuance
          // failure must never touch `status`, which is what deploy-readiness
          // (`isReadyCandidate`) actually reads.
          expect(after?.status).toBe('managed')
          matched = true
        } catch (err) {
          lastError = err
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      }
      if (!matched) throw lastError

      ws.close(1000, 'test done')

      // Drain the Durable Object before this file's isolate goes away. The
      // DO's connect/inbound/disconnect projections each open and close a
      // real postgres.js socket inside `ctx.waitUntil`, and its alarms open
      // more later. Returning while any of that is in flight lets the pool
      // tear the isolate down under an open socket -- workerd cancels the
      // stream ("Stream was cancelled"), which surfaces as an unhandled
      // rejection here and, on the CI runner, as a Vitest process that never
      // exits (Road to 0.1.x, `ci-turbopanel-build-hang`). So: wait for the
      // disconnect projection to land on the real row, then purge the cell
      // (closes sockets, deletes the alarm), then give the last `end()` a tick.
      const disconnectDeadline = Date.now() + 10_000
      let disconnected = false
      while (Date.now() < disconnectDeadline && !disconnected) {
        const [after] = await realDb
          .select({ isConnected: server.isConnected })
          .from(server)
          .where(eq(server.id, serverId))
        disconnected = after?.isConnected === false
        if (!disconnected) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(disconnected).toBe(true)

      const purge = await stub.fetch('https://do.internal/rpc/purge-cell', {
        method: 'POST',
        headers: { [CELL_HEADER]: serverId, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(purge.status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 250))
    } finally {
      await endDbConnection(realDb)
      setDaemonCellProjectionDbFactoryForTests(null)
    }
  }, 20_000)
})
