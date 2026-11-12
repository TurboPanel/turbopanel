/**
 * Host-free coverage for the host-level approval audit entries.
 */

import { assertEquals } from '@std/assert'
import {
  HOST_ACCESS_AUDIT_MAX_BRANCH_LENGTH,
  HOST_ACCESS_AUDIT_MAX_COMMIT_LENGTH,
  HOST_ACCESS_AUDIT_MAX_PATH_LENGTH,
  HOST_ACCESS_AUDIT_MAX_PATHS,
  hostAccessAuditEntry,
  hostAccessAuditPaths,
  hostAccessUseTrigger,
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

const USE_EVENT = {
  action: 'compose.host_access.use',
  fingerprint: 'f'.repeat(64),
  issues: [{ path: 'services.web.privileged' }],
  approvedBy: 'user-1',
  approvedAt: '2026-11-05T00:00:00.000Z',
} as const

test('a push is the trigger when the selection names a ref or a commit', () => {
  assertEquals(
    hostAccessUseTrigger({ ref: 'refs/heads/main', commitSha: 'abc123', sourceId: 'repo-7' }),
    { kind: 'push', sourceId: 'repo-7', branch: 'main', commitSha: 'abc123' }
  )
  assertEquals(hostAccessUseTrigger({ ref: null, commitSha: 'abc123', sourceId: 'repo-7' }), {
    kind: 'push',
    sourceId: 'repo-7',
    branch: null,
    commitSha: 'abc123',
  })
  assertEquals(hostAccessUseTrigger({ ref: 'main', commitSha: null, sourceId: null }), {
    kind: 'push',
    sourceId: null,
    branch: 'main',
    commitSha: null,
  })
})

test('a selection with neither ref nor commit is a run the control plane started', () => {
  assertEquals(hostAccessUseTrigger({ ref: null, commitSha: null, sourceId: null }), {
    kind: 'system',
  })
  // A source id alone is no push: nothing was pushed that could be built.
  assertEquals(hostAccessUseTrigger({ ref: null, commitSha: null, sourceId: 'repo-7' }), {
    kind: 'system',
  })
})

test('a use entry for a push names the repository, branch and commit', () => {
  const entry = hostAccessAuditEntry(USE_EVENT, TARGET, {
    userId: null,
    email: null,
    automatedActorId: 'repo-7',
    trigger: { kind: 'push', sourceId: 'repo-7', branch: 'main', commitSha: 'abc123' },
  })
  assertEquals(entry.context, {
    environmentId: 'env-1',
    projectId: 'proj-1',
    fingerprint: 'f'.repeat(64),
    paths: ['services.web.privileged'],
    pathCount: 1,
    approvedBy: 'user-1',
    approvedAt: '2026-11-05T00:00:00.000Z',
    automatedActorId: 'repo-7',
    trigger: 'push',
    sourceId: 'repo-7',
    branch: 'main',
    commitSha: 'abc123',
  })
})

test('a use entry leaves out what a push did not name and bounds what it did', () => {
  const sparse = hostAccessAuditEntry(USE_EVENT, TARGET, {
    userId: null,
    email: null,
    automatedActorId: 'repo-7',
    trigger: { kind: 'push', sourceId: null, branch: null, commitSha: 'abc123' },
  })
  assertEquals(sparse.context?.trigger, 'push')
  assertEquals(sparse.context?.commitSha, 'abc123')
  assertEquals('sourceId' in (sparse.context ?? {}), false)
  assertEquals('branch' in (sparse.context ?? {}), false)

  const long = hostAccessAuditEntry(USE_EVENT, TARGET, {
    userId: null,
    email: null,
    trigger: {
      kind: 'push',
      sourceId: 'repo-7',
      branch: 'b'.repeat(HOST_ACCESS_AUDIT_MAX_BRANCH_LENGTH * 2),
      commitSha: 'c'.repeat(HOST_ACCESS_AUDIT_MAX_COMMIT_LENGTH * 2),
    },
  })
  assertEquals(String(long.context?.branch).length, HOST_ACCESS_AUDIT_MAX_BRANCH_LENGTH)
  assertEquals(String(long.context?.commitSha).length, HOST_ACCESS_AUDIT_MAX_COMMIT_LENGTH)
})

test('a use entry for a run the control plane started says so and names no push', () => {
  const entry = hostAccessAuditEntry(USE_EVENT, TARGET, {
    userId: null,
    email: null,
    automatedActorId: 'hosting-3',
    trigger: { kind: 'system' },
  })
  assertEquals(entry.context?.trigger, 'system')
  assertEquals('commitSha' in (entry.context ?? {}), false)
  assertEquals('branch' in (entry.context ?? {}), false)
})

test('an approve entry carries no trigger', () => {
  const entry = hostAccessAuditEntry(
    { ...USE_EVENT, action: 'compose.host_access.approve' },
    TARGET,
    { userId: 'user-1', email: 'owner@example.test' }
  )
  assertEquals('trigger' in (entry.context ?? {}), false)
})
