/**
 * Host-free coverage for detected-app facts (no Postgres).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  preserveServiceApp,
  readServiceApp,
  recordDeployedSiteApps,
  withServiceApp,
} from './app-facts.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

type Row = { id: string; composeServiceName: string; metadata: unknown }

function createDb(rows: Row[]): Db & { writes: Array<{ metadata: unknown }> } {
  const writes: Array<{ metadata: unknown }> = []
  const db = {
    writes,
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
    update: () => ({
      set: (patch: { metadata: unknown }) => {
        writes.push(patch)
        return { where: () => Promise.resolve([]) }
      },
    }),
  }
  return db as unknown as Db & { writes: Array<{ metadata: unknown }> }
}

test('readServiceApp accepts a known kind and rejects junk', () => {
  assertEquals(readServiceApp({ app: { kind: 'wordpress', version: '6.5.2' } }), {
    kind: 'wordpress',
    version: '6.5.2',
  })
  assertEquals(readServiceApp({ app: { kind: 'wordpress', version: 'x y' } }), {
    kind: 'wordpress',
  })
  assertEquals(readServiceApp({ app: { kind: 'drupal' } }), undefined)
  assertEquals(readServiceApp({ app: 'wordpress' }), undefined)
  assertEquals(readServiceApp(null), undefined)
})

test('withServiceApp sets and clears only the app key', () => {
  assertEquals(withServiceApp({ note: 1 }, { kind: 'wordpress' }), {
    note: 1,
    app: { kind: 'wordpress' },
  })
  assertEquals(withServiceApp({ note: 1, app: { kind: 'wordpress' } }, undefined), { note: 1 })
  assertEquals(withServiceApp(null, undefined), {})
})

test('preserveServiceApp keeps the stored fact across a client metadata replacement', () => {
  assertEquals(preserveServiceApp({ app: { kind: 'wordpress' }, a: 1 }, { b: 2 }), {
    b: 2,
    app: { kind: 'wordpress' },
  })
  assertEquals(preserveServiceApp({ a: 1 }, { b: 2, app: { kind: 'wordpress' } }), { b: 2 })
})

test('recordDeployedSiteApps writes changed facts, clears stale ones and skips unchanged', async () => {
  const db = createDb([
    { id: 's-blog', composeServiceName: 'blog', metadata: null },
    { id: 's-docs', composeServiceName: 'docs', metadata: { app: { kind: 'wordpress' }, keep: 1 } },
    {
      id: 's-same',
      composeServiceName: 'same',
      metadata: { app: { kind: 'wordpress', version: '6.5.2' } },
    },
  ])
  const changed = await recordDeployedSiteApps(db, {
    environmentId: 'env-1',
    sites: [
      { composeServiceName: 'blog', app: { kind: 'wordpress', version: '6.5.2' } },
      { composeServiceName: 'docs' },
      { composeServiceName: 'same', app: { kind: 'wordpress', version: '6.5.2' } },
      { composeServiceName: 'unknown-to-this-environment', app: { kind: 'wordpress' } },
    ],
  })
  assertEquals(changed, 2)
  assertEquals(db.writes, [
    { metadata: { app: { kind: 'wordpress', version: '6.5.2' } } },
    { metadata: { keep: 1 } },
  ])
})

test('recordDeployedSiteApps does nothing for an empty report', async () => {
  const db = createDb([])
  assertEquals(await recordDeployedSiteApps(db, { environmentId: 'env-1', sites: [] }), 0)
  assertEquals(db.writes, [])
})
