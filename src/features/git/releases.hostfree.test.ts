import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  aggregateReleaseStatus,
  applyResolvedCommitSha,
  isReleaseMaterializedEverywhere,
  markLiveReleases,
  railpackIdentitiesFromResult,
  resolvedCommitShasFromResult,
  releaseServerIds,
  type ServiceReleaseAttempt,
  type ServiceReleaseRecord,
} from './releases.ts'

/**
 * Railpack identity is read off the daemon's deploy result rather than the
 * enqueue-time `context.releases[]`, because at enqueue time no image exists.
 * These cover the extraction rules that keep a bad result from costing a
 * rollback target.
 */
describe('railpackIdentitiesFromResult', () => {
  it('keys a Railpack release by service and release id', () => {
    const identities = railpackIdentitiesFromResult({
      releases: [
        {
          composeServiceName: 'web',
          releaseId: 'rel-42',
          commitSha: 'abc',
          imageTag: 'turbopanel-app/web:rel-42',
          railpackFrontendVersion: '0.9.0',
          railpackPlanVersion: '1',
        },
      ],
    })
    assertEquals(identities.get('web rel-42'), {
      imageTag: 'turbopanel-app/web:rel-42',
      railpackFrontendVersion: '0.9.0',
      railpackPlanVersion: '1',
    })
  })

  it('omits a native release, which has no image identity at all', () => {
    const identities = railpackIdentitiesFromResult({
      releases: [{ composeServiceName: 'web', releaseId: 'rel-42', commitSha: 'abc' }],
    })
    assertEquals(identities.size, 0)
  })

  it('skips a malformed entry without dropping its well-formed peers', () => {
    // Unlike `normalizeContextReleases`, a bad entry here costs a caption, not
    // a rollback target — so the rest of the map must survive it.
    const identities = railpackIdentitiesFromResult({
      releases: [
        null,
        { composeServiceName: 'web', imageTag: 'turbopanel-app/web:rel-1' },
        {
          composeServiceName: 'worker',
          releaseId: 'rel-7',
          imageTag: 'turbopanel-app/worker:rel-7',
        },
      ],
    })
    assertEquals([...identities.keys()], ['worker rel-7'])
  })

  it('reads an empty map from a result that carries no releases', () => {
    assertEquals(railpackIdentitiesFromResult(null).size, 0)
    assertEquals(railpackIdentitiesFromResult({ releases: 'nope' }).size, 0)
    assertEquals(railpackIdentitiesFromResult({}).size, 0)
  })

  it('keeps a release that only reported one Railpack field', () => {
    const identities = railpackIdentitiesFromResult({
      releases: [
        { composeServiceName: 'web', releaseId: 'rel-1', imageTag: 'web:1' },
        { composeServiceName: 'api', releaseId: 'rel-2', railpackFrontendVersion: '0.9.0' },
        { composeServiceName: 'worker', releaseId: 'rel-3', railpackPlanVersion: '2' },
      ],
    })
    assertEquals(identities.get('web rel-1'), { imageTag: 'web:1' })
    assertEquals(identities.get('api rel-2'), { railpackFrontendVersion: '0.9.0' })
    assertEquals(identities.get('worker rel-3'), { railpackPlanVersion: '2' })
  })
})

function attempt(status: string, serverId = 's1', commandId = 'c1'): ServiceReleaseAttempt {
  return { commandId, serverId, status }
}

function release(overrides: Partial<ServiceReleaseRecord> = {}): ServiceReleaseRecord {
  return {
    commandId: 'c1',
    serverId: 's1',
    attempts: [attempt('succeeded')],
    composeServiceName: 'web',
    releaseId: 'rel-1',
    sourceId: 'src-1',
    commitSha: 'abc',
    status: 'succeeded',
    queuedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
    isLive: false,
    ...overrides,
  }
}

describe('aggregateReleaseStatus', () => {
  it('is queued with no attempts and pessimistic across hosts', () => {
    assertEquals(aggregateReleaseStatus([]), 'queued')
    assertEquals(
      aggregateReleaseStatus([attempt('succeeded', 's1'), attempt('failed', 's2')]),
      'failed'
    )
    assertEquals(
      aggregateReleaseStatus([attempt('succeeded', 's1'), attempt('timed_out', 's2')]),
      'timed_out'
    )
    assertEquals(
      aggregateReleaseStatus([attempt('running', 's1'), attempt('succeeded', 's2')]),
      'running'
    )
    assertEquals(
      aggregateReleaseStatus([attempt('succeeded', 's1'), attempt('succeeded', 's2')]),
      'succeeded'
    )
  })
})

describe('markLiveReleases', () => {
  it('marks the newest succeeded release of each service live', () => {
    const marked = markLiveReleases([
      release({ composeServiceName: 'web', releaseId: 'rel-new', status: 'failed' }),
      release({ composeServiceName: 'web', releaseId: 'rel-live', status: 'succeeded' }),
      release({ composeServiceName: 'web', releaseId: 'rel-old', status: 'succeeded' }),
      release({ composeServiceName: 'api', releaseId: 'rel-api', status: 'succeeded' }),
    ])
    assertEquals(
      marked.map((row) => [row.releaseId, row.isLive]),
      [
        ['rel-new', false],
        ['rel-live', true],
        ['rel-old', false],
        ['rel-api', true],
      ]
    )
  })
})

describe('release coverage', () => {
  it('lists every server a release reached', () => {
    const row = release({
      attempts: [attempt('succeeded', 's1'), attempt('failed', 's2'), attempt('running', 's1')],
    })
    assertEquals(
      [...releaseServerIds(row)].sort((a, b) => a.localeCompare(b)),
      ['s1', 's2']
    )
  })

  it('is materialized only when every target already published it', () => {
    const row = release({
      attempts: [attempt('succeeded', 's1'), attempt('succeeded', 's2')],
    })
    assertEquals(isReleaseMaterializedEverywhere(row, []), true)
    assertEquals(isReleaseMaterializedEverywhere(row, ['s1', 's2']), true)
    assertEquals(isReleaseMaterializedEverywhere(row, ['s1', 's3']), false)
  })
})

describe('resolvedCommitShasFromResult', () => {
  const sha = 'b663dc04a1b2c3d4e5f60718293a4b5c6d7e8f90'

  it('reads the commit the daemon checked out, keyed by service and release', () => {
    const shas = resolvedCommitShasFromResult({
      releases: [{ composeServiceName: 'web', releaseId: 'rel-1', commitSha: sha }],
    })
    assertEquals(shas.get('web rel-1'), sha)
  })

  it('ignores a ref name or a missing sha', () => {
    const shas = resolvedCommitShasFromResult({
      releases: [
        { composeServiceName: 'web', releaseId: 'rel-1', commitSha: 'main' },
        { composeServiceName: 'api', releaseId: 'rel-2' },
        null,
      ],
    })
    assertEquals(shas.size, 0)
    assertEquals(resolvedCommitShasFromResult(null).size, 0)
  })
})

describe('applyResolvedCommitSha', () => {
  const sha = 'b663dc04a1b2c3d4e5f60718293a4b5c6d7e8f90'
  const other = 'a'.repeat(40)
  const record = (commitSha: string) => ({ commitSha }) as ServiceReleaseRecord

  it('replaces a ref-name placeholder with the resolved commit', () => {
    const release = record('main')
    applyResolvedCommitSha(release, sha)
    assertEquals(release.commitSha, sha)
  })

  it('keeps a full SHA the record already has', () => {
    const release = record(other)
    applyResolvedCommitSha(release, sha)
    assertEquals(release.commitSha, other)
  })

  it('leaves the placeholder when the host reported nothing', () => {
    const release = record('main')
    applyResolvedCommitSha(release, undefined)
    assertEquals(release.commitSha, 'main')
  })
})
