import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import { railpackIdentitiesFromResult } from './releases.ts'

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
})
