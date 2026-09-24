import { assertEquals } from "@std/assert";
import { eq } from "drizzle-orm";
import { getDatabaseUrl } from "../../db/url.ts";
import { createDenoDb } from "../../db/connection.ts";
import { instanceHostname, setting } from "../../db/schema.ts";
import {
  getPublicUrls,
  PUBLIC_URLS_SETTING_KEY,
  setPublicUrls,
} from "./public-urls.ts";

const dbUrl = getDatabaseUrl();

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function withPublicUrlsFixture(
  fn: (db: ReturnType<typeof createDenoDb>) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(
      "Skipping public-urls DB tests: TURBOPANEL_DATABASE_URL not set",
    );
    return;
  }

  const db = createDenoDb();
  const previousHostnames = await db.select().from(instanceHostname);
  const previousSetting = await db
    .select({ value: setting.value })
    .from(setting)
    .where(eq(setting.key, PUBLIC_URLS_SETTING_KEY))
    .limit(1);

  try {
    await fn(db);
  } finally {
    await db.delete(instanceHostname);
    if (previousHostnames.length > 0) {
      await db.insert(instanceHostname).values(previousHostnames);
    }
    if (previousSetting.length === 0) {
      await db.delete(setting).where(eq(setting.key, PUBLIC_URLS_SETTING_KEY));
    } else {
      await db
        .insert(setting)
        .values({
          key: PUBLIC_URLS_SETTING_KEY,
          value: previousSetting[0]!.value,
        })
        .onConflictDoUpdate({
          target: setting.key,
          set: {
            value: previousSetting[0]!.value,
            updatedAt: new Date().toISOString(),
          },
        });
    }
  }
}

test("getPublicUrls returns an empty list when unset", async () => {
  await withPublicUrlsFixture(async (db) => {
    await db.delete(instanceHostname);
    await db.delete(setting).where(eq(setting.key, PUBLIC_URLS_SETTING_KEY));
    assertEquals(await getPublicUrls(db), []);
  });
});

test("getPublicUrls reads array values through the hostname table", async () => {
  await withPublicUrlsFixture(async (db) => {
    await setPublicUrls(db, [
      "https://panel.example.com",
      "backup.example.com:9443",
    ]);
    assertEquals(await getPublicUrls(db), [
      "https://panel.example.com:8443",
      "backup.example.com:8443",
    ]);
  });
});

test("getPublicUrls migrates a legacy setting string when the hostname table is empty", async () => {
  await withPublicUrlsFixture(async (db) => {
    await db.delete(instanceHostname);
    await db
      .insert(setting)
      .values({
        key: PUBLIC_URLS_SETTING_KEY,
        value: " https://one.example.com , https://two.example.com ",
      })
      .onConflictDoUpdate({
        target: setting.key,
        set: {
          value: " https://one.example.com , https://two.example.com ",
          updatedAt: new Date().toISOString(),
        },
      });
    assertEquals(await getPublicUrls(db), [
      "https://one.example.com:8443",
      "https://two.example.com:8443",
    ]);
  });
});

test("setPublicUrls persists and replaces prior values", async () => {
  await withPublicUrlsFixture(async (db) => {
    await setPublicUrls(db, ["https://first.example.com"]);
    assertEquals(await getPublicUrls(db), ["https://first.example.com:8443"]);

    await setPublicUrls(db, ["https://second.example.com"]);
    assertEquals(await getPublicUrls(db), ["https://second.example.com:8443"]);
  });
});
