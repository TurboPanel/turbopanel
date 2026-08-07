import { assertEquals } from 'jsr:@std/assert'
import { eq } from 'drizzle-orm'
import { getDatabaseUrl } from '../db-url.ts'
import { createDenoDb } from '../db.ts'
import { setting } from '../lib/db/schema.ts'
import { getPublicUrls, setPublicUrls } from './public-urls.ts'

const dbUrl = getDatabaseUrl()
const PUBLIC_URLS_KEY = 'TURBOPANEL_PUBLIC_URLS'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function withPublicUrlsFixture(
  fn: (db: ReturnType<typeof createDenoDb>) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn('Skipping public-urls DB tests: TURBOPANEL_DATABASE_URL not set')
    return
  }

  const db = createDenoDb()
  const previous = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, PUBLIC_URLS_KEY))
    .limit(1)

  try {
    await fn(db)
  } finally {
    if (previous.length === 0) {
      await db.delete(setting).where(eq(setting.key, PUBLIC_URLS_KEY))
    } else {
      await db
        .insert(setting)
        .values({ key: PUBLIC_URLS_KEY, value: previous[0]!.value })
        .onConflictDoUpdate({
          target: setting.key,
          set: {
            value: previous[0]!.value,
            updatedAt: new Date().toISOString(),
          },
        })
    }
  }
}

test('getPublicUrls returns an empty list when unset', async () => {
  await withPublicUrlsFixture(async (db) => {
    await db.delete(setting).where(eq(setting.key, PUBLIC_URLS_KEY))
    assertEquals(await getPublicUrls(db), [])
  })
})

test('getPublicUrls reads array and comma-separated string values', async () => {
  await withPublicUrlsFixture(async (db) => {
    await setPublicUrls(db, ['https://panel.example.com', 'backup.example.com:9443'])
    assertEquals(await getPublicUrls(db), [
      'https://panel.example.com',
      'backup.example.com:9443',
    ])

    await db
      .insert(setting)
      .values({
        key: PUBLIC_URLS_KEY,
        value: ' https://one.example.com , https://two.example.com ',
      })
      .onConflictDoUpdate({
        target: setting.key,
        set: {
          value: ' https://one.example.com , https://two.example.com ',
          updatedAt: new Date().toISOString(),
        },
      })
    assertEquals(await getPublicUrls(db), [
      'https://one.example.com',
      'https://two.example.com',
    ])
  })
})

test('setPublicUrls persists and replaces prior values', async () => {
  await withPublicUrlsFixture(async (db) => {
    await setPublicUrls(db, ['https://first.example.com'])
    assertEquals(await getPublicUrls(db), ['https://first.example.com'])

    await setPublicUrls(db, ['https://second.example.com'])
    assertEquals(await getPublicUrls(db), ['https://second.example.com'])
  })
})
