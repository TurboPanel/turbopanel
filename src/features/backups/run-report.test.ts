/**
 * `backup-run-report` against a real database: the run is written once, the
 * artifact is recorded with its policy, pruning touches only this policy's
 * records of this target (an engine's `backup` rows, a storage copy's
 * `archive` rows), and a refused report writes nothing. Skips without
 * TURBOPANEL_DATABASE_URL.
 */

import { assertEquals } from '@std/assert'
import { and, eq, inArray } from 'drizzle-orm'
import { createDenoDb, endDbConnection } from '../../db/connection.ts'
import {
  backup,
  retention,
  snapshot,
  environment,
  managed,
  organization,
  project,
  server,
  storage,
  storageCopy,
  archive,
  workspace,
} from '../../db/schema.ts'
import { getDatabaseUrl } from '../../db/url.ts'
import type { BackupRunReportMessage } from '../../contracts/cell-protocol.ts'
import { createBackupRunReportStore, handleBackupRunReport } from './run-report.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const dbUrl = getDatabaseUrl()

type Db = ReturnType<typeof createDenoDb>

type Fixture = {
  db: Db
  organizationId: string
  serverA: string
  serverB: string
  managedId: string
  otherManagedId: string
  policyId: string
}

async function insertServer(db: Db, organizationId: string, name: string): Promise<string> {
  const now = new Date().toISOString()
  const [row] = await db
    .insert(server)
    .values({ organizationId, name, createdAt: now, updatedAt: now, statusChangedAt: now })
    .returning({ id: server.id })
  return row!.id
}

async function insertManaged(
  db: Db,
  organizationId: string,
  workspaceId: string,
  serverId: string
): Promise<string> {
  const [proj] = await db
    .insert(project)
    .values({ name: `Backup Report ${crypto.randomUUID()}`, workspaceId, organizationId })
    .returning({ id: project.id })
  const [env] = await db
    .insert(environment)
    .values({ name: 'Production', projectId: proj!.id, serverId })
    .returning({ id: environment.id })
  const [row] = await db
    .insert(managed)
    .values({ environmentId: env!.id, serverId, name: 'Postgres', engine: 'postgres' })
    .returning({ id: managed.id })
  return row!.id
}

/** Children first: `managed.server_id` and `server.organization_id` both restrict. */
async function removeFixture(db: Db, organizationId: string, managedIds: string[]): Promise<void> {
  if (managedIds.length > 0) await db.delete(managed).where(inArray(managed.id, managedIds))
  // Copies (and their policies and volume backups) cascade with their storage.
  await db.delete(storage).where(eq(storage.organizationId, organizationId))
  const projects = await db
    .select({ id: project.id })
    .from(project)
    .where(eq(project.organizationId, organizationId))
  const projectIds = projects.map((row) => row.id)
  if (projectIds.length > 0) {
    await db.delete(environment).where(inArray(environment.projectId, projectIds))
    await db.delete(project).where(inArray(project.id, projectIds))
  }
  await db.delete(workspace).where(eq(workspace.organizationId, organizationId))
  await db.delete(server).where(eq(server.organizationId, organizationId))
  await db.delete(organization).where(eq(organization.id, organizationId))
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping backup run report tests: TURBOPANEL_DATABASE_URL not set')
    return
  }
  const db = createDenoDb()
  const [org] = await db
    .insert(organization)
    .values({ name: 'Backup Report Test Org' })
    .returning({ id: organization.id })
  const organizationId = org!.id
  const managedIds: string[] = []
  try {
    const [ws] = await db
      .insert(workspace)
      .values({ name: 'Backup Report Workspace', organizationId })
      .returning({ id: workspace.id })
    const serverA = await insertServer(db, organizationId, 'Backup Report Server A')
    const serverB = await insertServer(db, organizationId, 'Backup Report Server B')
    const managedId = await insertManaged(db, organizationId, ws!.id, serverA)
    managedIds.push(managedId)
    const otherManagedId = await insertManaged(db, organizationId, ws!.id, serverA)
    managedIds.push(otherManagedId)
    const [policy] = await db
      .insert(retention)
      .values({
        organizationId,
        targetKind: 'managed',
        managedId,
        name: 'Nightly',
        schedule: '@daily',
        retentionKeep: 7,
        updatedAt: '2026-09-01T00:00:00.000Z',
      })
      .returning({ id: retention.id })
    await fn({
      db,
      organizationId,
      serverA,
      serverB,
      managedId,
      otherManagedId,
      policyId: policy!.id,
    })
  } finally {
    await removeFixture(db, organizationId, managedIds)
    await endDbConnection(db)
  }
}

function succeededReport(
  fixture: Fixture,
  overrides: Partial<BackupRunReportMessage> = {}
): BackupRunReportMessage {
  const backupId = overrides.backupId ?? 'bk_new'
  return {
    type: 'backup-run-report',
    id: 'run_one',
    policyId: fixture.policyId,
    runId: 'run_one',
    startedAt: '2026-09-30T03:00:00.000Z',
    finishedAt: '2026-09-30T03:00:05.000Z',
    status: 'succeeded',
    backupId,
    sizeBytes: 2048,
    checksum: 'b'.repeat(64),
    path: `/backup/${fixture.managedId}/policy-${fixture.policyId}/${backupId}.dump`,
    nextRunAt: '2026-10-01T03:00:00.000Z',
    at: '2026-09-30T03:00:06.000Z',
    ...overrides,
  }
}

function insertBackupRow(
  db: Db,
  values: { managedId: string; backupId: string; retentionId: string | null }
): Promise<unknown> {
  return db.insert(backup).values({
    ...values,
    sizeBytes: 1,
    checksum: 'c'.repeat(64),
    path: `/backup/${values.backupId}.dump`,
  })
}

test('a believed report records the run, the artifact and the next run, once', async () => {
  await withFixture(async (fixture) => {
    const store = createBackupRunReportStore(fixture.db)
    const report = succeededReport(fixture)
    const options = { reporterServerId: fixture.serverA }

    assertEquals(await handleBackupRunReport(store, report, options), { ok: true })
    assertEquals(await handleBackupRunReport(store, report, options), { ok: true })

    const runs = await fixture.db
      .select({ status: snapshot.status, backupRef: snapshot.backupRef })
      .from(snapshot)
      .where(eq(snapshot.retentionId, fixture.policyId))
    assertEquals(runs, [{ status: 'succeeded', backupRef: 'bk_new' }])

    const artifacts = await fixture.db
      .select({ backupId: backup.backupId, policyId: backup.retentionId })
      .from(backup)
      .where(eq(backup.managedId, fixture.managedId))
    assertEquals(artifacts, [{ backupId: 'bk_new', policyId: fixture.policyId }])

    const [policy] = await fixture.db
      .select({ nextRunAt: retention.nextRunAt, updatedAt: retention.updatedAt })
      .from(retention)
      .where(eq(retention.id, fixture.policyId))
    assertEquals(Date.parse(policy!.nextRunAt!), Date.parse('2026-10-01T03:00:00.000Z'))
    assertEquals(Date.parse(policy!.updatedAt), Date.parse('2026-09-01T00:00:00.000Z'))
  })
})

test('pruning deletes only this policy’s records of this engine', async () => {
  await withFixture(async (fixture) => {
    await insertBackupRow(fixture.db, {
      managedId: fixture.managedId,
      backupId: 'bk_old',
      retentionId: fixture.policyId,
    })
    await insertBackupRow(fixture.db, {
      managedId: fixture.managedId,
      backupId: 'bk_manual',
      retentionId: null,
    })
    await insertBackupRow(fixture.db, {
      managedId: fixture.otherManagedId,
      backupId: 'bk_old',
      retentionId: null,
    })

    const outcome = await handleBackupRunReport(
      createBackupRunReportStore(fixture.db),
      succeededReport(fixture, { pruned: ['bk_old', 'bk_manual'] }),
      { reporterServerId: fixture.serverA }
    )
    assertEquals(outcome, { ok: true })

    const mine = await fixture.db
      .select({ backupId: backup.backupId })
      .from(backup)
      .where(eq(backup.managedId, fixture.managedId))
      .orderBy(backup.backupId)
    assertEquals(
      mine.map((row) => row.backupId),
      ['bk_manual', 'bk_new']
    )
    const others = await fixture.db
      .select({ backupId: backup.backupId })
      .from(backup)
      .where(and(eq(backup.managedId, fixture.otherManagedId), eq(backup.backupId, 'bk_old')))
    assertEquals(others.length, 1)
  })
})

test('a report from another server writes nothing', async () => {
  await withFixture(async (fixture) => {
    const outcome = await handleBackupRunReport(
      createBackupRunReportStore(fixture.db),
      succeededReport(fixture),
      { reporterServerId: fixture.serverB }
    )
    assertEquals(outcome.ok, false)
    const runs = await fixture.db
      .select({ id: snapshot.id })
      .from(snapshot)
      .where(eq(snapshot.retentionId, fixture.policyId))
    assertEquals(runs.length, 0)
    const artifacts = await fixture.db
      .select({ id: backup.id })
      .from(backup)
      .where(eq(backup.managedId, fixture.managedId))
    assertEquals(artifacts.length, 0)
  })
})

/** A docker copy of a volume storage on `serverId`, with one policy; returns both ids. */
async function insertCopyPolicy(
  fixture: Fixture,
  serverId: string
): Promise<{ copyId: string; policyId: string }> {
  const [store] = await fixture.db
    .insert(storage)
    .values({ organizationId: fixture.organizationId, kind: 'volume', name: 'uploads' })
    .returning({ id: storage.id })
  const [copy] = await fixture.db
    .insert(storageCopy)
    .values({ storageId: store!.id, serverId, provider: 'docker' })
    .returning({ id: storageCopy.id })
  const [policy] = await fixture.db
    .insert(retention)
    .values({
      organizationId: fixture.organizationId,
      targetKind: 'copy',
      copyId: copy!.id,
      name: 'Hourly',
      schedule: '@hourly',
      retentionKeep: 24,
    })
    .returning({ id: retention.id })
  return { copyId: copy!.id, policyId: policy!.id }
}

function insertArchiveRow(
  db: Db,
  values: { copyId: string; backupId: string; retentionId: string | null }
): Promise<unknown> {
  return db.insert(archive).values({
    ...values,
    sizeBytes: 1,
    checksum: 'c'.repeat(64),
    path: `/backup/copies/${values.copyId}/${values.backupId}.tar.gz`,
  })
}

test('a storage-copy report records an archive and prunes only that policy’s rows', async () => {
  await withFixture(async (fixture) => {
    const { copyId, policyId } = await insertCopyPolicy(fixture, fixture.serverA)
    await insertArchiveRow(fixture.db, { copyId, backupId: 'bk_old', retentionId: policyId })
    await insertArchiveRow(fixture.db, { copyId, backupId: 'bk_manual', retentionId: null })

    const outcome = await handleBackupRunReport(
      createBackupRunReportStore(fixture.db),
      succeededReport(fixture, {
        policyId,
        path: `/backup/copies/${copyId}/policy-${policyId}/bk_new.tar.gz`,
        pruned: ['bk_old', 'bk_manual'],
      }),
      { reporterServerId: fixture.serverA }
    )
    assertEquals(outcome, { ok: true })

    const rows = await fixture.db
      .select({ backupId: archive.backupId, policyId: archive.retentionId })
      .from(archive)
      .where(eq(archive.copyId, copyId))
      .orderBy(archive.backupId)
    assertEquals(rows, [
      { backupId: 'bk_manual', policyId: null },
      { backupId: 'bk_new', policyId },
    ])
    const managedArtifacts = await fixture.db
      .select({ id: backup.id })
      .from(backup)
      .where(eq(backup.managedId, fixture.managedId))
    assertEquals(managedArtifacts.length, 0)
  })
})

test('a storage-copy report from a server the copy is not on writes nothing', async () => {
  await withFixture(async (fixture) => {
    const { copyId, policyId } = await insertCopyPolicy(fixture, fixture.serverA)
    const outcome = await handleBackupRunReport(
      createBackupRunReportStore(fixture.db),
      succeededReport(fixture, {
        policyId,
        path: `/backup/copies/${copyId}/policy-${policyId}/bk_new.tar.gz`,
      }),
      { reporterServerId: fixture.serverB }
    )
    assertEquals(outcome.ok, false)
    const rows = await fixture.db
      .select({ id: archive.id })
      .from(archive)
      .where(eq(archive.copyId, copyId))
    assertEquals(rows.length, 0)
  })
})
