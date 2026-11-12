import { assert, assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import type { DaemonCellRegistry } from '../../../contracts/cell.ts'
import { createDenoDb, endDbConnection } from '../../../db/connection.ts'
import { ingressAccount, instanceHostname } from '../../../db/schema.ts'
import { decryptSecret } from '../../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../../../lib/secrets/secrets.ts'
import { skipWithoutDatabase } from '../../../test-fixtures/require-service.test.support.ts'
import { parseTestSecretsConfig } from '../../../test-fixtures/secrets.ts'
import { removeIngressAccount, saveIngressAccount } from './cloudflare/account.ts'
import { createFakeCloudflare } from './cloudflare/fake-cloudflare.test.support.ts'
import { listInstanceHostnames } from '../../../features/install/instance-hostnames.ts'
import {
  SELF_HOSTED_PUBLIC_PORT_ERROR,
  setSelfHostedAddress,
} from '../../../features/install/ingress-modes.ts'
import type { EdgeGate } from './gate.ts'
import { applyIngress, readStoredIngress, setHostnameIngress } from './service.ts'

const test = Deno.test.bind(Deno)
const dbUrl = Deno.env.get('TURBOPANEL_DATABASE_URL')
const TOKEN = 'cfut_serviceFixtureToken0123456789abcdef'

const OPEN: EdgeGate = { open: true, waiting: [], remoteServers: 0, forcedClosed: false }
const SHUT: EdgeGate = {
  open: false,
  reason:
    "1 server still needs to re-learn this control plane's key before an edge mode can be used: kappa.",
  waiting: [{ id: 'srv-1', name: 'kappa', organizationId: 'org-1', pinnedBy: null }],
  remoteServers: 1,
  forcedClosed: false,
}
const openGate = () => Promise.resolve(OPEN)
const shutGate = () => Promise.resolve(SHUT)

const NO_DAEMON = {
  getSnapshots: () => Promise.resolve(new Map()),
  listOnlineServerIds: () => Promise.resolve([]),
} as unknown as DaemonCellRegistry

test('an account is stored sealed, used by a tunnel hostname, and cannot be removed while in use', async () => {
  if (!dbUrl) return skipWithoutDatabase('ingress service tests')
  const db = createDenoDb()
  const dataEncryption = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption'
  )
  const cf = createFakeCloudflare({ token: TOKEN })
  const host = `https://tunnel-${crypto.randomUUID().slice(0, 8)}.example.com:8443`
  let accountId = ''
  let hostnameId = ''
  try {
    const saved = await saveIngressAccount(
      db,
      { label: 'Service fixture', token: TOKEN, createdByUserId: null },
      { dataEncryption, fetch: cf.fetch }
    )
    assert(saved.ok)
    accountId = saved.id
    const [stored] = await db.select().from(ingressAccount).where(eq(ingressAccount.id, accountId))
    assertEquals(stored?.tokenEnvelope.includes(TOKEN), false)
    assertEquals(await decryptSecret(dataEncryption, stored!.tokenEnvelope), TOKEN)

    const [row] = await db
      .insert(instanceHostname)
      .values({ host, source: 'platform-ca' })
      .returning({ id: instanceHostname.id })
    hostnameId = row!.id
    const service = {
      dataEncryption,
      secretsConfig: undefined,
      registry: NO_DAEMON,
      env: {},
      selfKid: () => null,
      fetch: cf.fetch,
      edgeGate: shutGate,
    }
    // A listener mode sets nothing up, so changing the mode afterwards needs no disconnect.
    assertEquals((await applyIngress(db, hostnameId, service))?.ok, true)
    const wrong = await setHostnameIngress(
      db,
      hostnameId,
      { mode: 'direct', ingressId: accountId },
      openGate
    )
    assertEquals(wrong.ok ? 0 : wrong.status, 422)
    // Self-hosted: the address is always :8443, so any other port is a plain 400.
    setSelfHostedAddress(true)
    try {
      const refused = await setHostnameIngress(db, hostnameId, { publicPort: 443 }, openGate)
      assertEquals(refused.ok ? 0 : refused.status, 400)
      assertEquals(refused.ok ? '' : refused.error, SELF_HOSTED_PUBLIC_PORT_ERROR)
      assertEquals(
        (await setHostnameIngress(db, hostnameId, { publicPort: 8443 }, openGate)).ok,
        true
      )
      // A row stored on 443 by an older save reads back as 8443.
      await db
        .update(instanceHostname)
        .set({ publicPort: 443 })
        .where(eq(instanceHostname.id, hostnameId))
      const stored = (await listInstanceHostnames(db)).find((item) => item.id === hostnameId)
      assertEquals(stored?.publicPort, 8443)
    } finally {
      setSelfHostedAddress(false)
    }
    // High Availability keeps the stored port.
    assertEquals((await setHostnameIngress(db, hostnameId, { publicPort: 443 }, openGate)).ok, true)
    assertEquals(
      (await listInstanceHostnames(db)).find((item) => item.id === hostnameId)?.publicPort,
      443
    )
    assertEquals(
      (await setHostnameIngress(db, hostnameId, { publicPort: 8443 }, openGate)).ok,
      true
    )
    // A remote server that has not pinned this control plane's key: the switch is a 409 naming it.
    const held = await setHostnameIngress(
      db,
      hostnameId,
      { mode: 'cloudflare-tunnel', ingressId: accountId },
      shutGate
    )
    assertEquals(held.ok ? 0 : held.status, 409)
    assertEquals(held.ok ? '' : held.error, SHUT.reason)
    assertEquals(held.ok ? [] : held.waiting?.map((item) => item.name), ['kappa'])
    const set = await setHostnameIngress(
      db,
      hostnameId,
      { mode: 'cloudflare-tunnel', ingressId: accountId },
      openGate
    )
    assert(set.ok)
    // Changing only the account on an edge row does not read the gate again.
    assertEquals(
      (await setHostnameIngress(db, hostnameId, { ingressId: accountId }, shutGate)).ok,
      true
    )

    const inUse = await removeIngressAccount(db, accountId)
    assertEquals(inUse.ok ? [] : inUse.hostnames, [host])

    // The gate shut again before Connect: apply is refused and nothing is stored but the refusal.
    const applied = await applyIngress(db, hostnameId, service)
    assertEquals(applied?.ok ? '' : applied?.cause, 'gate-closed')
    const [after] = await db
      .select()
      .from(instanceHostname)
      .where(eq(instanceHostname.id, hostnameId))
    const state = readStoredIngress(after?.ingressState)
    assertEquals(state.provider, null)
    assertEquals(state.lastApply?.cause, 'gate-closed')
    assertEquals(JSON.stringify(after?.ingressState).includes(TOKEN), false)
  } finally {
    if (hostnameId) await db.delete(instanceHostname).where(eq(instanceHostname.id, hostnameId))
    if (accountId) assertEquals((await removeIngressAccount(db, accountId)).ok, true)
    await endDbConnection(db)
  }
})
