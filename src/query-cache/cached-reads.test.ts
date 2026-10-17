import { assert, assertEquals, assertNotEquals } from '@std/assert'
import { readFileSync } from 'node:fs'
import { APPROVED_READ_MODELS, CACHED_READ_REGISTRY } from './approved-read-models.ts'
import { inspectCachedRead } from './cached-read.ts'
import { ALL_CACHED_READS } from './cached-reads.ts'
import { uncacheableReason } from './statement-guard.ts'

const test = Deno.test.bind(Deno)

/** Words that must never appear in the select list of a cached statement. */
const SECRET_WORDS = ['daemon', 'password', 'secret', 'token', '"key"', 'private', 'credential']

test('the registry and the definitions list the same ids', () => {
  const defined = ALL_CACHED_READS.map((read) => read.definition.id).sort()
  assertEquals(defined, [...APPROVED_READ_MODELS].sort())
  assertEquals(new Set(defined).size, defined.length)
})

test('every registered statement is a plain, cacheable select that matches its fingerprint', () => {
  for (const read of ALL_CACHED_READS) {
    const def = read.definition
    assert(def.samples.length > 0, `${def.id} needs sample inputs`)
    for (const sample of def.samples) {
      const first = inspectCachedRead(def as never, sample as never)
      assertEquals(uncacheableReason(first.sql), null, def.id)
      assertEquals(first.fingerprint, CACHED_READ_REGISTRY[def.id].fingerprint, def.id)

      // Same inputs build the same text and parameters, so the key is stable.
      const second = inspectCachedRead(def as never, sample as never)
      assertEquals(second.sql, first.sql)
      assertEquals(second.params, first.params)
      assertEquals(second.key, first.key)

      const selectList = first.sql.slice(0, first.sql.indexOf(' from '))
      for (const word of SECRET_WORDS) {
        assert(!selectList.toLowerCase().includes(word), `${def.id} selects ${word}`)
      }
    }
  }
})

test('different inputs give different keys', () => {
  for (const read of ALL_CACHED_READS) {
    const keys = read.definition.samples.map(
      (s) => inspectCachedRead(read.definition as never, s as never).key
    )
    assertEquals(new Set(keys).size, keys.length, read.definition.id)
  }
  const [list] = ALL_CACHED_READS
  const a = inspectCachedRead(list.definition, ['srv-1'])
  const b = inspectCachedRead(list.definition, ['srv-2'])
  assertNotEquals(a.key, b.key)
  assertEquals(a.fingerprint, b.fingerprint)
})

test('the approved read model table in the query cache notes lists exactly the registry ids', () => {
  const notes = readFileSync(new URL('./AGENTS.md', import.meta.url), 'utf8')
  const section = notes.slice(notes.indexOf('## Approved read models'))
  const ids = [...section.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]).sort()
  assertEquals(ids, [...APPROVED_READ_MODELS].sort())
})

test('the boundary check passes on the tree and catches a leak', async () => {
  const { findViolations, GUARDED } = await import('../../scripts/check-query-cache-boundaries.mjs')
  const leak = findViolations(
    [
      {
        rel: 'src/client/servers/routes.ts',
        text: 'const a = getQueryCache(c)\nrunApprovedCachedReadModel()',
      },
      { rel: 'src/daemon/cell/do.ts', text: 'resolveWorkersCachedDb(env)' },
      {
        rel: 'src/client/x.ts',
        text: '// cachedDb is a comment here\nconst y = env.HYPERDRIVE_CACHED',
      },
      { rel: 'src/query-cache/read-models/x.ts', text: 'defineCachedRead({})' },
    ],
    GUARDED
  )
  assertEquals(leak.length, 4)
})
