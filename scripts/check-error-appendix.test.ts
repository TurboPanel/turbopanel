import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  codesInAppendix,
  codesInSource,
  missingFromAppendix,
  NOT_CLIENT_FACING,
} from './check-error-appendix.mjs'

describe('check-error-appendix', () => {
  it('reads every backtick-quoted code in the first column', () => {
    const text = [
      '| Code | Status | Meaning |',
      '| --- | --- | --- |',
      '| `a_code`, `b_code` | 400 | Two codes. |',
      '| `c_code` | 409 | Mentions `not_a_code` in the meaning. |',
    ].join('\n')
    assertEquals([...codesInAppendix(text)], ['a_code', 'b_code', 'c_code'])
  })

  it('reports only codes that are neither listed nor excused', () => {
    const missing = missingFromAppendix(
      new Set(['listed_code', 'new_code', 'retry']),
      new Set(['listed_code'])
    )
    assertEquals(missing, ['new_code'])
    assertEquals(NOT_CLIENT_FACING.has('retry'), true)
  })

  it('finds error literals in source and skips test files', () => {
    const dir = Deno.makeTempDirSync()
    try {
      Deno.mkdirSync(`${dir}/src/client`, { recursive: true })
      Deno.writeTextFileSync(`${dir}/src/client/a.ts`, "c.json({ error: 'real_code' }, 409)")
      Deno.writeTextFileSync(`${dir}/src/client/a.test.ts`, "c.json({ error: 'test_only' }, 409)")
      assertEquals([...codesInSource(dir, ['src/client'])], ['real_code'])
    } finally {
      Deno.removeSync(dir, { recursive: true })
    }
  })
})
