import { assert, assertEquals, assertNotEquals, assertRejects } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import { setting } from '../../db/schema.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { decryptSecret } from '../secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../secrets/secrets.ts'
import {
  ensurePanelIdentity,
  PANEL_IDENTITY_SETTING_KEY,
  setPanelIdentityNext,
} from './identity.ts'

const test = Deno.test.bind(Deno)

const dbUrl = Deno.env.get('TURBOPANEL_DATABASE_URL')

test('ensurePanelIdentity inserts once, reopens the same key, and seals the seeds', async () => {
  if (!dbUrl) {
    skipWithoutDatabase('panel identity store tests')
    return
  }
  const db = createDenoDb()
  try {
    const secrets = await deriveEncryptionSecretsConfig(
      parseTestSecretsConfig('deno'),
      'data-encryption'
    )
    await db.delete(setting).where(eq(setting.key, PANEL_IDENTITY_SETTING_KEY))
    const first = await ensurePanelIdentity(db, secrets)
    const second = await ensurePanelIdentity(db, secrets)
    assertEquals(second.current.kid, first.current.kid)
    assertEquals(second.seal.kid, first.seal.kid)
    assertEquals(first.keyset, 1)

    const [row] = await db
      .select({ value: setting.value })
      .from(setting)
      .where(eq(setting.key, PANEL_IDENTITY_SETTING_KEY))
    const stored = row!.value as { sealed: string; currentKid: string }
    assertEquals(stored.currentKid, first.current.kid)
    assert(stored.sealed.startsWith('tpsecret.'))
    assertEquals(Object.keys(JSON.parse(await decryptSecret(secrets, stored.sealed))).sort(), [
      'ed25519Seed',
      'x25519Seed',
    ])

    await assertRejects(() => setPanelIdentityNext(db, 'short'), TypeError)
    await assertRejects(() => setPanelIdentityNext(db, first.current.kid), TypeError)
    await setPanelIdentityNext(db, 'A'.repeat(43))
    const withNext = await ensurePanelIdentity(db, secrets)
    assertEquals(withNext.next, { kid: 'A'.repeat(43) })
    assertNotEquals(withNext.next?.kid, withNext.current.kid)
    await setPanelIdentityNext(db, null)
    assertEquals((await ensurePanelIdentity(db, secrets)).next, null)
  } finally {
    await db.delete(setting).where(eq(setting.key, PANEL_IDENTITY_SETTING_KEY))
    await endDbConnection(db)
  }
})
