import { assertEquals } from 'jsr:@std/assert'
import { it } from '@std/testing/bdd'
import { and, eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../../db-url.ts'
import { createDenoDb } from '../../db.ts'
import { COLOCATED_SERVER_DISPLAY_NAME } from '../authn/install-state.ts'
import { createLicense } from '../authn/license.ts'
import { license, organization, server } from '../../lib/db/schema.ts'
import {
  hasActiveColocatedLicenseBinding,
  isColocatedWithInstance,
  uncolocatedCandidates,
} from './colocated.ts'

const dbUrl = getDatabaseUrl()

it('isColocatedWithInstance returns true when the server id is in the set', () => {
  const colocatedIds = new Set(['srv-a', 'srv-b'])
  assertEquals(isColocatedWithInstance('srv-a', colocatedIds), true)
  assertEquals(isColocatedWithInstance('srv-c', colocatedIds), false)
})

it('isColocatedWithInstance is false for an empty colocated set', () => {
  assertEquals(isColocatedWithInstance('srv-a', new Set()), false)
})

it('uncolocatedCandidates filters already-marked ids', () => {
  assertEquals(
    uncolocatedCandidates(['a', 'b', 'c'], new Set(['b'])),
    ['a', 'c'],
  )
  assertEquals(uncolocatedCandidates(['a'], new Set(['a'])), [])
  assertEquals(uncolocatedCandidates([], new Set(['a'])), [])
})

it('hasActiveColocatedLicenseBinding detects the reserved install license', async () => {
  if (!dbUrl) {
    console.warn('Skipping colocated license binding test: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Colocated License Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Colocated Host',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  assertEquals(
    await hasActiveColocatedLicenseBinding(db, organizationId, serverId),
    false,
  )

  const { licenseId } = await createLicense(db, {
    organizationId,
    name: COLOCATED_SERVER_DISPLAY_NAME,
  })
  await db
    .update(license)
    .set({ serverId, updatedAt: now })
    .where(eq(license.id, licenseId))

  assertEquals(
    await hasActiveColocatedLicenseBinding(db, organizationId, serverId),
    true,
  )

  await db
    .update(license)
    .set({ revokedAt: now, updatedAt: now })
    .where(eq(license.id, licenseId))

  assertEquals(
    await hasActiveColocatedLicenseBinding(db, organizationId, serverId),
    false,
  )

  await db.delete(license).where(eq(license.id, licenseId))
  await db.delete(server).where(eq(server.id, serverId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})

it('hasActiveColocatedLicenseBinding ignores non-colocated license display names', async () => {
  if (!dbUrl) return

  const db = createDenoDb()
  const [insertedOrg] = await db
    .insert(organization)
    .values({ name: 'Regular License Org' })
    .returning({ id: organization.id })
  const organizationId = insertedOrg!.id

  const now = new Date().toISOString()
  const [insertedServer] = await db
    .insert(server)
    .values({
      organizationId,
      name: 'Regular Host',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: server.id })
  const serverId = insertedServer!.id

  const { licenseId } = await createLicense(db, {
    organizationId,
    name: 'Production Node',
  })
  await db
    .update(license)
    .set({ serverId, updatedAt: now })
    .where(and(eq(license.id, licenseId)))

  assertEquals(
    await hasActiveColocatedLicenseBinding(db, organizationId, serverId),
    false,
  )

  await db.delete(license).where(eq(license.id, licenseId))
  await db.delete(server).where(eq(server.id, serverId))
  await db.delete(organization).where(eq(organization.id, organizationId))
})
