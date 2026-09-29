import { assertEquals } from "@std/assert";
import { eq } from "drizzle-orm";
import { getDatabaseUrl } from "../../db/url.ts";
import { createDenoDb } from "../../db/connection.ts";
import {
  instanceHostname,
  instanceUploadedCertificate,
  setting,
} from "../../db/schema.ts";
import {
  getPublicUrls,
  PUBLIC_URLS_SETTING_KEY,
  setPublicUrls,
} from "./public-urls.ts";
import {
  applyUploadedCertificateHosts,
  upsertInstanceHostname,
} from "./instance-hostnames.ts";

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

async function hostnameRows(db: ReturnType<typeof createDenoDb>) {
  const rows = await db
    .select({
      host: instanceHostname.host,
      source: instanceHostname.source,
      uploadedCertId: instanceHostname.uploadedCertId,
    })
    .from(instanceHostname);
  return rows.sort((a, b) => a.host.localeCompare(b.host));
}

test("writing the flat list keeps each existing hostname's certificate source", async () => {
  await withPublicUrlsFixture(async (db) => {
    await db.delete(instanceHostname);
    const upserted = await upsertInstanceHostname(
      db,
      "panel.example.com",
      "lets-encrypt",
    );
    assertEquals(upserted.ok, true);

    // The legacy flat editor only knows the names; it must not reset sources.
    await setPublicUrls(db, [
      "https://panel.example.com",
      "https://new.example.com",
    ]);
    assertEquals(await hostnameRows(db), [
      {
        host: "https://new.example.com:8443",
        source: "platform-ca",
        uploadedCertId: null,
      },
      {
        host: "https://panel.example.com:8443",
        source: "lets-encrypt",
        uploadedCertId: null,
      },
    ]);
  });
});

test("writing the flat list with two spellings of one name stores it once", async () => {
  await withPublicUrlsFixture(async (db) => {
    await db.delete(instanceHostname);
    await setPublicUrls(db, ["https://panel.example.com"]);
    await setPublicUrls(db, [
      "https://panel.example.com",
      "https://panel.example.com.",
    ]);
    assertEquals((await hostnameRows(db)).length, 1);
  });
});

test("attaching an uploaded certificate to the other spelling of a published host updates that row", async () => {
  if (!dbUrl) return;
  const db = createDenoDb();
  const [cert] = await db
    .insert(instanceUploadedCertificate)
    .values({
      label: "panel",
      certPem: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----",
      keyPem: "sealed",
      dnsNames: ["panel.example.com"],
      notAfter: "2030-01-01T00:00:00.000Z",
    })
    .returning({ id: instanceUploadedCertificate.id });
  try {
    await withPublicUrlsFixture(async (fixtureDb) => {
      await fixtureDb.delete(instanceHostname);
      await setPublicUrls(fixtureDb, ["https://panel.example.com"]);
      // Stored as `https://panel.example.com:8443`; attached as the bare name.
      const applied = await applyUploadedCertificateHosts(fixtureDb, {
        id: cert!.id,
        dnsNames: ["panel.example.com"],
        notAfter: "2030-01-01T00:00:00.000Z",
      }, ["panel.example.com"]);
      assertEquals(applied.ok, true);
      assertEquals(await hostnameRows(fixtureDb), [
        {
          host: "https://panel.example.com:8443",
          source: "uploaded",
          uploadedCertId: cert!.id,
        },
      ]);
    });
  } finally {
    await db
      .delete(instanceUploadedCertificate)
      .where(eq(instanceUploadedCertificate.id, cert!.id));
  }
});

const UPLOAD_NAMES = ["a.example.com", "b.example.com", "c.example.com"];

async function withUploadedCertificate(
  fn: (
    cert: { id: string; dnsNames: string[]; notAfter: string },
    db: ReturnType<typeof createDenoDb>,
  ) => Promise<void>,
): Promise<void> {
  if (!dbUrl) return;
  const db = createDenoDb();
  const [inserted] = await db
    .insert(instanceUploadedCertificate)
    .values({
      label: "attach-matrix",
      certPem: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----",
      keyPem: "sealed",
      dnsNames: UPLOAD_NAMES,
      notAfter: "2030-01-01T00:00:00.000Z",
    })
    .returning({ id: instanceUploadedCertificate.id });
  const cert = {
    id: inserted!.id,
    dnsNames: UPLOAD_NAMES,
    notAfter: "2030-01-01T00:00:00.000Z",
  };
  try {
    await withPublicUrlsFixture(async (fixtureDb) => {
      await fixtureDb.delete(instanceHostname);
      await fn(cert, fixtureDb);
    });
  } finally {
    await db.delete(instanceUploadedCertificate).where(
      eq(instanceUploadedCertificate.id, cert.id),
    );
  }
}

test("attaching an uploaded certificate detaches dropped hosts, adds new ones, and returns the names sorted", async () => {
  await withUploadedCertificate(async (cert, db) => {
    await setPublicUrls(db, ["https://a.example.com", "https://b.example.com"]);
    const first = await applyUploadedCertificateHosts(db, cert, [
      "b.example.com",
      "c.example.com",
      "a.example.com",
      // A second spelling of an already listed name is one attachment.
      "a.example.com.",
    ]);
    assertEquals(first.ok, true);
    assertEquals(first.ok && first.hostnames, [
      "c.example.com",
      "https://a.example.com:8443",
      "https://b.example.com:8443",
    ]);
    assertEquals(await hostnameRows(db), [
      {
        host: "c.example.com",
        source: "uploaded",
        uploadedCertId: cert.id,
      },
      {
        host: "https://a.example.com:8443",
        source: "uploaded",
        uploadedCertId: cert.id,
      },
      {
        host: "https://b.example.com:8443",
        source: "uploaded",
        uploadedCertId: cert.id,
      },
    ]);

    // Listing only `c` detaches the others back to the platform CA, and an
    // unrelated row with no certificate is left exactly as it was.
    const second = await applyUploadedCertificateHosts(db, cert, [
      "c.example.com",
    ]);
    assertEquals(second.ok, true);
    assertEquals(second.ok && second.hostnames.length, 1);
    assertEquals(await hostnameRows(db), [
      {
        host: "c.example.com",
        source: "uploaded",
        uploadedCertId: cert.id,
      },
      {
        host: "https://a.example.com:8443",
        source: "platform-ca",
        uploadedCertId: null,
      },
      {
        host: "https://b.example.com:8443",
        source: "platform-ca",
        uploadedCertId: null,
      },
    ]);
  });
});

test("attaching an uploaded certificate reports invalid and uncovered hosts without writing", async () => {
  await withUploadedCertificate(async (cert, db) => {
    await setPublicUrls(db, ["https://a.example.com"]);
    const before = await hostnameRows(db);

    const invalidOnly = await applyUploadedCertificateHosts(db, cert, [
      "not a host",
    ]);
    assertEquals(invalidOnly, {
      ok: false,
      error: "One or more public URL entries are invalid",
      invalid: ["not a host"],
    });

    const uncoveredOnly = await applyUploadedCertificateHosts(db, cert, [
      "a.example.com",
      "other.example.org",
    ]);
    assertEquals(uncoveredOnly.ok, false);
    assertEquals(
      !uncoveredOnly.ok && uncoveredOnly.error,
      "Uploaded certificate does not cover the hostname",
    );
    assertEquals(!uncoveredOnly.ok && uncoveredOnly.invalid.length, 1);

    // Two different failure kinds collapse into the generic message and keep
    // every offending entry.
    const mixed = await applyUploadedCertificateHosts(db, cert, [
      "not a host",
      "other.example.org",
    ]);
    assertEquals(mixed.ok, false);
    assertEquals(!mixed.ok && mixed.error, "One or more hostnames are invalid");
    assertEquals(!mixed.ok && mixed.invalid.length, 2);

    assertEquals(await hostnameRows(db), before);
  });
});
