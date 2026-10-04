/**
 * Host-affecting managed-database checks. Each creates its own cluster,
 * named with the run prefix, on themisto or megaclite only (the first such
 * `--host`), and destroys it in cleanup. The shared managed Postgres on
 * adrastea/kore is never a placement and never read.
 */
import type { Check, CheckContext } from '../types.ts'
import { createProject, createWorkspace, managedServer } from './fixtures.ts'
import {
  excerpt,
  expectStatus,
  fail,
  listOf,
  objOf,
  pass,
  pollUntil,
  skip,
  str,
  type Rec,
} from './helpers.ts'

const V1 = '/client/v1'
const NO_HOST = 'needs --host themisto or --host megaclite'

export interface Cluster {
  environmentId: string
  server: Rec
  createBody: Rec
  base: string
}

/** Create a managed cluster and wait for `ready`; destroy is registered first. */
export async function createCluster(
  ctx: CheckContext,
  code: string,
  label: string
): Promise<Cluster | undefined> {
  const server = await managedServer(ctx)
  if (!server) return undefined
  const workspaceId = await createWorkspace(ctx, label)
  const ref = await createProject(ctx, {
    workspaceId,
    type: 'managed',
    code,
    name: `${ctx.prefix}-${label}`,
    serverId: str(server, 'id'),
  })
  const base = `${V1}/environments/${ref.environmentId}/managed`
  ctx.defer(`managed ${label}`, () => destroyCluster(ctx, base))
  const res = await ctx.api.post(base, { body: { name: `${label}`.replaceAll('-', '') } })
  expectStatus(res, `create ${code}`)
  const ready = await waitStatus(ctx, base, ['ready', 'failed'], 90)
  if (ready !== 'ready') throw new Error(`${code} cluster reached "${ready}" instead of ready`)
  return { environmentId: ref.environmentId, server, createBody: objOf(res.body), base }
}

export async function managedStatus(ctx: CheckContext, base: string): Promise<string> {
  const res = await ctx.api.get(base)
  if (res.status === 404) return 'gone'
  const body = objOf(res.body)
  if (body.managed === null || body.managed === undefined) return 'gone'
  return str(objOf(body, 'managed'), 'status')
}

export async function waitStatus(
  ctx: CheckContext,
  base: string,
  wanted: string[],
  tries: number
): Promise<string> {
  let last = ''
  const hit = await pollUntil(
    ctx,
    async () => {
      last = await managedStatus(ctx, base)
      return wanted.includes(last) ? last : undefined
    },
    tries,
    10_000
  )
  return hit ?? `timeout (last ${last})`
}

export async function destroyCluster(ctx: CheckContext, base: string): Promise<void> {
  if ((await managedStatus(ctx, base)) === 'gone') return
  const busy = await pollUntil(
    ctx,
    async () => {
      const res = await ctx.api.del(base)
      if (res.status === 409) return undefined
      expectStatus(res, 'destroy managed', 200, 202, 204, 404)
      return true
    },
    30,
    10_000
  )
  if (!busy) throw new Error('managed cluster stayed busy; not destroyed')
  const gone = await waitStatus(ctx, base, ['gone'], 60)
  if (gone !== 'gone') throw new Error(`managed cluster not gone after destroy (${gone})`)
}

function engineCheck(rowId: string, title: string, code: string): Check {
  return {
    rowId,
    title,
    requires: ['api'],
    safety: 'host-affecting',
    async run(ctx) {
      const cluster = await createCluster(ctx, code, code.slice(0, 5))
      if (!cluster) return skip(NO_HOST)
      const shownOnce = str(cluster.createBody, 'rootPassword').length > 0
      const after = await ctx.api.get(cluster.base)
      const leaks = /rootPassword"\s*:\s*"[^"]/.test(JSON.stringify(after.body))
      const conn = objOf(after.body, 'connection')
      const evidence = `${code} on ${str(cluster.server, 'hostname')}: ready; root password in create response: ${shownOnce}; GET returns it again: ${leaks}; connection host ${str(conn, 'host') || '?'} port ${str(conn, 'port') || '?'} (client connect not automated)`
      return shownOnce && !leaks ? pass(evidence) : fail(evidence)
    },
  }
}

export const managedPgSingle = engineCheck(
  'managed-pg-single',
  'Create a single-node Postgres',
  'postgres'
)
export const managedMysql = engineCheck('managed-mysql', 'MySQL: create', 'mysql')
export const managedMariadb = engineCheck('managed-mariadb', 'MariaDB: create', 'mariadb')

export const managedPgUsers: Check = {
  rowId: 'managed-pg-users',
  title: 'Users and databases',
  requires: ['api'],
  safety: 'host-affecting',
  async run(ctx) {
    const cluster = await createCluster(ctx, 'postgres', 'pgusr')
    if (!cluster) return skip(NO_HOST)
    const db = `clr_${ctx.prefix.slice(4).replaceAll('-', '')}`
    const dbRes = await ctx.api.post(`${cluster.base}/databases`, { body: { name: db } })
    const userRes = await ctx.api.post(`${cluster.base}/users`, {
      body: { username: `${db}_u`, databases: [db], privileges: ['owner'] },
    })
    const user = objOf(objOf(userRes.body), 'user')
    const listed = listOf((await ctx.api.get(`${cluster.base}/users`)).body, 'users')
    const userDel = await ctx.api.del(`${cluster.base}/users/${str(user, 'id')}`)
    const dbDel = await ctx.api.del(`${cluster.base}/databases/${db}`)
    const evidence = `database create ${dbRes.status}, user create ${userRes.status} (password returned: ${str(objOf(userRes.body), 'password').length > 0}), users listed ${listed.length}, user delete ${userDel.status}, database delete ${dbDel.status} ${excerpt(dbDel.body, 80)}`
    const ok = [dbRes, userRes, userDel, dbDel].every((r) => r.status < 300)
    return ok ? pass(evidence) : fail(evidence)
  },
}

export const managedLogs: Check = {
  rowId: 'managed-logs',
  title: 'Managed logs tail',
  requires: ['api'],
  safety: 'host-affecting',
  async run(ctx) {
    const cluster = await createCluster(ctx, 'postgres', 'pglog')
    if (!cluster) return skip(NO_HOST)
    const res = await ctx.api.get(`${cluster.base}/logs?tail=50`)
    const logs = str(objOf(res.body), 'logs')
    const evidence = `GET managed/logs?tail=50 -> ${res.status}, ${logs.split('\n').filter(Boolean).length} lines`
    return res.status === 200 && logs.length > 0 ? pass(evidence) : fail(evidence)
  },
}

async function lifecycle(
  ctx: CheckContext,
  base: string,
  action: string,
  wanted: string[]
): Promise<string> {
  const res = await ctx.api.post(`${base}/lifecycle`, { body: { action } })
  if (res.status >= 300) return `${action} HTTP ${res.status}`
  return waitStatus(ctx, base, wanted, 30)
}

export const managedLifecycle: Check = {
  rowId: 'managed-lifecycle',
  title: 'Stop, start, destroy',
  requires: ['api'],
  safety: 'host-affecting',
  async run(ctx) {
    const cluster = await createCluster(ctx, 'postgres', 'pglc')
    if (!cluster) return skip(NO_HOST)
    const stopped = await lifecycle(ctx, cluster.base, 'stop', ['stopped', 'failed'])
    const started = await lifecycle(ctx, cluster.base, 'start', ['ready', 'failed'])
    await destroyCluster(ctx, cluster.base)
    const gone = await managedStatus(ctx, cluster.base)
    const evidence = `stop -> ${stopped}, start -> ${started}, destroy -> ${gone}`
    return stopped === 'stopped' && started === 'ready' && gone === 'gone'
      ? pass(evidence)
      : fail(evidence)
  },
}

/** Poll a backups list until one backup reaches a terminal status. */
export async function waitBackup(
  ctx: CheckContext,
  listPath: string,
  backupId: string
): Promise<string> {
  const hit = await pollUntil(
    ctx,
    async () => {
      const list = listOf((await ctx.api.get(listPath)).body, 'backups')
      const status = str(
        list.find((b) => str(b, 'id') === backupId),
        'status'
      )
      return ['succeeded', 'failed', 'completed', 'error'].includes(status) ? status : undefined
    },
    40,
    10_000
  )
  return hit ?? 'timeout'
}

/** Wait for the policy's own timer to record a run (no control-plane trigger). */
export async function waitScheduledRun(
  ctx: CheckContext,
  runsPath: string,
  minutes: number
): Promise<Rec | undefined> {
  return pollUntil(
    ctx,
    async () => listOf((await ctx.api.get(runsPath)).body, 'runs')[0],
    minutes * 4,
    15_000
  )
}

export const backupsScheduleManaged: Check = {
  rowId: 'backups-schedule-managed',
  title: 'Schedule a managed-database backup on an interval',
  requires: ['api'],
  safety: 'host-affecting',
  async run(ctx) {
    const cluster = await createCluster(ctx, 'postgres', 'pgbk')
    if (!cluster) return skip(NO_HOST)
    const policies = `${cluster.base}/backup-policies`
    const created = await ctx.api.post(policies, {
      body: {
        name: `${ctx.prefix}-bk`,
        schedule: '*/2 * * * *',
        retentionKeep: 2,
        timezone: 'UTC',
      },
    })
    expectStatus(created, 'create backup policy')
    const policyId = str(objOf(objOf(created.body), 'policy'), 'id')
    ctx.defer('backup policy', async () => {
      expectStatus(await ctx.api.del(`${policies}/${policyId}`), 'delete policy', 200, 204, 404)
    })
    const manual = await ctx.api.post(`${cluster.base}/backups`, { body: {} })
    const manualStatus = await waitBackup(
      ctx,
      `${cluster.base}/backups`,
      str(objOf(manual.body), 'backupId')
    )
    const run = await waitScheduledRun(ctx, `${policies}/${policyId}/runs`, 8)
    const evidence = `policy ${created.status} (*/2 cron, keep 2); manual backup ${manualStatus}; scheduled run ${run ? `${str(run, 'status')} at ${str(run, 'startedAt', 'createdAt')}` : 'none within 8 min'}`
    const ok = ['succeeded', 'completed'].includes(manualStatus) && run !== undefined
    return ok ? pass(evidence) : fail(evidence)
  },
}

export const MANAGED_CHECKS: readonly Check[] = [
  managedPgSingle,
  managedMysql,
  managedMariadb,
  managedPgUsers,
  managedLogs,
  managedLifecycle,
  backupsScheduleManaged,
]
