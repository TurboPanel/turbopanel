import { assertEquals, assertMatch } from '@std/assert'
import {
  describeEvent,
  eventAudience,
  eventIsUrgent,
  eventLabel,
  eventScope,
  eventSeverity,
  NOTIFICATION_EVENTS,
} from './events.ts'
import { listOrphanFolders } from './folder-alerts.ts'

/** Sonar typescript:S2187 only recognizes `test()`; keep this alias. */
const test = Deno.test.bind(Deno)

test('every event has a plain label a person can pick it by', () => {
  for (const event of NOTIFICATION_EVENTS) {
    const label = eventLabel(event)
    assertEquals(label.length > 0, true, event)
    // The label is a name, not a code.
    assertEquals(label.includes('.'), false, event)
  }
  assertEquals(eventLabel('folder.orphans_found'), 'A folder was left behind on a server')
  assertEquals(eventLabel('certificate.renewal_failed'), 'A certificate failed to renew')
})

test('the orphan alert goes to managers, as a warning, and may wait for a digest', () => {
  assertEquals(eventSeverity('folder.orphans_found'), 'warning')
  assertEquals(eventScope('folder.orphans_found'), 'organization')
  assertEquals(eventAudience('folder.orphans_found'), 'managers')
  assertEquals(eventIsUrgent('folder.orphans_found'), false)
})

test('one orphan reads in the singular and says where to go next', () => {
  const { title, body } = describeEvent('folder.orphans_found', {
    serverName: 'Alpha',
    count: 1,
    folders: 'Service blog (production)',
  })
  assertEquals(title, 'A folder was left behind on Alpha')
  assertMatch(body ?? '', /^Service blog \(production\) no longer belongs to a service or volume\./)
  assertMatch(body ?? '', /Folders that need attention/)
})

test('several orphans read in the plural with the count in the title', () => {
  const { title, body } = describeEvent('folder.orphans_found', {
    serverName: 'Alpha',
    count: 3,
    folders: 'Service blog (production), volume data (shared) and 1 more',
  })
  assertEquals(title, '3 folders were left behind on Alpha')
  assertMatch(body ?? '', /no longer belong to a service or volume\./)
})

test('an empty context still reads as a sentence', () => {
  const { title, body } = describeEvent('folder.orphans_found')
  assertEquals(title, 'A folder was left behind on a server')
  assertMatch(body ?? '', /^A folder no longer belongs/)
})

test('the listing names five folders and counts the rest', () => {
  const entry = (slug: string, scope = 'production', kind = 'service') => ({
    id: slug,
    serverId: 's',
    organizationId: 'o',
    serverName: 'Alpha',
    kind,
    scope,
    slug,
  })
  assertEquals(listOrphanFolders([entry('blog')]), 'Service blog (production)')
  assertEquals(
    listOrphanFolders([entry('blog'), entry('uploads', 'common', 'volume')]),
    'Service blog (production), volume uploads (shared)'
  )
  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((slug) => entry(slug))
  assertEquals(
    listOrphanFolders(many),
    'Service a (production), service b (production), service c (production), service d (production), service e (production) and 2 more'
  )
})
