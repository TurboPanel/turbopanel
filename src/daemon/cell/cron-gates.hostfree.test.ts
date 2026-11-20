import { assertEquals } from '@std/assert'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { Db } from '../../db/connection.ts'
import {
  ALL_GATES_OPEN,
  CRON_CADENCES,
  type CronCadenceTable,
  type CronJob,
  isDue,
  loadCronGates,
  onDivisor,
} from './cron-gates.ts'

/** Jest/Mocha-shaped alias so Sonar typescript:S2187 sees real tests. */
const test = Deno.test.bind(Deno)

const DAY_START = Date.parse('2026-01-01T00:00:00.000Z')
const minuteAt = (minute: number) => DAY_START + minute * 60_000

/** The minutes of an hour, 0..59, on which `due` is true. */
function dueMinutes(due: (ms: number) => boolean): number[] {
  return Array.from({ length: 60 }, (_, minute) => minute).filter((minute) => due(minuteAt(minute)))
}

test('onDivisor runs on its minute and skips every other', () => {
  assertEquals(
    dueMinutes((ms) => onDivisor(ms, 15, 3)),
    [3, 18, 33, 48]
  )
  assertEquals(
    dueMinutes((ms) => onDivisor(ms, 5, 2)),
    [2, 7, 12, 17, 22, 27, 32, 37, 42, 47, 52, 57]
  )
  assertEquals(
    dueMinutes((ms) => onDivisor(ms, 60)),
    [0]
  )
})

test('an offset larger than the interval wraps instead of never firing', () => {
  assertEquals(
    dueMinutes((ms) => onDivisor(ms, 15, 18)),
    [3, 18, 33, 48]
  )
})

test('each job in the table fires once per window, on its own minute', () => {
  for (const [name, cadence] of Object.entries(CRON_CADENCES)) {
    const fired = dueMinutes((ms) => isDue(name as CronJob, ms))
    assertEquals(fired.length, 60 / cadence.everyMinutes, name)
    for (const minute of fired) assertEquals(minute % cadence.everyMinutes, cadence.offset, name)
  }
})

test('the retention deletes sit on distinct minutes and off the 15 minute prune family', () => {
  const retention = [
    CRON_CADENCES.commandDispatchCleanup,
    CRON_CADENCES.webhookDeliveries,
    CRON_CADENCES.daemonNonces,
  ]
  const offsets: number[] = retention.map((cadence) => cadence.offset)
  assertEquals(new Set(offsets).size, retention.length)
  // The prune family (notification prune, execution logs, upgrade history) is on minute 0.
  assertEquals(offsets.includes(0), false)
})

test('the five repair sweeps behind the connected-server gate sit on five distinct minutes of the window', () => {
  const repair: CronJob[] = [
    'systemReconcile',
    'backupsReconcile',
    'folderRemoval',
    'folderReconcile',
    'firewallPreview',
  ]
  // Over one 5 minute window each minute has exactly one of the five due.
  const dueIn = (minute: number) => repair.filter((job) => isDue(job, minuteAt(minute)))
  for (const minute of [0, 1, 2, 3, 4]) assertEquals(dueIn(minute).length, 1, `minute ${minute}`)
  assertEquals(new Set(repair.flatMap((_, i) => dueIn(i))).size, repair.length)
})

test('the ingress orphan pass has its own key, apart from system reconcile', () => {
  assertEquals('managedIngressOrphan' in CRON_CADENCES, true)
  assertEquals(CRON_CADENCES.managedIngressOrphan.everyMinutes, 5)
})

test('a tick with no scheduled time runs every job, as before', () => {
  for (const job of Object.keys(CRON_CADENCES)) assertEquals(isDue(job as CronJob, undefined), true)
})

test('isDue reads the table it is given, so overrides can be merged in', () => {
  const table: CronCadenceTable = {
    ...CRON_CADENCES,
    webhookDeliveries: { everyMinutes: 30, offset: 7 },
  }
  assertEquals(
    dueMinutes((ms) => isDue('webhookDeliveries', ms, table)),
    [7, 37]
  )
  // Defaults are untouched.
  assertEquals(
    dueMinutes((ms) => isDue('webhookDeliveries', ms)),
    [6, 21, 36, 51]
  )
})

const dialect = new PgDialect()

function fakeDb(respond: (sqlText: string) => unknown[] | Promise<unknown[]>): {
  db: Db
  statements: string[]
} {
  const statements: string[] = []
  const db = {
    execute: (query: SQL) => {
      const sqlText = dialect.sqlToQuery(query).sql
      statements.push(sqlText)
      return Promise.resolve(respond(sqlText))
    },
  } as unknown as Db
  return { db, statements }
}

const IDLE_ROW = {
  commandRecoveryWork: false,
  notificationWork: false,
  connectedServer: false,
  reconcileUrgent: false,
  hostingPending: false,
  repinPending: false,
  principalRemoval: false,
  certificates: false,
  httpCertificates: false,
  httpCertificatesActive: false,
  tunnels: false,
  networkProbe: false,
}

test('loadCronGates answers every gate in one statement', async () => {
  const { db, statements } = fakeDb(() => [{ ...IDLE_ROW, connectedServer: true }])
  const gates = await loadCronGates(db)
  assertEquals(statements.length, 1)
  assertEquals(gates, { ...IDLE_ROW, connectedServer: true })
  for (const key of Object.keys(ALL_GATES_OPEN)) {
    assertEquals(statements[0].includes(`as "${key}"`), true, key)
  }
})

test('a gate that cannot be read, or reads oddly, opens the family', async () => {
  const failing = {
    execute: () => Promise.reject(new Error('connection reset')),
  } as unknown as Db
  assertEquals(await loadCronGates(failing), ALL_GATES_OPEN)
  assertEquals(await loadCronGates(fakeDb(() => []).db), ALL_GATES_OPEN)
  const odd = await loadCronGates(fakeDb(() => [{ ...IDLE_ROW, tunnels: null }]).db)
  assertEquals(odd.tunnels, true)
  assertEquals(odd.hostingPending, false)
})
