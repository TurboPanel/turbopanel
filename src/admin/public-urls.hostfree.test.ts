/**
 * Host-free get/set for public URL settings (also pure parsers for Deno LCOV).
 */

import { assertEquals } from '@std/assert'
import type { Db } from '../db.ts'
import {
  getPublicUrls,
  hostFromPublicUrlEntry,
  parsePublicUrlEntries,
  publicUrlEntryToInstallOrigin,
  setPublicUrls,
} from './public-urls.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows)
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  }
}

test('hostFromPublicUrlEntry extracts host and rejects invalids', () => {
  assertEquals(hostFromPublicUrlEntry(''), null)
  assertEquals(hostFromPublicUrlEntry('https://panel.example.com'), 'panel.example.com')
  assertEquals(hostFromPublicUrlEntry('panel.example.com:8443'), 'panel.example.com')
  assertEquals(hostFromPublicUrlEntry('https://[2001:db8::1]'), '2001:db8::1')
  assertEquals(hostFromPublicUrlEntry('localhost'), null)
  assertEquals(hostFromPublicUrlEntry('not a url'), null)
  assertEquals(hostFromPublicUrlEntry('https://null'), null)
})

test('publicUrlEntryToInstallOrigin https bare host and http allowance', () => {
  assertEquals(publicUrlEntryToInstallOrigin(''), null)
  assertEquals(
    publicUrlEntryToInstallOrigin('https://panel.example.com/'),
    'https://panel.example.com',
  )
  assertEquals(publicUrlEntryToInstallOrigin('http://dev.example.com:8880'), null)
  assertEquals(
    publicUrlEntryToInstallOrigin('http://dev.example.com:8880', '8443', {
      allowHttp: true,
    }),
    'http://dev.example.com:8880',
  )
  assertEquals(
    publicUrlEntryToInstallOrigin('panel.example.com'),
    'https://panel.example.com:8443',
  )
  assertEquals(
    publicUrlEntryToInstallOrigin('https://[2001:db8::1]:9443'),
    'https://[2001:db8::1]:9443',
  )
  assertEquals(
    publicUrlEntryToInstallOrigin('ftp://panel.example.com'),
    null,
  )
  assertEquals(
    publicUrlEntryToInstallOrigin('https://localhost'),
    null,
  )
  assertEquals(
    publicUrlEntryToInstallOrigin('https://user:pass@panel.example.com'),
    null,
  )
  assertEquals(
    publicUrlEntryToInstallOrigin('https://panel.example.com/path'),
    null,
  )
  assertEquals(
    publicUrlEntryToInstallOrigin('https://panel.example.com?q=1'),
    null,
  )
  assertEquals(
    publicUrlEntryToInstallOrigin('https://panel.example.com#hash'),
    null,
  )
  assertEquals(publicUrlEntryToInstallOrigin('panel.example.com/path'), null)
  assertEquals(publicUrlEntryToInstallOrigin('panel.example.com?q=1'), null)
  assertEquals(publicUrlEntryToInstallOrigin('host with spaces'), null)
})

test('parsePublicUrlEntries validates dedupes and reports invalids', () => {
  assertEquals(parsePublicUrlEntries([]), { ok: true, urls: [] })
  assertEquals(
    parsePublicUrlEntries(['https://a.example.com', 'https://a.example.com/']),
    { ok: true, urls: ['https://a.example.com'] },
  )
  const invalid = parsePublicUrlEntries(['localhost', 'https://ok.example.com'])
  assertEquals(invalid.ok, false)
  if (!invalid.ok) {
    assertEquals(invalid.invalid, ['localhost'])
  }
  assertEquals(
    parsePublicUrlEntries(['http://dev.example.com'], { allowHttp: true }).ok,
    true,
  )
  assertEquals(
    parsePublicUrlEntries(['http://dev.example.com']).ok,
    false,
  )
  const blanks = parsePublicUrlEntries(['', '  ', 'panel.example.com:9443'])
  assertEquals(blanks.ok, false)
  if (!blanks.ok) {
    assertEquals(blanks.invalid, ['', '  '])
  }
  assertEquals(
    parsePublicUrlEntries(['[2001:db8::1]:8443']),
    { ok: true, urls: ['[2001:db8::1]:8443'] },
  )
  assertEquals(
    parsePublicUrlEntries(['https://user:pass@panel.example.com']).ok,
    false,
  )
  assertEquals(
    parsePublicUrlEntries(['ftp://panel.example.com', 'panel.example.com/path']).ok,
    false,
  )
  // Bare host and https origin that share an install origin dedupe.
  assertEquals(
    parsePublicUrlEntries([
      'panel.example.com:8443',
      'https://panel.example.com:8443',
    ]),
    { ok: true, urls: ['panel.example.com:8443'] },
  )
})
test('getPublicUrls returns empty for null missing and blank entries', async () => {
  const empty = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await getPublicUrls(empty), [])

  const nullValue = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ value: null }]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await getPublicUrls(nullValue), [])
})

test('getPublicUrls accepts array and comma-separated string shapes', async () => {
  const fromArray = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              {
                value: [
                  'https://a.example.com',
                  '  ',
                  12,
                  'https://b.example.com',
                ],
              },
            ]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await getPublicUrls(fromArray), [
    'https://a.example.com',
    'https://b.example.com',
  ])

  const fromString = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              { value: ' https://one.example.com ,  ,https://two.example.com ' },
            ]),
        }),
      }),
    }),
  } as unknown as Db
  assertEquals(await getPublicUrls(fromString), [
    'https://one.example.com',
    'https://two.example.com',
  ])
})

test('setPublicUrls upserts the TURBOPANEL_PUBLIC_URLS setting', async () => {
  let inserted: unknown
  let conflictSet: unknown
  const db = {
    insert: () => ({
      values: (values: unknown) => {
        inserted = values
        return {
          onConflictDoUpdate: (opts: { set: unknown }) => {
            conflictSet = opts.set
            return thenableRows([])
          },
        }
      },
    }),
  } as unknown as Db

  await setPublicUrls(db, ['https://panel.example.com'])
  assertEquals(
    (inserted as { key: string; value: string[] }).key,
    'TURBOPANEL_PUBLIC_URLS',
  )
  assertEquals((inserted as { value: string[] }).value, [
    'https://panel.example.com',
  ])
  assertEquals(
    Array.isArray((conflictSet as { value: string[] }).value),
    true,
  )
})
