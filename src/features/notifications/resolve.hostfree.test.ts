import { assertEquals } from '@std/assert'
import {
  type EventScope,
  levelAllows,
  type PreferenceRow,
  preferenceKindForChannel,
  resolveLevel,
  rowsByUser,
} from './resolve.ts'

const test = Deno.test.bind(Deno)

const ORG_A = '00000000-0000-7000-8000-00000000000a'
const ORG_B = '00000000-0000-7000-8000-00000000000b'
const PROJECT = '00000000-0000-7000-8000-000000000001'
const OTHER_PROJECT = '00000000-0000-7000-8000-000000000002'
const ENV = '00000000-0000-7000-8000-000000000003'
const SERVER = '00000000-0000-7000-8000-000000000004'
const CHANNEL = '00000000-0000-7000-8000-000000000005'
const USER = '00000000-0000-7000-8000-000000000006'
const NOW = Date.parse('2026-11-06T12:00:00Z')

let counter = 0
function row(fields: Partial<PreferenceRow>): PreferenceRow {
  counter += 1
  return {
    id: `row-${counter}`,
    userId: USER,
    organizationId: null,
    projectId: null,
    environmentId: null,
    serviceId: null,
    serverId: null,
    destinationId: null,
    channelId: null,
    categoryCode: null,
    topicCode: null,
    kind: null,
    level: 'all',
    endsAt: null,
    ...fields,
  }
}

function scope(fields: Partial<EventScope> = {}): EventScope {
  return {
    organizationId: ORG_A,
    projectId: null,
    environmentId: null,
    serviceId: null,
    serverId: null,
    destinationId: null,
    topicCode: 'server.offline',
    categoryCode: 'servers',
    ...fields,
  }
}

const EMAIL = { kind: 'email', channelId: null } as const
const INBOX = { kind: 'inbox', channelId: null } as const

test('no rows means nothing: the catalog level is none', () => {
  const result = resolveLevel([], scope(), EMAIL, NOW)
  assertEquals(result, { level: 'none', source: null })
  assertEquals(levelAllows(result.level, 'critical'), false)
})

test('a level is a severity floor', () => {
  assertEquals(levelAllows('all', 'info'), true)
  assertEquals(levelAllows('warning', 'info'), false)
  assertEquals(levelAllows('warning', 'warning'), true)
  assertEquals(levelAllows('warning', 'critical'), true)
  assertEquals(levelAllows('critical', 'warning'), false)
  assertEquals(levelAllows('critical', 'critical'), true)
  assertEquals(levelAllows('none', 'critical'), false)
})

test('organization rows apply only to their organization; a global row to every one', () => {
  const rows = [row({ level: 'warning' }), row({ organizationId: ORG_B, level: 'none' })]
  assertEquals(resolveLevel(rows, scope(), EMAIL, NOW).level, 'warning')
  assertEquals(resolveLevel(rows, scope({ organizationId: ORG_B }), EMAIL, NOW).level, 'none')
})

test('a global row also decides an install event with no organization', () => {
  const rows = [row({ level: 'critical' }), row({ organizationId: ORG_A, level: 'all' })]
  assertEquals(resolveLevel(rows, scope({ organizationId: null }), EMAIL, NOW).level, 'critical')
})

test('scope beats subject: a project row wins over a global category row', () => {
  const rows = [
    row({ categoryCode: 'servers', level: 'none' }),
    row({ organizationId: ORG_A, projectId: PROJECT, level: 'all' }),
  ]
  assertEquals(resolveLevel(rows, scope({ projectId: PROJECT }), EMAIL, NOW).level, 'all')
  // The inverse: in another project the category row still decides.
  assertEquals(resolveLevel(rows, scope({ projectId: OTHER_PROJECT }), EMAIL, NOW).level, 'none')
})

test('environment beats project, and a resource beats them all', () => {
  const rows = [
    row({ organizationId: ORG_A, projectId: PROJECT, level: 'critical' }),
    row({ organizationId: ORG_A, projectId: PROJECT, environmentId: ENV, level: 'all' }),
  ]
  assertEquals(
    resolveLevel(rows, scope({ projectId: PROJECT, environmentId: ENV }), EMAIL, NOW).level,
    'all'
  )
  const server = [
    row({ organizationId: ORG_A, level: 'all' }),
    row({ organizationId: ORG_A, serverId: SERVER, level: 'none' }),
  ]
  assertEquals(resolveLevel(server, scope({ serverId: SERVER }), EMAIL, NOW).level, 'none')
})

test('inside one scope a topic row beats a category row, which beats every topic', () => {
  const rows = [
    row({ organizationId: ORG_A, level: 'none' }),
    row({ organizationId: ORG_A, categoryCode: 'servers', level: 'warning' }),
    row({ organizationId: ORG_A, topicCode: 'server.offline', level: 'all' }),
  ]
  assertEquals(resolveLevel(rows, scope(), EMAIL, NOW).level, 'all')
  assertEquals(
    resolveLevel(rows, scope({ topicCode: 'server.enrolled' }), EMAIL, NOW).level,
    'warning'
  )
  assertEquals(
    resolveLevel(
      rows,
      scope({ topicCode: 'access.grant_created', categoryCode: 'access' }),
      EMAIL,
      NOW
    ).level,
    'none'
  )
})

test('a channel row beats a kind row, which beats every kind', () => {
  const rows = [
    row({ level: 'none' }),
    row({ kind: 'email', level: 'warning' }),
    row({ channelId: CHANNEL, level: 'all' }),
  ]
  assertEquals(resolveLevel(rows, scope(), { kind: 'email', channelId: CHANNEL }, NOW).level, 'all')
  assertEquals(resolveLevel(rows, scope(), EMAIL, NOW).level, 'warning')
  assertEquals(resolveLevel(rows, scope(), INBOX, NOW).level, 'none')
})

test('a row whose end has passed is ignored; one still running applies', () => {
  const rows = [
    row({ level: 'all' }),
    row({ organizationId: ORG_A, level: 'none', endsAt: '2026-11-06T11:00:00Z' }),
  ]
  assertEquals(resolveLevel(rows, scope(), EMAIL, NOW).level, 'all')
  const muted = [
    row({ level: 'all' }),
    row({ organizationId: ORG_A, level: 'none', endsAt: '2026-11-06T13:00:00Z' }),
  ]
  assertEquals(resolveLevel(muted, scope(), EMAIL, NOW).level, 'none')
})

test('the deciding row is reported, so a screen can say where a level came from', () => {
  const org = row({ organizationId: ORG_A, kind: 'inbox', level: 'all' })
  assertEquals(resolveLevel([org], scope(), INBOX, NOW).source?.id, org.id)
})

test('rows group by person and chat kinds fold into one preference kind', () => {
  const other = row({ userId: 'someone-else' })
  const mine = row({})
  const grouped = rowsByUser([other, mine])
  assertEquals(grouped.get(USER)?.length, 1)
  assertEquals(preferenceKindForChannel('slack'), 'chat')
  assertEquals(preferenceKindForChannel('telegram'), 'chat')
  assertEquals(preferenceKindForChannel('webhook'), 'webhook')
  assertEquals(preferenceKindForChannel('email'), 'email')
})
