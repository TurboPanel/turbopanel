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
import { applyIngress, readStoredIngress, setHostnameIngress } from './service.ts'

const test = Deno.test.bind(Deno)
const dbUrl = Deno.env.get('TURBOPANEL_DATABASE_URL')
const TOKEN = 'cfut_serviceFixtureToken0123456789abcdef'

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
    }
    // A listener mode sets nothing up, so changing the mode afterwards needs no disconnect.
    assertEquals((await applyIngress(db, hostnameId, service))?.ok, true)
    const wrong = await setHostnameIngress(db, hostnameId, { mode: 'direct', ingressId: accountId })
    assertEquals(wrong.ok ? 0 : wrong.status, 422)
    const set = await setHostnameIngress(db, hostnameId, {
      mode: 'cloudflare-tunnel',
      ingressId: accountId,
    })
    assert(set.ok)

    const inUse = await removeIngressAccount(db, accountId)
    assertEquals(inUse.ok ? [] : inUse.hostnames, [host])

    // The gate is shut on a fresh install: apply is refused and nothing is stored but the refusal.
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
