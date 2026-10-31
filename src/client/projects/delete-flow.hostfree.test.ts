import { assertEquals } from '@std/assert'
import {
  DELETE_AUDIT_LIST_CAP,
  deleteAuditContext,
  environmentDeleteAuditEntry,
  projectDeleteAuditEntry,
} from './delete-flow.ts'

const test = Deno.test.bind(Deno)

const who = { organizationId: 'org', actorUserId: 'user', actorEmail: 'a@example.test' }

test('a project delete entry keeps the name, environments and hostnames', () => {
  const entry = projectDeleteAuditEntry(who, 'p1', {
    projectName: 'Site',
    environments: [{ id: 'e1', name: 'live' }],
    hostnames: ['a.example.test'],
    serverIds: ['s1'],
    hostingAccounts: ['owner'],
  })
  assertEquals(entry.action, 'project.delete')
  assertEquals(entry.targetType, 'project')
  assertEquals(entry.targetId, 'p1')
  assertEquals(entry.context, {
    name: 'Site',
    environments: [{ id: 'e1', name: 'live' }],
    environmentCount: 1,
    hostnames: ['a.example.test'],
    hostnameCount: 1,
    serverIds: ['s1'],
    hostingAccounts: ['owner'],
    hostingAccountCount: 1,
  })
})

test('an environment delete entry names the environment, not a list', () => {
  const entry = environmentDeleteAuditEntry(who, 'e1', {
    environments: [{ id: 'e1', name: 'live' }],
    hostnames: [],
    serverIds: [],
    hostingAccounts: [],
  })
  assertEquals(entry.action, 'environment.delete')
  assertEquals((entry.context as { name: string }).name, 'live')
  assertEquals('environments' in (entry.context ?? {}), false)
})

test('long lists are capped and the total stays', () => {
  const hostnames = Array.from(
    { length: DELETE_AUDIT_LIST_CAP + 5 },
    (_, i) => `h${i}.example.test`
  )
  const context = deleteAuditContext({
    environments: [],
    hostnames,
    serverIds: [],
    hostingAccounts: [],
  })
  assertEquals((context.hostnames as string[]).length, DELETE_AUDIT_LIST_CAP)
  assertEquals(context.hostnameCount, DELETE_AUDIT_LIST_CAP + 5)
})
