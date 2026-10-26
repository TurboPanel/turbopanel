/**
 * Real-Postgres coverage for removing the Let's Encrypt entries made for
 * sites: the project delete plan lists them, an environment delete and a
 * project delete remove the ones nothing else uses, and a shared, uploaded or
 * hand-added certificate stays.
 */

import { skipWithoutDatabase } from '../../test-fixtures/require-service.test.support.ts'
import { assertEquals } from '@std/assert'
import { eq, inArray } from 'drizzle-orm'
import { createDenoDb } from '../../db/connection.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import {
  audit,
  environment,
  hosting,
  organization,
  project,
  service,
  tls,
  workspace,
} from '../../db/schema.ts'
import { buildDeletePlan } from '../projects/delete-plan.ts'
import { deleteEnvironmentCascade, deleteProjectCascade } from '../projects/project-delete.ts'
import { lockOrganizationLetsEncrypt } from './unused-letsencrypt.ts'

const dbUrl = getDatabaseUrl()

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type TestDb = ReturnType<typeof createDenoDb>

async function addEnvironment(db: TestDb, projectId: string, name: string, isPrimary: boolean) {
  const [env] = await db
    .insert(environment)
    .values({ projectId, name, isPrimary })
    .returning({ id: environment.id })
  const [svc] = await db
    .insert(service)
    .values({ environmentId: env!.id, name: 'web', composeServiceName: 'web' })
    .returning({ id: service.id })
  return { environmentId: env!.id, serviceId: svc!.id }
}

async function addSite(db: TestDb, serviceId: string, tlsId: string, name: string) {
  await db.insert(hosting).values({ serviceId, name, tlsId, options: { hostnames: [name] } })
}

type CertificateKind = 'site' | 'library' | 'legacy' | 'upload'

/** The marker each kind carries: `legacy` is an entry made before the marker existed. */
const MARKER_BY_KIND: Record<CertificateKind, Record<string, unknown>> = {
  site: { acme: { createdFor: 'hosting' } },
  library: { acme: { createdFor: 'library' } },
  legacy: {},
  upload: {},
}

async function addCertificate(
  db: TestDb,
  organizationId: string,
  name: string,
  kind: CertificateKind
) {
  const [row] = await db
    .insert(tls)
    .values({
      organizationId,
      source: kind === 'upload' ? 'upload' : 'lets_encrypt',
      status: kind === 'upload' ? 'ready' : 'automatic',
      metadata: {
        dnsNames: [name],
        ...MARKER_BY_KIND[kind],
      },
    })
    .returning({ id: tls.id })
  return row!.id
}

async function world(db: TestDb) {
  const [org] = await db
    .insert(organization)
    .values({ name: 'Unused Lets Encrypt Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const [ws] = await db
    .insert(workspace)
    .values({ organizationId, name: 'WS' })
    .returning({ id: workspace.id })
  const newProject = async (name: string) => {
    const [row] = await db
      .insert(project)
      .values({ workspaceId: ws!.id, organizationId, name })
      .returning({ id: project.id })
    return row!.id
  }
  const projectA = await newProject('A')
  const projectB = await newProject('B')
  const a1 = await addEnvironment(db, projectA, 'production', true)
  const a2 = await addEnvironment(db, projectA, 'staging', false)
  const b1 = await addEnvironment(db, projectB, 'production', true)
  const certs = {
    own: await addCertificate(db, organizationId, 'own.example.com', 'site'),
    shared: await addCertificate(db, organizationId, 'shared.example.com', 'site'),
    staging: await addCertificate(db, organizationId, 'staging.example.com', 'site'),
    library: await addCertificate(db, organizationId, 'library.example.com', 'library'),
    legacy: await addCertificate(db, organizationId, 'legacy.example.com', 'legacy'),
    uploaded: await addCertificate(db, organizationId, 'uploaded.example.com', 'upload'),
  }
  await addSite(db, a1.serviceId, certs.own, 'own.example.com')
  await addSite(db, a1.serviceId, certs.shared, 'shared.example.com')
  await addSite(db, b1.serviceId, certs.shared, 'shared.example.com')
  await addSite(db, a1.serviceId, certs.library, 'library.example.com')
  await addSite(db, a1.serviceId, certs.legacy, 'legacy.example.com')
  await addSite(db, a1.serviceId, certs.uploaded, 'uploaded.example.com')
  await addSite(db, a2.serviceId, certs.staging, 'staging.example.com')
  const remaining = async () =>
    (
      await db
        .select({ id: tls.id })
        .from(tls)
        .where(inArray(tls.id, Object.values(certs)))
    )
      .map((row) => row.id)
      .sort((a, b) => a.localeCompare(b))
  return {
    organizationId,
    projectA,
    a1,
    a2,
    b1,
    certs,
    remaining,
    async cleanup() {
      const envIds = [a1.environmentId, a2.environmentId, b1.environmentId]
      const services = await db
        .select({ id: service.id })
        .from(service)
        .where(inArray(service.environmentId, envIds))
      const serviceIds = services.map((row) => row.id)
      if (serviceIds.length > 0) {
        await db.delete(hosting).where(inArray(hosting.serviceId, serviceIds))
        await db.delete(service).where(inArray(service.id, serviceIds))
      }
      await db.delete(environment).where(inArray(environment.id, envIds))
      await db.delete(project).where(inArray(project.id, [projectA, projectB]))
      await db.delete(workspace).where(eq(workspace.id, ws!.id))
      await db.delete(audit).where(eq(audit.organizationId, organizationId))
      await db.delete(tls).where(eq(tls.organizationId, organizationId))
      await db.delete(organization).where(eq(organization.id, organizationId))
    },
  }
}

const sorted = (ids: string[]) => [...ids].sort((a, b) => a.localeCompare(b))

test("the project delete plan lists the Let's Encrypt entries it removes and keeps", async () => {
  if (!dbUrl) return skipWithoutDatabase('unused Lets Encrypt entry tests')
  const db = createDenoDb()
  const w = await world(db)
  try {
    const plan = await buildDeletePlan(db, {
      projectId: w.projectA,
      environmentIds: [w.a1.environmentId, w.a2.environmentId],
      stopServerIds: [],
    })
    assertEquals(plan.certificates, [
      { id: w.certs.own, names: ['own.example.com'], action: 'remove' },
      { id: w.certs.shared, names: ['shared.example.com'], action: 'keep', otherSites: 1 },
      { id: w.certs.staging, names: ['staging.example.com'], action: 'remove' },
    ])
    const envPlan = await buildDeletePlan(db, {
      environmentIds: [w.a2.environmentId],
      stopServerIds: [],
    })
    assertEquals(
      envPlan.certificates.map((row) => [row.id, row.action]),
      [[w.certs.staging, 'remove']]
    )
  } finally {
    await w.cleanup()
  }
})

test('an environment delete and a project delete remove only the entries nothing else uses', async () => {
  if (!dbUrl) return skipWithoutDatabase('unused Lets Encrypt entry tests')
  const db = createDenoDb()
  const w = await world(db)
  try {
    const envResult = await deleteEnvironmentCascade(db, w.a2.environmentId)
    assertEquals(envResult.ok, true)
    assertEquals(
      await w.remaining(),
      sorted([w.certs.own, w.certs.shared, w.certs.library, w.certs.legacy, w.certs.uploaded])
    )

    const projectResult = await deleteProjectCascade(db, w.projectA)
    assertEquals(projectResult.ok, true)
    assertEquals(
      await w.remaining(),
      sorted([w.certs.shared, w.certs.library, w.certs.legacy, w.certs.uploaded]),
      'the shared entry, the hand-added one, one made before the marker and the uploaded one stay'
    )
    const trail = await db
      .select({ targetId: audit.targetId })
      .from(audit)
      .where(eq(audit.action, 'tls.certificate.delete'))
    const removed = trail.flatMap((row) =>
      row.targetId === w.certs.own || row.targetId === w.certs.staging ? [row.targetId] : []
    )
    assertEquals(sorted(removed), sorted([w.certs.own, w.certs.staging]))
  } finally {
    await w.cleanup()
  }
})

test('a project delete waits for a site being pinned elsewhere, and keeps the entry', async () => {
  if (!dbUrl) return skipWithoutDatabase('unused Lets Encrypt entry tests')
  const db = createDenoDb()
  const w = await world(db)
  try {
    let deleting: ReturnType<typeof deleteProjectCascade> | undefined
    // A deploy's order in another project: its environment row, the
    // organization's Let's Encrypt lock, then the pin, committed a moment later.
    await db.transaction(async (tx) => {
      await tx
        .select({ id: environment.id })
        .from(environment)
        .where(eq(environment.id, w.b1.environmentId))
        .for('update')
      await lockOrganizationLetsEncrypt(tx, w.organizationId)
      await tx.insert(hosting).values({
        serviceId: w.b1.serviceId,
        name: 'own.example.com',
        tlsId: w.certs.own,
        options: { hostnames: ['own.example.com'] },
      })
      deleting = deleteProjectCascade(db, w.projectA)
      await new Promise((resolve) => setTimeout(resolve, 300))
    })
    assertEquals((await deleting!).ok, true)
    assertEquals(
      (await w.remaining()).includes(w.certs.own),
      true,
      'the site pinned meanwhile keeps it'
    )
  } finally {
    await w.cleanup()
  }
})
