/**
 * The cleanup tick against a real database and a faked DNS host: it removes
 * the listed records, by id, of an ended server-placed order, and leaves an
 * open order and a row nobody orders for alone. Skips without
 * TURBOPANEL_DATABASE_URL.
 */
import { skipWithoutDatabase } from '../../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../../db/connection.ts'
import { getDatabaseUrl } from '../../../db/url.ts'
import { organization, tls } from '../../../db/schema.ts'
import { deriveEncryptionSecretsConfig } from '../../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../../test-fixtures/secrets.ts'
import type { CredentialReport } from '../../tunnels/adapter.ts'
import { insertBadge, insertCarrier, sealToken } from '../../tunnels/records.ts'
import { runDnsCertificateCleanupTick } from './cleanup.ts'
import { readDnsCertState } from './order-state.ts'
import type { DnsChallengeProvider } from './dns-provider.ts'

/** Jest/Mocha-shaped alias for {@link Deno.test}; keeps Sonar's test detection happy. */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()
const ZONE = { id: 'zone-1', name: 'example.com' }
const report: CredentialReport = {
  accounts: [],
  zones: [],
  accountVisible: true,
  capabilities: { tunnels: false, dns: [ZONE], certificates: [] },
  missing: [],
  token: { kind: 'account', id: null, status: 'active', expiresAt: null },
}

test('an ended server-placed order loses its listed records by id; an open one keeps them', async () => {
  if (!dbUrl) return skipWithoutDatabase('dns cleanup tests')
  const db = createDenoDb()
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption'
  )
  const [org] = await db
    .insert(organization)
    .values({ name: `Cleanup Org ${crypto.randomUUID()}` })
    .returning({ id: organization.id })
  const organizationId = org!.id
  try {
    const carrier = await insertCarrier(db, {
      organizationId,
      provider: 'cloudflare',
      name: 'Main',
      externalAccountId: 'acct-1',
    })
    await insertBadge(db, {
      organizationId,
      carrier,
      label: 'dns-token',
      sealed: await sealToken(secrets, 'dns-token'),
      lastFour: 'oken',
      report,
    })
    const make = async (endedAt: string | null, recordId: string) => {
      const [row] = await db
        .insert(tls)
        .values({
          organizationId,
          name: 'Order',
          source: 'lets_encrypt',
          status: 'automatic',
          metadata: {
            dnsNames: ['example.com'],
            acme: { managedBy: 'server', challengeType: 'dns-01' },
            httpCert: { endedAt },
            dnsCert: {
              carrierId: carrier.id,
              zones: [ZONE],
              claimUntil: null,
              records: [
                {
                  zoneId: ZONE.id,
                  recordId,
                  name: '_acme-challenge.example.com',
                  createdAt: '2026-11-01T12:00:00.000Z',
                },
              ],
            },
          },
        })
        .returning({ id: tls.id })
      return row!.id
    }
    const ended = await make('2026-11-01T12:05:00.000Z', 'rec-ended')
    const open = await make(null, 'rec-open')
    const removed: string[] = []
    const dns: DnsChallengeProvider = {
      lookupCname: () => Promise.resolve(null),
      present: () => Promise.reject(new Error('not used')),
      remove: (ref) => {
        removed.push(ref.recordId)
        return Promise.resolve()
      },
    }
    const result = await runDnsCertificateCleanupTick(
      { db, secrets, dns: () => dns },
      { organizationId }
    )
    assertEquals(result.removed, 1)
    assertEquals(removed, ['rec-ended'])
    const [endedRow] = await db.select().from(tls).where(eq(tls.id, ended))
    const [openRow] = await db.select().from(tls).where(eq(tls.id, open))
    const records = (row: typeof endedRow) => readDnsCertState(row!.metadata)?.records.length
    assertEquals(records(endedRow), 0)
    assertEquals(records(openRow), 1)
  } finally {
    await db.delete(organization).where(eq(organization.id, organizationId))
    await endDbConnection(db)
  }
})
