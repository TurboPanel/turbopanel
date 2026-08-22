import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import type { Db } from '../../db.ts'
import {
  loadStewardPrincipalIdsForEnvironment,
  loadPrincipalIdsByServiceIdForEnvironment,
  loadServiceIdsByPrincipalIds,
  parseServiceIdsField,
  pickSolePrincipalId,
  servicesBelongToProject,
} from './stewards.ts'

const PID_A = '00000000-0000-4000-8000-00000000000a'
const PID_B = '00000000-0000-4000-8000-00000000000b'
const SID_A = '00000000-0000-4000-8000-000000000001'
const SID_B = '00000000-0000-4000-8000-000000000002'
const SID_C = '00000000-0000-4000-8000-000000000003'

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

function createAssignmentSelectDb(rows: unknown[]): Db {
  const chain = {
    from: () => ({
      where: () => thenableRows(rows),
      innerJoin: () => ({
        where: () => thenableRows(rows),
      }),
    }),
  }
  return {
    select: () => chain,
    selectDistinct: () => chain,
  } as unknown as Db
}

describe('parseServiceIdsField', () => {
  it('returns empty when serviceIds is omitted', () => {
    assertEquals(parseServiceIdsField({ username: 'app' }), [])
  })

  it('returns empty for an empty array', () => {
    assertEquals(parseServiceIdsField({ serviceIds: [] }), [])
  })

  it('dedupes and sorts valid UUIDs', () => {
    assertEquals(parseServiceIdsField({ serviceIds: [SID_B, SID_A, SID_B] }), [
      SID_A,
      SID_B,
    ])
  })

  it('trims whitespace around valid UUIDs', () => {
    assertEquals(
      parseServiceIdsField({ serviceIds: [` ${SID_B} `, `\t${SID_A}\n`] }),
      [SID_A, SID_B],
    )
  })

  it('rejects non-array serviceIds', () => {
    assertEquals(parseServiceIdsField({ serviceIds: 'nope' }), null)
    assertEquals(parseServiceIdsField({ serviceIds: 12 }), null)
    assertEquals(parseServiceIdsField({ serviceIds: { id: SID_A } }), null)
  })

  it('rejects invalid UUID entries', () => {
    assertEquals(parseServiceIdsField({ serviceIds: ['not-a-uuid'] }), null)
    assertEquals(parseServiceIdsField({ serviceIds: [SID_A, ''] }), null)
    assertEquals(
      parseServiceIdsField({ serviceIds: [SID_A, '   '] }),
      null,
    )
  })

  it('rejects non-string entries', () => {
    assertEquals(parseServiceIdsField({ serviceIds: [SID_A, 1] }), null)
    assertEquals(parseServiceIdsField({ serviceIds: [null] }), null)
  })
})

describe('pickSolePrincipalId', () => {
  it('returns none when empty', () => {
    assertEquals(pickSolePrincipalId([]), { status: 'none' })
  })

  it('returns the sole id', () => {
    assertEquals(pickSolePrincipalId([PID_A]), {
      status: 'one',
      principalId: PID_A,
    })
  })

  it('returns ambiguous when more than one', () => {
    assertEquals(pickSolePrincipalId([PID_A, PID_B]), { status: 'ambiguous' })
  })
})

describe('loadServiceIdsByPrincipalIds', () => {
  it('returns empty lists without querying when ids are empty', async () => {
    const map = await loadServiceIdsByPrincipalIds(
      null as unknown as Db,
      [],
    )
    assertEquals([...map.entries()], [])
  })

  it('seeds empty lists for principals with no stewards', async () => {
    const map = await loadServiceIdsByPrincipalIds(
      createAssignmentSelectDb([]),
      [PID_A, PID_B],
    )
    assertEquals(map.get(PID_A), [])
    assertEquals(map.get(PID_B), [])
  })

  it('groups service ids and sorts each list', async () => {
    const map = await loadServiceIdsByPrincipalIds(
      createAssignmentSelectDb([
        { principalId: PID_A, serviceId: SID_B },
        { principalId: PID_A, serviceId: SID_A },
        { principalId: PID_B, serviceId: SID_C },
        { principalId: 'unknown-principal', serviceId: SID_A },
      ]),
      [PID_A, PID_B],
    )
    assertEquals(map.get(PID_A), [SID_A, SID_B])
    assertEquals(map.get(PID_B), [SID_C])
    assertEquals(map.get('unknown-principal'), [SID_A])
  })
})

describe('servicesBelongToProject', () => {
  it('returns true for an empty service list without querying', async () => {
    assertEquals(
      await servicesBelongToProject(null as unknown as Db, 'proj-1', []),
      true,
    )
  })

  it('returns false when any id is not a UUID', async () => {
    assertEquals(
      await servicesBelongToProject(
        null as unknown as Db,
        'proj-1',
        [SID_A, 'not-a-uuid'],
      ),
      false,
    )
  })

  it('returns true when every unique id belongs to the project', async () => {
    const db = createAssignmentSelectDb([{ id: SID_A }, { id: SID_B }])
    assertEquals(
      await servicesBelongToProject(db, 'proj-1', [SID_B, SID_A, SID_A]),
      true,
    )
  })

  it('returns false when the project is missing a requested service', async () => {
    const db = createAssignmentSelectDb([{ id: SID_A }])
    assertEquals(
      await servicesBelongToProject(db, 'proj-1', [SID_A, SID_B]),
      false,
    )
  })
})

describe('loadStewardPrincipalIdsForEnvironment', () => {
  it('returns sorted distinct principal ids', async () => {
    const ids = await loadStewardPrincipalIdsForEnvironment(
      createAssignmentSelectDb([
        { principalId: PID_B },
        { principalId: PID_A },
      ]),
      'env-1',
    )
    assertEquals(ids, [PID_A, PID_B])
  })

  it('returns empty when no stewards exist', async () => {
    assertEquals(
      await loadStewardPrincipalIdsForEnvironment(
        createAssignmentSelectDb([]),
        'env-1',
      ),
      [],
    )
  })
})

describe('loadPrincipalIdsByServiceIdForEnvironment', () => {
  it('groups principal ids by service and sorts each list', async () => {
    const map = await loadPrincipalIdsByServiceIdForEnvironment(
      createAssignmentSelectDb([
        { serviceId: SID_A, principalId: PID_B },
        { serviceId: SID_A, principalId: PID_A },
        { serviceId: SID_B, principalId: PID_A },
      ]),
      'env-1',
    )
    assertEquals(map.get(SID_A), [PID_A, PID_B])
    assertEquals(map.get(SID_B), [PID_A])
  })

  it('returns an empty map when there are no rows', async () => {
    const map = await loadPrincipalIdsByServiceIdForEnvironment(
      createAssignmentSelectDb([]),
      'env-1',
    )
    assertEquals([...map.entries()], [])
  })
})
