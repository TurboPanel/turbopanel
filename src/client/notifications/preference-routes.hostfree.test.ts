import { assertEquals } from '@std/assert'
import { effectiveLevels, NOTIFICATION_PRESETS, parsePreferenceWrite } from './preference-routes.ts'
import type { PreferenceRow } from '../../features/notifications/resolve.ts'

const test = Deno.test.bind(Deno)

const ORG = '00000000-0000-7000-8000-00000000000a'
const PROJECT = '00000000-0000-7000-8000-000000000001'
const ENV = '00000000-0000-7000-8000-000000000002'

test('a preference write is shape-checked before ownership', () => {
  assertEquals(parsePreferenceWrite(null).ok, false)
  assertEquals(parsePreferenceWrite({ level: 'loud' }).ok, false)
  assertEquals(parsePreferenceWrite({ level: 'all', kind: 'push' }).ok, false)
  assertEquals(parsePreferenceWrite({ level: 'all', projectId: PROJECT }).ok, false)
  assertEquals(
    parsePreferenceWrite({ level: 'all', organizationId: ORG, environmentId: ENV }).ok,
    false
  )
  assertEquals(
    parsePreferenceWrite({ level: 'all', categoryCode: 'servers', topicCode: 'server.offline' }).ok,
    false
  )
  assertEquals(parsePreferenceWrite({ level: 'all', categoryCode: 'nope' }).ok, false)
  assertEquals(
    parsePreferenceWrite({
      level: 'all',
      organizationId: ORG,
      serverId: PROJECT,
      destinationId: ENV,
    }).ok,
    false
  )
  const ok = parsePreferenceWrite({
    level: 'warning',
    organizationId: ORG,
    projectId: PROJECT,
    environmentId: ENV,
    kind: 'email',
    categoryCode: 'servers',
  })
  assertEquals(ok.ok, true)
  if (ok.ok) {
    assertEquals(ok.value.environmentId, ENV)
    assertEquals(ok.value.channelId, null)
    assertEquals(ok.value.endsAt, null)
  }
})

test('the presets turn the bell and email on, or both off', () => {
  assertEquals(NOTIFICATION_PRESETS.recommended, { inbox: 'all', email: 'warning' })
  assertEquals(NOTIFICATION_PRESETS.nothing, { inbox: 'none', email: 'none' })
})

test('effective levels say where each one came from', () => {
  const row = (fields: Partial<PreferenceRow>): PreferenceRow => ({
    id: crypto.randomUUID(),
    userId: 'u',
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
  })
  const global = row({ kind: 'email', level: 'critical' })
  const project = row({ organizationId: ORG, projectId: PROJECT, kind: 'inbox', level: 'all' })
  const effective = effectiveLevels(
    [global, project],
    {
      organizationId: ORG,
      projectId: PROJECT,
      environmentId: ENV,
      serviceId: null,
      serverId: null,
      destinationId: null,
    },
    Date.now()
  )
  assertEquals(effective.email, { level: 'critical', sourceId: global.id, source: 'global' })
  assertEquals(effective.inbox, { level: 'all', sourceId: project.id, source: 'project' })
  assertEquals(effective.chat, { level: 'none', sourceId: null, source: 'default' })
})
