import { assertEquals } from '@std/assert'
import { isValidProjectSlug } from '../../contracts/directory-names.ts'
import {
  nextFreeProjectSlug,
  PROJECT_SLUG_FALLBACK,
  projectSlugFromName,
  resolveDirectoryNameChoice,
  resolveFolderName,
} from './names.ts'

const test = Deno.test.bind(Deno)

const ID = '0199b3c0-1d2e-7a4b-8c5d-123456789abc'

test('projectSlugFromName makes a valid slug from a display name', () => {
  assertEquals(projectSlugFromName('My Shop & Blog'), 'my-shop-blog')
  assertEquals(projectSlugFromName('  Café Münster  '), 'cafe-munster')
  assertEquals(projectSlugFromName('Release_2026.10'), 'release-2026-10')
  assertEquals(projectSlugFromName('---'), PROJECT_SLUG_FALLBACK)
  assertEquals(projectSlugFromName(null), PROJECT_SLUG_FALLBACK)
  assertEquals(projectSlugFromName('日本語'), PROJECT_SLUG_FALLBACK)
})

test('projectSlugFromName cuts to 40 characters and trims the end', () => {
  const slug = projectSlugFromName(`${'a'.repeat(39)} b${'c'.repeat(20)}`)
  assertEquals(slug.length <= 40, true)
  assertEquals(slug.endsWith('-'), false)
  assertEquals(isValidProjectSlug(slug), true)
})

test('nextFreeProjectSlug suffixes a clash and keeps the slug within 40 characters', () => {
  assertEquals(
    nextFreeProjectSlug('shop', () => false),
    'shop'
  )
  assertEquals(
    nextFreeProjectSlug('shop', (s) => s === 'shop'),
    'shop-2'
  )
  assertEquals(
    nextFreeProjectSlug('shop', (s) => s === 'shop' || s === 'shop-2'),
    'shop-3'
  )
  const long = 'a'.repeat(40)
  const next = nextFreeProjectSlug(long, (s) => s === long)
  assertEquals(next?.length, 40)
  assertEquals(next?.endsWith('-2'), true)
  assertEquals(
    nextFreeProjectSlug('shop', () => true),
    null
  )
})

test('resolveDirectoryNameChoice follows the organization setting', () => {
  assertEquals(resolveDirectoryNameChoice('slug', undefined), { ok: true, choice: 'slug' })
  assertEquals(resolveDirectoryNameChoice('uuid', undefined), { ok: true, choice: 'uuid' })
  assertEquals(resolveDirectoryNameChoice('both', undefined), { ok: true, choice: 'slug' })
  assertEquals(resolveDirectoryNameChoice('both', 'uuid'), { ok: true, choice: 'uuid' })
  assertEquals(resolveDirectoryNameChoice('slug', 'slug'), { ok: true, choice: 'slug' })
  assertEquals(resolveDirectoryNameChoice('slug', 'uuid'), {
    ok: false,
    error: 'directory_name_mode_forbidden',
  })
  assertEquals(resolveDirectoryNameChoice('uuid', 'slug'), {
    ok: false,
    error: 'directory_name_mode_forbidden',
  })
})

test('resolveFolderName: uuid mode uses the asset id and refuses a typed name', () => {
  const free = () => false
  assertEquals(resolveFolderName({ choice: 'uuid', assetId: ID, isTaken: free }), {
    ok: true,
    slug: ID,
  })
  assertEquals(resolveFolderName({ choice: 'uuid', assetId: ID, typed: 'x', isTaken: free }), {
    ok: false,
    error: 'directory_name_typed_in_uuid_mode',
  })
  assertEquals(resolveFolderName({ choice: 'uuid', assetId: 'not-an-id', isTaken: free }), {
    ok: false,
    error: 'invalid_directory_name',
  })
})

test('resolveFolderName: a typed name is checked and never suffixed', () => {
  const taken = (n: string) => n === 'uploads'
  assertEquals(resolveFolderName({ choice: 'slug', assetId: ID, typed: 'media', isTaken: taken }), {
    ok: true,
    slug: 'media',
  })
  assertEquals(
    resolveFolderName({ choice: 'slug', assetId: ID, typed: 'uploads', isTaken: taken }),
    { ok: false, error: 'directory_name_taken' }
  )
  for (const typed of ['Media', 'a..b', '-a', 'a b', '']) {
    assertEquals(resolveFolderName({ choice: 'slug', assetId: ID, typed, isTaken: taken }), {
      ok: false,
      error: 'invalid_directory_name',
    })
  }
})

test('resolveFolderName: a defaulted name gets -2 to -99, then asks the person to type one', () => {
  assertEquals(
    resolveFolderName({
      choice: 'slug',
      assetId: ID,
      defaultBase: 'example.com',
      isTaken: (n) => n === 'example.com',
    }),
    { ok: true, slug: 'example.com-2' }
  )
  assertEquals(
    resolveFolderName({
      choice: 'slug',
      assetId: ID,
      defaultBase: 'example.com',
      isTaken: () => true,
    }),
    { ok: false, error: 'directory_name_taken' }
  )
  assertEquals(
    resolveFolderName({ choice: 'slug', assetId: ID, defaultBase: null, isTaken: () => false }),
    { ok: false, error: 'invalid_directory_name' }
  )
})
