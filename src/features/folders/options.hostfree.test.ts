import { assertEquals } from '@std/assert'
import { hasFolderOptions, parseFolderOptions } from './options.ts'

const test = Deno.test.bind(Deno)

test('parseFolderOptions reads the three fields and skips the absent ones', () => {
  assertEquals(parseFolderOptions({}), { ok: true, options: {} })
  assertEquals(parseFolderOptions({ slug: 'example.com', directoryName: 'uuid', common: true }), {
    ok: true,
    options: { slug: 'example.com', directoryName: 'uuid', common: true },
  })
  assertEquals(parseFolderOptions({ name: 'ignored' }), { ok: true, options: {} })
})

test('parseFolderOptions refuses a field of the wrong type', () => {
  for (const body of [
    { slug: 5 },
    { slug: null },
    { directoryName: 'both' },
    { directoryName: 3 },
    { common: 'yes' },
    { common: 1 },
  ]) {
    assertEquals(parseFolderOptions(body), { ok: false }, JSON.stringify(body))
  }
})

test('hasFolderOptions is true when any of the three is named', () => {
  assertEquals(hasFolderOptions({}), false)
  assertEquals(hasFolderOptions({ common: false }), true)
  assertEquals(hasFolderOptions({ slug: 'x' }), true)
  assertEquals(hasFolderOptions({ directoryName: 'slug' }), true)
})
