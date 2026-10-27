/**
 * Paged reads behind Admin > Updates history: one row per run, and one row
 * per server inside a run. Every page is a bounded set of grouped queries
 * (`idx_upgrade_created_at`, `idx_stage_upgrade_server`); nothing here loads
 * every step of a run or the fleet, and nothing writes.
 */
import { and, asc, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm'
import type { DaemonCellRegistry } from '../../contracts/cell.ts'
import type { Db } from '../../db/connection.ts'
import { datacenter, organization, server, stage, upgrade, user } from '../../db/schema.ts'
import { stepDetail, type StepDetail } from './decisions.ts'
import {
  durationMs,
  emptyOutcomeCounts,
  escapeLikePattern,
  isoOrNull,
  outcomeFromRank,
  outcomeRank,
  runTrigger,
  stepOutcome,
  summaryFromOutcomes,
  summaryFromStoredCounts,
  UPGRADE_OUTCOME_FAILED_STATUSES,
  UPGRADE_SERVER_OUTCOMES,
  type HistoryQuery,
  type OutcomeCounts,
  type RunServersQuery,
  type RunServerSort,
  type UpgradeRunServerSummary,
  type UpgradeRunTrigger,
  type UpgradeServerOutcome,
} from './history.ts'
import { readServerSnapshot } from './restart-report.ts'
import { FLEET_CELL_PROBE_BUDGET } from './run.ts'
import { toRun, UPGRADE_RUN_COLUMNS, type UpgradeRunRow } from './store.ts'
import {
  UPGRADE_PHASES,
  UPGRADE_STEP_UNITS,
  type UpgradePhase,
  type UpgradeStepStatus,
  type UpgradeStepUnit,
} from './vocabulary.ts'

export type UpgradeHistoryRun = UpgradeRunRow & {
  trigger: UpgradeRunTrigger
  summary: UpgradeRunServerSummary
  /**
   * The units this run planned steps for (`daemon`, `instance`), in that
   * order. An `instance` step installs the control plane and its web
   * interface together, so a client lists the web interface target only when
   * this holds `instance`. Empty once retention pruned the steps.
   */
  units: UpgradeStepUnit[]
}

export type RunServerComponent = {
  stepId: string
  unit: UpgradeStepUnit
  phase: UpgradePhase
  status: UpgradeStepStatus
  outcome: UpgradeServerOutcome
  fromVersion: string | null
  toVersion: string | null
  fromCommit: string | null
  toCommit: string | null
  attempts: number
  startedAt: string | null
  finishedAt: string | null
  lastStageAt: string | null
  errorCode: string | null
  errorMessage: string | null
  detail: StepDetail
}

export type RunServerRow = {
  serverId: string
  serverName: string | null
  hostname: string | null
  organizationId: string | null
  organizationName: string | null
  datacenterId: string | null
  datacenterName: string | null
  status: UpgradeServerOutcome
  fromVersion: string | null
  toVersion: string | null
  fromCommit: string | null
  toCommit: string | null
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  errorCode: string | null
  errorMessage: string | null
  attempts: number
  connected: boolean
  lastHeartbeatAt: string | null
  components: Partial<Record<UpgradeStepUnit, RunServerComponent>>
}

export type RunStatusCounts = OutcomeCounts & { all: number }

export type RunServersPage = {
  run: UpgradeHistoryRun
  units: UpgradeStepUnit[]
  statusCounts: RunStatusCounts
  organizations: { id: string; name: string | null; servers: number }[]
  servers: RunServerRow[]
  total: number
}

/** Organizations listed for the run's organization filter. */
export const RUN_ORGANIZATION_FACET_LIMIT = 100

const TERMINAL_STEP = sql.raw(`('done', 'skipped', 'failed', 'needs_attention')`)

function quotedList(values: readonly string[]): SQL {
  const quoted = values.map((value) => "'" + value + "'").join(', ')
  return sql.raw('(' + quoted + ')')
}

function rankLiteral(outcome: UpgradeServerOutcome): SQL {
  return sql.raw(String(outcomeRank(outcome)))
}

/**
 * One step's outcome as its rank in `UPGRADE_SERVER_OUTCOMES`, the SQL twin
 * of `stepOutcome`; `min()` over a server's steps is the server's outcome.
 */
export const stepOutcomeRankSql: SQL = sql`case
  when ${stage.status} in ${quotedList(UPGRADE_OUTCOME_FAILED_STATUSES)} then ${rankLiteral('failed')}
  when ${stage.status} = 'skipped' then ${rankLiteral('skipped')}
  when ${stage.status} <> 'done' then ${rankLiteral('in_progress')}
  when ${stage.attempts} > 0 then ${rankLiteral('updated')}
  else ${rankLiteral('already_current')}
end`

const PHASE_RANK_SQL = sql`case ${stage.phase} when 'colocated_daemon' then 0 when 'control_plane' then 1 else 2 end`

function countsFromRanks(rows: readonly { rank: number; total: number }[]): OutcomeCounts {
  const counts = emptyOutcomeCounts()
  for (const row of rows) counts[outcomeFromRank(Number(row.rank))] += Number(row.total)
  return counts
}

/** Server outcome totals for each run id, from one grouped query. */
async function readRunSummaries(
  db: Db,
  runs: readonly UpgradeRunRow[]
): Promise<Map<string, UpgradeRunServerSummary>> {
  const out = new Map<string, UpgradeRunServerSummary>()
  if (runs.length === 0) return out
  const perServer = db
    .select({
      upgradeId: stage.upgradeId,
      rank: sql<number>`min(${stepOutcomeRankSql})`.as('rank'),
    })
    .from(stage)
    .where(
      inArray(
        stage.upgradeId,
        runs.map((run) => run.id)
      )
    )
    .groupBy(stage.upgradeId, stage.serverId)
    .as('per_server')
  const rows = await db
    .select({
      upgradeId: perServer.upgradeId,
      rank: perServer.rank,
      total: sql<number>`count(*)::int`,
    })
    .from(perServer)
    .groupBy(perServer.upgradeId, perServer.rank)
  const byRun = new Map<string, { rank: number; total: number }[]>()
  for (const row of rows) {
    const list = byRun.get(row.upgradeId) ?? []
    list.push(row)
    byRun.set(row.upgradeId, list)
  }
  for (const run of runs) {
    const ranks = byRun.get(run.id)
    out.set(
      run.id,
      ranks ? summaryFromOutcomes(countsFromRanks(ranks)) : summaryFromStoredCounts(run.counts)
    )
  }
  return out
}

/** Which units each run planned, from one grouped query over its steps. */
async function readRunUnits(
  db: Db,
  runs: readonly UpgradeRunRow[]
): Promise<Map<string, UpgradeStepUnit[]>> {
  const out = new Map<string, UpgradeStepUnit[]>()
  if (runs.length === 0) return out
  const rows = await db
    .select({ upgradeId: stage.upgradeId, unit: stage.unit })
    .from(stage)
    .where(
      inArray(
        stage.upgradeId,
        runs.map((run) => run.id)
      )
    )
    .groupBy(stage.upgradeId, stage.unit)
  for (const row of rows) {
    const list = out.get(row.upgradeId) ?? []
    list.push(row.unit as UpgradeStepUnit)
    out.set(row.upgradeId, list)
  }
  for (const list of out.values()) list.sort((a, b) => a.localeCompare(b))
  return out
}

function withSummary(
  run: UpgradeRunRow,
  summaries: Map<string, UpgradeRunServerSummary>,
  units: Map<string, UpgradeStepUnit[]>
): UpgradeHistoryRun {
  return {
    ...run,
    trigger: runTrigger(run.source),
    summary: summaries.get(run.id) ?? summaryFromStoredCounts(run.counts),
    units: units.get(run.id) ?? [],
  }
}

/** One page of runs, newest first, each with its server totals. */
export async function readHistoryPage(
  db: Db,
  query: HistoryQuery
): Promise<{ runs: UpgradeHistoryRun[]; total: number }> {
  const where = and(
    inArray(upgrade.status, [...query.statuses]),
    query.sources ? inArray(upgrade.source, [...query.sources]) : undefined
  )
  const [rows, counted] = await Promise.all([
    db
      .select(UPGRADE_RUN_COLUMNS)
      .from(upgrade)
      .leftJoin(user, eq(user.id, upgrade.startedBy))
      .where(where)
      .orderBy(desc(upgrade.createdAt), desc(upgrade.id))
      .limit(query.limit)
      .offset(query.offset),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(upgrade)
      .where(where),
  ])
  const runs = rows.map(toRun)
  const [summaries, units] = await Promise.all([readRunSummaries(db, runs), readRunUnits(db, runs)])
  return {
    runs: runs.map((run) => withSummary(run, summaries, units)),
    total: counted[0]?.total ?? 0,
  }
}

/** One run with its server totals, without its steps. */
export async function readHistoryRun(db: Db, id: string): Promise<UpgradeHistoryRun | null> {
  const rows = await db
    .select(UPGRADE_RUN_COLUMNS)
    .from(upgrade)
    .leftJoin(user, eq(user.id, upgrade.startedBy))
    .where(eq(upgrade.id, id))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  const run = toRun(row)
  const [summaries, units] = await Promise.all([
    readRunSummaries(db, [run]),
    readRunUnits(db, [run]),
  ])
  return withSummary(run, summaries, units)
}

function perServerSubquery(db: Db, runId: string) {
  return db
    .select({
      serverId: stage.serverId,
      rank: sql<number>`min(${stepOutcomeRankSql})`.as('rank'),
      startedAt: sql<string | null>`min(${stage.startedAt})`.as('started_at'),
      finishedAt: sql<string | null>`case when bool_and(${stage.status} in ${TERMINAL_STEP})
        then max(coalesce(${stage.finishedAt}, ${stage.statusChangedAt})) end`.as('finished_at'),
      attempts: sql<number>`sum(${stage.attempts})::int`.as('attempts'),
      components: sql<unknown>`jsonb_agg(jsonb_build_object(
        'stepId', ${stage.id},
        'unit', ${stage.unit},
        'phase', ${stage.phase},
        'status', ${stage.status},
        'attempts', ${stage.attempts},
        'fromVersion', ${stage.fromVersion},
        'toVersion', ${stage.toVersion},
        'fromCommit', ${stage.fromCommit},
        'toCommit', ${stage.toCommit},
        'startedAt', ${stage.startedAt},
        'finishedAt', case when ${stage.status} in ${TERMINAL_STEP}
          then coalesce(${stage.finishedAt}, ${stage.statusChangedAt}) end,
        'lastStageAt', ${stage.statusChangedAt},
        'errorCode', ${stage.errorCode},
        'errorMessage', ${stage.errorMessage},
        'detail', ${stage.detail}
      ) order by ${PHASE_RANK_SQL}, ${stage.id})`.as('components'),
    })
    .from(stage)
    .where(eq(stage.upgradeId, runId))
    .groupBy(stage.serverId)
    .as('per_server')
}

type PerServer = ReturnType<typeof perServerSubquery>

function serverNameSql(): SQL {
  return sql`lower(coalesce(${server.name}, ${server.hostname}, ${server.id}::text))`
}

function durationSql(per: PerServer): SQL {
  return sql`extract(epoch from (${per.finishedAt} - ${per.startedAt})) * 1000`
}

function sortSql(per: PerServer, sort: RunServerSort): SQL {
  switch (sort) {
    case 'status':
      return sql`${per.rank}`
    case 'organization':
      return sql`lower(${organization.name})`
    case 'server':
      return serverNameSql()
    case 'started':
      return sql`${per.startedAt}`
    case 'finished':
      return sql`${per.finishedAt}`
    case 'duration':
      return durationSql(per)
    case 'attempts':
      return sql`${per.attempts}`
  }
}

function orderBy(per: PerServer, query: RunServersQuery): SQL[] {
  const direction = sql.raw(query.dir === 'desc' ? 'desc' : 'asc')
  return [
    sql`${sortSql(per, query.sort)} ${direction} nulls last`,
    asc(serverNameSql()),
    asc(server.id),
  ]
}

function searchWhere(search: string | null): SQL | undefined {
  if (!search) return undefined
  const contains = `%${escapeLikePattern(search)}%`
  const prefix = `${escapeLikePattern(search.toLowerCase())}%`
  return or(
    ilike(server.name, contains),
    ilike(server.hostname, contains),
    ilike(organization.name, contains),
    sql`${server.id}::text like ${prefix}`,
    sql`${server.organizationId}::text like ${prefix}`
  )
}

function filterWhere(query: RunServersQuery): SQL | undefined {
  return and(
    query.organizationId ? eq(server.organizationId, query.organizationId) : undefined,
    query.serverId ? eq(server.id, query.serverId) : undefined,
    searchWhere(query.search)
  )
}

type ServerPageDbRow = {
  serverId: string
  rank: number
  startedAt: string | null
  finishedAt: string | null
  attempts: number
  components: unknown
  serverName: string | null
  hostname: string | null
  organizationId: string | null
  organizationName: string | null
  datacenterId: string | null
  datacenterName: string | null
  connected: boolean
}

async function readServerRows(
  db: Db,
  per: PerServer,
  query: RunServersQuery
): Promise<ServerPageDbRow[]> {
  const rows = await db
    .select({
      serverId: per.serverId,
      rank: per.rank,
      startedAt: per.startedAt,
      finishedAt: per.finishedAt,
      attempts: per.attempts,
      components: per.components,
      serverName: server.name,
      hostname: server.hostname,
      organizationId: server.organizationId,
      organizationName: organization.name,
      datacenterId: server.preferredDatacenterId,
      datacenterName: datacenter.name,
      connected: server.isConnected,
    })
    .from(per)
    .innerJoin(server, eq(server.id, per.serverId))
    .leftJoin(organization, eq(organization.id, server.organizationId))
    .leftJoin(datacenter, eq(datacenter.id, server.preferredDatacenterId))
    .where(
      and(
        filterWhere(query),
        query.outcome ? sql`${per.rank} = ${outcomeRank(query.outcome)}` : undefined
      )
    )
    .orderBy(...orderBy(per, query))
    .limit(query.limit)
    .offset(query.offset)
  return rows
}

async function readStatusCounts(
  db: Db,
  per: PerServer,
  query: RunServersQuery
): Promise<RunStatusCounts> {
  const rows = await db
    .select({ rank: per.rank, total: sql<number>`count(*)::int` })
    .from(per)
    .innerJoin(server, eq(server.id, per.serverId))
    .leftJoin(organization, eq(organization.id, server.organizationId))
    .where(filterWhere(query))
    .groupBy(per.rank)
  const counts = countsFromRanks(rows)
  const all = UPGRADE_SERVER_OUTCOMES.reduce((sum, outcome) => sum + counts[outcome], 0)
  return { ...counts, all }
}

async function readOrganizationFacet(
  db: Db,
  per: PerServer
): Promise<RunServersPage['organizations']> {
  const rows = await db
    .select({
      id: server.organizationId,
      name: organization.name,
      servers: sql<number>`count(*)::int`,
    })
    .from(per)
    .innerJoin(server, eq(server.id, per.serverId))
    .leftJoin(organization, eq(organization.id, server.organizationId))
    .groupBy(server.organizationId, organization.name)
    .orderBy(sql`lower(${organization.name}) asc nulls last`, asc(server.organizationId))
    .limit(RUN_ORGANIZATION_FACET_LIMIT)
  return rows.flatMap((row) =>
    row.id ? [{ id: row.id, name: row.name, servers: row.servers }] : []
  )
}

async function readUnits(db: Db, runId: string): Promise<UpgradeStepUnit[]> {
  const rows = await db
    .selectDistinct({ unit: stage.unit })
    .from(stage)
    .where(eq(stage.upgradeId, runId))
  const present = new Set(rows.map((row) => row.unit))
  return UPGRADE_STEP_UNITS.filter((unit) => present.has(unit))
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function asUnit(value: unknown): UpgradeStepUnit {
  return value === 'instance' ? 'instance' : 'daemon'
}

function asPhase(value: unknown): UpgradePhase {
  return (UPGRADE_PHASES as readonly unknown[]).includes(value) ? (value as UpgradePhase) : 'fleet'
}

function toComponent(raw: unknown): RunServerComponent {
  const row = record(raw)
  const status = String(row.status) as UpgradeStepStatus
  const attempts = Number(row.attempts) || 0
  return {
    stepId: String(row.stepId),
    unit: asUnit(row.unit),
    phase: asPhase(row.phase),
    status,
    outcome: stepOutcome({ status, attempts }),
    fromVersion: textOrNull(row.fromVersion),
    toVersion: textOrNull(row.toVersion),
    fromCommit: textOrNull(row.fromCommit),
    toCommit: textOrNull(row.toCommit),
    attempts,
    startedAt: isoOrNull(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
    lastStageAt: isoOrNull(row.lastStageAt),
    errorCode: textOrNull(row.errorCode),
    errorMessage: textOrNull(row.errorMessage),
    detail: stepDetail(row.detail),
  }
}

/** The component whose reason the row shows: a failed one first, then any with a reason. */
function reasonComponent(components: readonly RunServerComponent[]): RunServerComponent | null {
  const hasReason = (item: RunServerComponent) => Boolean(item.errorCode || item.errorMessage)
  return (
    components.find((item) => item.outcome === 'failed' && hasReason(item)) ??
    components.find(hasReason) ??
    null
  )
}

function toServerRow(row: ServerPageDbRow, heartbeat: Map<string, string>): RunServerRow {
  const list = Array.isArray(row.components) ? row.components.map(toComponent) : []
  const components: RunServerRow['components'] = {}
  for (const item of list) components[item.unit] ??= item
  const primary = components.daemon ?? components.instance ?? null
  const reason = reasonComponent(list)
  const snapshot = readServerSnapshot(primary?.detail)
  const startedAt = isoOrNull(row.startedAt)
  const finishedAt = isoOrNull(row.finishedAt)
  return {
    serverId: row.serverId,
    serverName: row.serverName ?? snapshot.serverName ?? null,
    hostname: row.hostname ?? snapshot.serverHostname ?? null,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    datacenterId: row.datacenterId,
    datacenterName: row.datacenterName,
    status: outcomeFromRank(Number(row.rank)),
    fromVersion: primary?.fromVersion ?? null,
    toVersion: primary?.toVersion ?? null,
    fromCommit: primary?.fromCommit ?? null,
    toCommit: primary?.toCommit ?? null,
    startedAt,
    finishedAt,
    durationMs: durationMs(startedAt, finishedAt),
    errorCode: reason?.errorCode ?? null,
    errorMessage: reason?.errorMessage ?? null,
    attempts: Number(row.attempts) || 0,
    connected: row.connected === true,
    lastHeartbeatAt: heartbeat.get(row.serverId) ?? null,
    components,
  }
}

/**
 * Last heartbeat for the servers on this page only, from the daemon cell. On
 * Workers every id is one Durable Object call, so at most
 * {@link FLEET_CELL_PROBE_BUDGET} rows are read (the default page fits); the
 * rest, and a failed read, leave the column empty rather than failing the page.
 */
async function readHeartbeats(
  registry: DaemonCellRegistry | null,
  ids: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!registry || ids.length === 0) return out
  try {
    const snapshots = await registry.getSnapshots(ids.slice(0, FLEET_CELL_PROBE_BUDGET))
    for (const [id, snapshot] of snapshots) {
      const seen = isoOrNull(snapshot.lastSeenAt ?? snapshot.lastInboundAt)
      if (seen) out.set(id, seen)
    }
  } catch {
    return out
  }
  return out
}

/** One page of a run's servers with the quick-filter counts, or null when the run does not exist. */
export async function readRunServersPage(
  db: Db,
  registry: DaemonCellRegistry | null,
  runId: string,
  query: RunServersQuery
): Promise<RunServersPage | null> {
  const run = await readHistoryRun(db, runId)
  if (!run) return null
  const per = perServerSubquery(db, runId)
  const [rows, statusCounts, organizations, units] = await Promise.all([
    readServerRows(db, per, query),
    readStatusCounts(db, per, query),
    readOrganizationFacet(db, per),
    readUnits(db, runId),
  ])
  const heartbeat = await readHeartbeats(
    registry,
    rows.map((row) => row.serverId)
  )
  return {
    run,
    units,
    statusCounts,
    organizations,
    servers: rows.map((row) => toServerRow(row, heartbeat)),
    total: query.outcome ? statusCounts[query.outcome] : statusCounts.all,
  }
}
