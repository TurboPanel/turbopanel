/**
 * Host-free stubs for resolveWorkspaceKindForEntity (DB suites still cover real joins).
 */

import { assertEquals } from 'jsr:@std/assert'
import type { Db } from '../../db.ts'
import {
  WORKSPACE_KIND_SYSTEM,
  WORKSPACE_KIND_USER,
} from '../../lib/db/workspace-kind.ts'
import { resolveWorkspaceKindForEntity } from './workspace-kind-ancestry.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function kindDb(opts: {
  selectKind?: string | null
  executeKinds?: Array<string | null | undefined>
}): Db {
  let executeCalls = 0
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(
              opts.selectKind === undefined
                ? []
                : [{ kind: opts.selectKind }],
            ),
        }),
      }),
    }),
    execute: () => {
      const kinds = opts.executeKinds ?? []
      const kind = kinds[executeCalls]
      executeCalls += 1
      return Promise.resolve(
        kind === undefined || kind === null ? [] : [{ kind }],
      )
    },
  } as unknown as Db
}

test('resolveWorkspaceKindForEntity returns null for unknown entity types', async () => {
  assertEquals(
    await resolveWorkspaceKindForEntity(kindDb({}), 'organization', 'x'),
    null,
  )
  assertEquals(
    await resolveWorkspaceKindForEntity(kindDb({}), 'server', 'x'),
    null,
  )
})

test('resolveWorkspaceKindForEntity resolves workspace rows via select()', async () => {
  assertEquals(
    await resolveWorkspaceKindForEntity(
      kindDb({ selectKind: WORKSPACE_KIND_SYSTEM }),
      'workspace',
      'w1',
    ),
    WORKSPACE_KIND_SYSTEM,
  )
  assertEquals(
    await resolveWorkspaceKindForEntity(
      kindDb({ selectKind: null }),
      'workspace',
      'w1',
    ),
    null,
  )
  assertEquals(
    await resolveWorkspaceKindForEntity(kindDb({}), 'workspace', 'missing'),
    null,
  )
})

test('resolveWorkspaceKindForEntity walks execute() ancestries for tree entities', async () => {
  for (const entityType of [
    'project',
    'environment',
    'service',
    'hosting',
    'container',
    'managed',
    'variable',
    'storage',
  ]) {
    assertEquals(
      await resolveWorkspaceKindForEntity(
        kindDb({ executeKinds: [WORKSPACE_KIND_USER] }),
        entityType,
        'id-1',
      ),
      WORKSPACE_KIND_USER,
    )
  }
})

test('resolveWorkspaceKindForEntity tries principal project managed and assignment paths', async () => {
  // First execute empty, second managed hits.
  assertEquals(
    await resolveWorkspaceKindForEntity(
      kindDb({ executeKinds: [null, WORKSPACE_KIND_SYSTEM] }),
      'principal',
      'p1',
    ),
    WORKSPACE_KIND_SYSTEM,
  )

  // Project + managed empty, assignment hits.
  assertEquals(
    await resolveWorkspaceKindForEntity(
      kindDb({ executeKinds: [null, null, WORKSPACE_KIND_USER] }),
      'principal',
      'p1',
    ),
    WORKSPACE_KIND_USER,
  )

  assertEquals(
    await resolveWorkspaceKindForEntity(
      kindDb({ executeKinds: [null, null, null] }),
      'principal',
      'p1',
    ),
    null,
  )
})
