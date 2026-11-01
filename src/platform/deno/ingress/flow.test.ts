import { assert, assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import type { DaemonCellRegistry } from '../../../contracts/cell.ts'
import { createDenoDb, endDbConnection } from '../../../db/connection.ts'
import { ingressAccount, instanceHostname, setting } from '../../../db/schema.ts'
import { deriveEncryptionSecretsConfig } from '../../../lib/secrets/secrets.ts'
import { skipWithoutDatabase } from '../../../test-fixtures/require-service.test.support.ts'
import { parseTestSecretsConfig } from '../../../test-fixtures/secrets.ts'
import { recheckIngressAccount, saveIngressAccount } from './cloudflare/account.ts'
import { createFakeCloudflare } from './cloudflare/fake-cloudflare.test.support.ts'
import { readInstanceConnector } from './cloudflare/instance-tunnel.ts'
import { EDGE_GATE_SETTING_KEY, readEdgeGate, writeEdgeGate } from './gate.ts'
import {
  applyIngress,
  ingressStatus,
  preflightIngress,
  readStoredIngress,
  refreshEdgeStatuses,
  removeIngress,
  setHostnameIngress,
} from './service.ts'
import { createIngressTick } from './tick.ts'

const test = Deno.test.bind(Deno)
const dbUrl = Deno.env.get('TURBOPANEL_DATABASE_URL')
const TOKEN = 'cfut_flowFixtureToken0123456789abcdef'

const NO_DAEMON = {
  getSnapshots: () => Promise.resolve(new Map()),
  listOnlineServerIds: () => Promise.resolve([]),
} as unknown as DaemonCellRegistry

test('a tunnel hostname is applied, reports health, refreshes and is removed', async () => {
  if (!dbUrl) return skipWithoutDatabase('ingress flow tests')
  const db = createDenoDb()
  const dataEncryption = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption'
  )
  const cf = createFakeCloudflare({ token: TOKEN })
  const pushed: string[] = []
  const name = `flow-${crypto.randomUUID().slice(0, 8)}.example.com`
  const service = {
    dataEncryption,
    secretsConfig: undefined,
    registry: NO_DAEMON,
    env: {},
    selfKid: () => null,
    fetch: cf.fetch,
    colocatedDaemonConnected: () => Promise.resolve(true),
    pushRunToken: (token: string) => {
      pushed.push(token)
      return Promise.resolve({ ok: true as const })
    },
  }
  let accountId = ''
  let hostnameId = ''
  try {
    await writeEdgeGate(db, true, 'root@example.com')
    assertEquals((await readEdgeGate(db, {})).open, true)
    assertEquals((await readEdgeGate(db, { TURBOPANEL_EDGE_GATE: 'closed' })).open, false)

    const saved = await saveIngressAccount(
      db,
      { label: 'Flow fixture', token: TOKEN, createdByUserId: null },
      { dataEncryption, fetch: cf.fetch }
    )
    assert(saved.ok)
    accountId = saved.id
    assertEquals(
      (await recheckIngressAccount(db, accountId, { dataEncryption, fetch: cf.fetch }))?.ok,
      true
    )

    const [row] = await db
      .insert(instanceHostname)
      .values({ host: `https://${name}:8443`, source: 'platform-ca' })
      .returning({ id: instanceHostname.id })
    hostnameId = row!.id
    assert(
      (
        await setHostnameIngress(db, hostnameId, {
          mode: 'cloudflare-tunnel',
          ingressId: accountId,
        })
      ).ok
    )
    assertEquals((await preflightIngress(db, hostnameId, service))?.ok, true)

    const applied = await applyIngress(db, hostnameId, service)
    assertEquals(applied?.ok, true)
    assertEquals(pushed.length, 1)
    const busy = await setHostnameIngress(db, hostnameId, { mode: 'direct' })
    assertEquals(busy.ok ? 0 : busy.status, 409)

    cf.tunnels[0]!.status = 'healthy'
    cf.tunnels[0]!.connections = [{}, {}, {}, {}]
    const status = await ingressStatus(db, hostnameId, service)
    // No signed identity comes back through the fake edge, so the self-check fails.
    assertEquals(status?.phase, 'degraded')
    await refreshEdgeStatuses(db, service)
    const [stored] = await db
      .select()
      .from(instanceHostname)
      .where(eq(instanceHostname.id, hostnameId))
    assertEquals(readStoredIngress(stored?.ingressState).status?.cause, 'edge-unreachable')

    await createIngressTick(service)(db)

    assertEquals(await removeIngress(db, hostnameId, service), true)
    assertEquals(cf.tunnels.length, 0)
    assertEquals(pushed.at(-1), '')
    assertEquals(await removeIngress(db, crypto.randomUUID(), service), false)
  } finally {
    if (hostnameId) await db.delete(instanceHostname).where(eq(instanceHostname.id, hostnameId))
    if (accountId) await db.delete(ingressAccount).where(eq(ingressAccount.id, accountId))
    await db.delete(setting).where(eq(setting.key, EDGE_GATE_SETTING_KEY))
    await endDbConnection(db)
  }
})

test('the connector view explains why it is empty without a co-located daemon', async () => {
  if (!dbUrl) return skipWithoutDatabase('ingress flow tests')
  const db = createDenoDb()
  try {
    const view = await readInstanceConnector(db, NO_DAEMON)
    assertEquals(view.connector, null)
    assert(view.note)
  } finally {
    await endDbConnection(db)
  }
})
