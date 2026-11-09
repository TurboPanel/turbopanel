import { assert, assertEquals } from '@std/assert'
import type { Context } from 'hono'
import type { Db } from '../../db/connection.ts'
import type { AuditNotifyEnv } from '../notifications/audit-bridge.ts'
import {
  describeEvent,
  eventAudience,
  eventIsUrgent,
  eventScope,
  eventSeverity,
  isNotificationEvent,
} from '../notifications/events.ts'
import type { BackupTargetRow } from './targets.ts'
import {
  assignmentLabel,
  assignmentMoved,
  assignmentNotice,
  BACKUP_TARGET_CHANGED_EVENT,
  describeBackupTargetChange,
  endpointHost,
  recordBackupTargetChange,
  type TargetPlace,
  targetPlaceOf,
} from './target-change.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep this alias. */
const test = Deno.test.bind(Deno)

const PLACE: TargetPlace = {
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'tp-backups',
  prefix: 'tp',
  pathStyle: true,
  accessKeyId: 'AKIAEXAMPLE',
}

const TARGET_A = '0190a000-0000-7000-8000-00000000000a'
const TARGET_B = '0190a000-0000-7000-8000-00000000000b'
const NAMES = new Map([
  [TARGET_A, 'Offsite'],
  [TARGET_B, 'Elsewhere'],
])

test('the endpoint host keeps the port and drops the scheme; unparsable text comes back as is', () => {
  assertEquals(endpointHost('https://s3.example.com'), 's3.example.com')
  assertEquals(endpointHost('http://10.0.0.5:9000'), '10.0.0.5:9000')
  assertEquals(endpointHost('not a url'), 'not a url')
  assertEquals(endpointHost('mailto:someone'), 'mailto:someone')
})

test('a row maps to the settings that decide where copies land', () => {
  const row = { ...PLACE, isPathStyle: false, name: 'Offsite' } as unknown as BackupTargetRow
  assertEquals(targetPlaceOf(row), { ...PLACE, pathStyle: false })
})

test('a rename or an unchanged save moves nothing', () => {
  assertEquals(describeBackupTargetChange(PLACE, { ...PLACE }, false), null)
})

test('an endpoint change names both hosts', () => {
  const change = describeBackupTargetChange(
    PLACE,
    { ...PLACE, endpoint: 'https://backups.attacker.example:8443' },
    false
  )
  assertEquals(change, {
    endpointBefore: 's3.example.com',
    endpointAfter: 'backups.attacker.example:8443',
    accessKeyChanged: false,
    secretReplaced: false,
  })
})

test('bucket, region, folder and path style changes are each described', () => {
  const change = describeBackupTargetChange(
    PLACE,
    { ...PLACE, bucket: 'other', region: 'eu-west-1', prefix: '', pathStyle: false },
    false
  )
  assertEquals(change, {
    bucketBefore: 'tp-backups',
    bucketAfter: 'other',
    regionBefore: 'us-east-1',
    regionAfter: 'eu-west-1',
    prefixBefore: 'tp',
    prefixAfter: '',
    pathStyle: false,
    accessKeyChanged: false,
    secretReplaced: false,
  })
})

test('a new secret or access key is reported as replaced, never shown', () => {
  const secret = describeBackupTargetChange(PLACE, { ...PLACE }, true)
  assertEquals(secret, { accessKeyChanged: false, secretReplaced: true })
  const key = describeBackupTargetChange(PLACE, { ...PLACE, accessKeyId: 'AKIAOTHER' }, false)
  assertEquals(key, { accessKeyChanged: true, secretReplaced: false })
  assert(!JSON.stringify(key).includes('AKIA'))
})

test('an assignment moves only when it names something else', () => {
  assertEquals(assignmentMoved(TARGET_A, TARGET_A.toUpperCase()), false)
  assertEquals(assignmentMoved(null, null), false)
  assertEquals(assignmentMoved(null, TARGET_A), true)
  assertEquals(assignmentMoved(TARGET_A, 'none'), true)
})

test('an assignment side reads as a name, no copy, or the organization default', () => {
  assertEquals(assignmentLabel(TARGET_A, NAMES, 'organization'), 'Offsite')
  assertEquals(assignmentLabel(TARGET_A.toUpperCase(), NAMES, 'cluster'), 'Offsite')
  assertEquals(assignmentLabel(null, NAMES, 'organization'), 'no backup target')
  assertEquals(assignmentLabel(null, NAMES, 'cluster'), 'the organization default')
  assertEquals(assignmentLabel('none', NAMES, 'cluster'), 'no backup target')
  assertEquals(
    assignmentLabel('0190a000-0000-7000-8000-0000000000ff', NAMES, 'cluster'),
    'a backup target that no longer exists'
  )
})

test('an assignment notice is null when nothing moved and names both sides otherwise', () => {
  assertEquals(
    assignmentNotice({
      scope: 'organization',
      before: TARGET_A,
      after: TARGET_A,
      targetNames: NAMES,
    }),
    null
  )
  assertEquals(
    assignmentNotice({
      scope: 'organization',
      before: TARGET_A,
      after: TARGET_B,
      targetNames: NAMES,
    }),
    {
      kind: 'assign',
      scope: 'organization',
      before: 'Offsite',
      after: 'Elsewhere',
      afterNone: false,
    }
  )
  assertEquals(
    assignmentNotice({
      scope: 'cluster',
      before: null,
      after: 'none',
      targetNames: NAMES,
      clusterName: 'Orders',
    }),
    {
      kind: 'assign',
      scope: 'cluster',
      clusterName: 'Orders',
      before: 'the organization default',
      after: 'no backup target',
      afterNone: true,
    }
  )
  assertEquals(
    assignmentNotice({ scope: 'cluster', before: 'none', after: TARGET_A, targetNames: NAMES })
      ?.clusterName,
    null
  )
})

test('the event is an urgent warning for owners, managers and administrators', () => {
  assert(isNotificationEvent(BACKUP_TARGET_CHANGED_EVENT))
  assertEquals(eventScope(BACKUP_TARGET_CHANGED_EVENT), 'organization')
  assertEquals(eventSeverity(BACKUP_TARGET_CHANGED_EVENT), 'warning')
  assertEquals(eventAudience(BACKUP_TARGET_CHANGED_EVENT), 'managers')
  assertEquals(eventIsUrgent(BACKUP_TARGET_CHANGED_EVENT), true)
})

test('an update notice names the target and every moved setting in plain words', () => {
  const { title, body } = describeEvent(BACKUP_TARGET_CHANGED_EVENT, {
    kind: 'update',
    targetName: 'Offsite',
    actorEmail: 'owner@example.com',
    endpointBefore: 's3.example.com',
    endpointAfter: 'backups.example.net',
    bucketBefore: 'tp-backups',
    bucketAfter: 'other',
    regionBefore: 'us-east-1',
    regionAfter: 'eu-west-1',
    prefixBefore: 'tp',
    prefixAfter: '',
    pathStyle: false,
    accessKeyChanged: true,
    secretReplaced: true,
  })
  assertEquals(title, 'Backup target Offsite now points somewhere else')
  assertEquals(
    body,
    'owner@example.com changed the backup target Offsite: endpoint s3.example.com to backups.example.net, ' +
      'bucket tp-backups to other, region us-east-1 to eu-west-1, folder tp to (none), ' +
      'path-style addressing turned off, a different access key id, a new secret access key. ' +
      'Every backup copied from now on goes there. ' +
      "If you did not expect this, check the organization's backup targets."
  )
  const bare = describeEvent(BACKUP_TARGET_CHANGED_EVENT, { pathStyle: true })
  assertEquals(bare.title, 'Backup target unknown now points somewhere else')
  assert(
    bare.body?.startsWith(
      'An owner or manager changed the backup target unknown: path-style addressing turned on.'
    )
  )
  assert(describeEvent(BACKUP_TARGET_CHANGED_EVENT).body?.includes(': its settings changed.'))
})

test('an assignment notice says where backups go now, or that they are no longer copied', () => {
  const moved = describeEvent(BACKUP_TARGET_CHANGED_EVENT, {
    kind: 'assign',
    scope: 'organization',
    before: 'Offsite',
    after: 'Elsewhere',
    afterNone: false,
  })
  assertEquals(moved.title, 'Backups for the organization now go to Elsewhere')
  assertEquals(
    moved.body,
    'An owner or manager changed where backups are copied from Offsite to Elsewhere. ' +
      "If you did not expect this, check the organization's backup targets."
  )
  const off = describeEvent(BACKUP_TARGET_CHANGED_EVENT, {
    kind: 'assign',
    scope: 'cluster',
    clusterName: 'Orders',
    before: 'Offsite',
    after: 'no backup target',
    afterNone: true,
  })
  assertEquals(off.title, 'Backups for Orders are no longer copied to a backup target')
  assertEquals(
    describeEvent(BACKUP_TARGET_CHANGED_EVENT, { kind: 'assign', scope: 'cluster' }).title,
    'Backups for a database cluster now go to another backup target'
  )
})

type Inserted = Record<string, unknown>

/** A database that records every insert and answers every read with one manager. */
function fakeDb(inserted: Inserted[], failInserts = false): Db {
  const chain: Record<string, unknown> = {}
  const rows = [{ userId: 'user-1', id: 'user-1', name: 'Org A' }]
  for (const method of ['from', 'where', 'innerJoin', 'leftJoin', 'limit', 'orderBy']) {
    chain[method] = () => chain
  }
  chain.then = (resolve: (value: unknown) => unknown) => resolve(rows)
  return {
    insert: () => ({
      values: (row: Inserted | Inserted[]) => {
        if (failInserts) throw new Error('database down')
        inserted.push(...(Array.isArray(row) ? row : [row]))
        return Object.assign(Promise.resolve([]), {
          returning: () => Promise.resolve([{ id: 'row-1' }]),
          onConflictDoNothing: () => Promise.resolve([]),
        })
      },
    }),
    select: () => chain,
    selectDistinct: () => chain,
    execute: () => Promise.resolve([]),
    transaction: (fn: (tx: unknown) => unknown) => fn(undefined),
  } as unknown as Db
}

function fakeContext(db: Db): Context<AuditNotifyEnv> {
  const values: Record<string, unknown> = { db }
  return { get: (key: string) => values[key] } as unknown as Context<AuditNotifyEnv>
}

const ENTRY = {
  organizationId: '0190a000-0000-7000-8000-0000000000aa',
  actorEmail: 'owner@example.com',
  action: 'backup_target.update',
  targetType: 'organization',
  targetId: TARGET_A,
  context: { name: 'Offsite', bucketBefore: 'tp-backups', bucketAfter: 'other' },
} as const

test('a change with no notice is audited and raises nothing', async () => {
  const inserted: Inserted[] = []
  await recordBackupTargetChange(fakeContext(fakeDb(inserted)), { ...ENTRY }, null)
  assertEquals(
    inserted.map((row) => row.action),
    ['backup_target.update']
  )
})

test('a change with a notice is audited and raises the event', async () => {
  const inserted: Inserted[] = []
  await recordBackupTargetChange(
    fakeContext(fakeDb(inserted)),
    { ...ENTRY },
    {
      kind: 'update',
      targetName: 'Offsite',
    }
  )
  assertEquals(inserted[0]?.action, 'backup_target.update')
  // One event row, with its words; who reads it is each person's choice.
  const raised = inserted.filter(
    (row) => (row as { topicCode?: string }).topicCode === BACKUP_TARGET_CHANGED_EVENT
  )
  assertEquals(raised.length, 1, JSON.stringify(inserted))
  assertEquals(
    (raised[0] as { data?: { title?: string } }).data?.title,
    'Backup target Offsite now points somewhere else'
  )
})

test('a failing database never fails the request', async () => {
  const outcomes = await Promise.allSettled([
    recordBackupTargetChange(fakeContext(fakeDb([], true)), { ...ENTRY }, { kind: 'update' }),
    recordBackupTargetChange(
      fakeContext(undefined as unknown as Db),
      { ...ENTRY },
      { kind: 'update' }
    ),
  ])
  assertEquals(
    outcomes.map((outcome) => outcome.status),
    ['fulfilled', 'fulfilled']
  )
})
