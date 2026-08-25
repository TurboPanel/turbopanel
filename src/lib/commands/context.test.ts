import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  commandContextFromPayload,
  normalizeContextReleases,
  normalizeReplicaCounts,
  type CommandContextRelease,
} from './context.ts'

describe('normalizeReplicaCounts', () => {
  it('accepts a service name to positive integer map', () => {
    assertEquals(normalizeReplicaCounts({ web: 2, api: 1 }), { web: 2, api: 1 })
  })

  it('rejects non-objects, arrays, and empty maps', () => {
    for (const value of [null, undefined, 'x', 1, [], {}]) {
      assertEquals(normalizeReplicaCounts(value), undefined)
    }
  })

  it('rejects empty service keys and invalid counts', () => {
    assertEquals(normalizeReplicaCounts({ '': 1 }), undefined)
    assertEquals(normalizeReplicaCounts({ web: 0 }), undefined)
    assertEquals(normalizeReplicaCounts({ web: 1.5 }), undefined)
    assertEquals(normalizeReplicaCounts({ web: '2' }), undefined)
  })
})

describe('normalizeContextReleases', () => {
  const baseRelease: CommandContextRelease = {
    composeServiceName: 'web',
    releaseId: 'rel-1',
    sourceId: 'src-1',
    commitSha: 'abc123',
  }

  it('accepts fully-formed release rows with optional display fields', () => {
    assertEquals(
      normalizeContextReleases([
        {
          ...baseRelease,
          commitMessage: 'Fix deploy',
          commitAuthor: 'Operator',
          rollbackToReleaseId: 'rel-0',
        },
      ]),
      [
        {
          composeServiceName: 'web',
          releaseId: 'rel-1',
          sourceId: 'src-1',
          commitSha: 'abc123',
          commitMessage: 'Fix deploy',
          commitAuthor: 'Operator',
          rollbackToReleaseId: 'rel-0',
        },
      ],
    )
  })

  it('drops blank optional display fields but keeps whitespace-only values', () => {
    assertEquals(
      normalizeContextReleases([
        {
          ...baseRelease,
          commitMessage: '',
        },
      ]),
      [baseRelease],
    )
    assertEquals(
      normalizeContextReleases([
        {
          ...baseRelease,
          commitAuthor: '   ',
        },
      ]),
      [{ ...baseRelease, commitAuthor: '   ' }],
    )
  })

  it('rejects non-arrays and drops the whole array on a malformed required field', () => {
    for (const value of [null, {}, 'releases']) {
      assertEquals(normalizeContextReleases(value), undefined)
    }
    assertEquals(
      normalizeContextReleases([
        baseRelease,
        { composeServiceName: 'api', releaseId: '', sourceId: 'src-2', commitSha: 'def' },
      ]),
      undefined,
    )
    assertEquals(normalizeContextReleases([]), undefined)
  })

  it('drops the whole array when an entry is not a plain object', () => {
    assertEquals(
      normalizeContextReleases([baseRelease, null]),
      undefined,
    )
    assertEquals(
      normalizeContextReleases([baseRelease, 'not-a-release-row']),
      undefined,
    )
    assertEquals(
      normalizeContextReleases([baseRelease, ['nested', 'array']]),
      undefined,
    )
  })
})

describe('commandContextFromPayload', () => {
  it('copies allowlisted scalar identifiers and replicaCounts', () => {
    assertEquals(
      commandContextFromPayload({
        environmentId: 'env-1',
        generation: 3,
        serverId: 'srv-1',
        replicaCounts: { web: 2 },
        secretYaml: 'must-not-appear',
        credential: { token: 'nope' },
      }),
      {
        environmentId: 'env-1',
        generation: 3,
        serverId: 'srv-1',
        replicaCounts: { web: 2 },
      },
    )
  })

  it('ignores non-scalar allowlist values and malformed replicaCounts', () => {
    assertEquals(
      commandContextFromPayload({
        managedId: { nested: true },
        action: ['deploy'],
        replicaCounts: { web: 0 },
      }),
      undefined,
    )
  })

  it('returns undefined for non-objects and empty payloads', () => {
    for (const value of [null, undefined, 'payload', 1, []]) {
      assertEquals(commandContextFromPayload(value), undefined)
    }
    assertEquals(commandContextFromPayload({}), undefined)
  })
})
