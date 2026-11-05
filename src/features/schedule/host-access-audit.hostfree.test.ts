/**
 * Host-free coverage for the host-level approval audit entries.
 */

import { assertEquals } from '@std/assert'
import {
  HOST_ACCESS_AUDIT_MAX_PATH_LENGTH,
  HOST_ACCESS_AUDIT_MAX_PATHS,
  hostAccessAuditEntry,
  hostAccessAuditPaths,
} from './host-access-audit.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const TARGET = { organizationId: 'org-1', environmentId: 'env-1', projectId: 'proj-1' }

test('paths are sorted, de-duplicated and bounded, with the full count kept', () => {
  const issues = [
    { path: 'services.b.privileged' },
    { path: 'services.a.volumes[0]' },
    { path: 'services.b.privileged' },
  ]
  assertEquals(hostAccessAuditPaths(issues), {
    paths: ['services.a.volumes[0]', 'services.b.privileged'],
    pathCount: 2,
  })

  const many = Array.from({ length: HOST_ACCESS_AUDIT_MAX_PATHS + 5 }, (_, i) => ({
    path: `services.s${String(i).padStart(3, '0')}.privileged`,
  }))
  const bounded = hostAccessAuditPaths(many)
  assertEquals(bounded.paths.length, HOST_ACCESS_AUDIT_MAX_PATHS)
  assertEquals(bounded.pathCount, HOST_ACCESS_AUDIT_MAX_PATHS + 5)

  const long = hostAccessAuditPaths([{ path: 'x'.repeat(HOST_ACCESS_AUDIT_MAX_PATH_LENGTH * 2) }])
  assertEquals(long.paths[0]?.length, HOST_ACCESS_AUDIT_MAX_PATH_LENGTH)
})

test('an approve entry names the person and keeps no values', () => {
  const entry = hostAccessAuditEntry(
    {
      action: 'compose.host_access.approve',
      fingerprint: 'f'.repeat(64),
      issues: [{ path: 'services.web.volumes[0]' }],
      approvedBy: 'user-1',
      approvedAt: '2026-11-05T00:00:00.000Z',
    },
    TARGET,
    { userId: 'user-1', email: 'owner@example.test' }
  )
  assertEquals(entry, {
    organizationId: 'org-1',
    actorUserId: 'user-1',
    actorEmail: 'owner@example.test',
    action: 'compose.host_access.approve',
    targetType: 'environment',
    targetId: 'env-1',
    context: {
      environmentId: 'env-1',
      projectId: 'proj-1',
      fingerprint: 'f'.repeat(64),
      paths: ['services.web.volumes[0]'],
      pathCount: 1,
      approvedBy: 'user-1',
      approvedAt: '2026-11-05T00:00:00.000Z',
    },
  })
})

test('a use entry has no person and names the automated trigger', () => {
  const entry = hostAccessAuditEntry(
    {
      action: 'compose.host_access.use',
      fingerprint: 'f'.repeat(64),
      issues: [],
      approvedBy: 'user-1',
      approvedAt: '2026-11-05T00:00:00.000Z',
    },
    TARGET,
    { userId: null, email: null, automatedActorId: 'repo-7' }
  )
  assertEquals(entry.actorUserId, null)
  assertEquals(entry.actorEmail, null)
  assertEquals(entry.context?.automatedActorId, 'repo-7')
  assertEquals(entry.context?.pathCount, 0)
})
