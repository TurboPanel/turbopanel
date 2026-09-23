/**
 * Hostname validation, legacy public-URL backfill, and the flat-list shim.
 */

import { assertEquals } from "@std/assert";
import type { Db } from "../../db/connection.ts";
import {
  instanceHostname,
  instanceUploadedCertificate,
  setting,
} from "../../db/schema.ts";
import {
  deriveInstanceHostnameStatus,
  getInstanceHostnamesLegacyShim,
  instanceAcmeHttp01PreflightFailure,
  migrateLegacyPublicUrls,
  recordInstanceAcmeIssuance,
  replaceInstanceHostnames,
  replacePublicUrlsWithPlatformCa,
  validateHostnameSource,
} from "./instance-hostnames.ts";
import {
  getPublicUrls,
  PUBLIC_URLS_SETTING_KEY,
  setPublicUrls,
} from "./public-urls.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type MemRow = Record<string, unknown> & { key?: string };

function createMemoryDb(): { db: Db; hostnames: MemRow[]; settings: MemRow[] } {
  const hostnames: MemRow[] = [];
  const certificates: MemRow[] = [];
  const settings: MemRow[] = [];

  function rowsFor(table: unknown): MemRow[] {
    if (table === instanceHostname) return hostnames;
    if (table === instanceUploadedCertificate) return certificates;
    if (table === setting) return settings;
    return [];
  }

  function applyInsert(table: unknown, value: unknown): { id?: string } {
    const list = Array.isArray(value) ? value : [value];
    if (table === setting) {
      const row = list[0] as MemRow;
      const index = settings.findIndex((item) => item.key === row.key);
      if (index >= 0) settings[index] = row;
      else settings.push(row);
      return {};
    }
    if (table === instanceUploadedCertificate) {
      const row = { ...(list[0] as MemRow) };
      row.id = row.id ?? crypto.randomUUID();
      certificates.push(row);
      return { id: String(row.id) };
    }
    for (const row of list) hostnames.push(row as MemRow);
    return {};
  }

  const db = {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return Promise.resolve(rowsFor(table).map((row) => ({ ...row })));
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(value: unknown) {
          let inserted: { id?: string } = {};
          const promise = Promise.resolve().then(() => {
            inserted = applyInsert(table, value);
          });
          return Object.assign(promise, {
            onConflictDoUpdate() {
              return promise;
            },
            returning() {
              return promise.then(() => [{ id: inserted.id }]);
            },
          });
        },
      };
    },
    delete(table: unknown) {
      return {
        where() {
          return Promise.resolve().then(() => {
            if (table === instanceHostname) hostnames.length = 0;
            if (table === instanceUploadedCertificate) certificates.length = 0;
          });
        },
      };
    },
    transaction(fn: (tx: Db) => Promise<unknown>) {
      return fn(db as unknown as Db);
    },
  };

  return { db: db as unknown as Db, hostnames, settings };
}

test("validateHostnameSource rejects private and wildcard Let's Encrypt names", () => {
  const privateName = validateHostnameSource("192.168.1.10", "lets-encrypt");
  assertEquals(privateName.ok, false);
  if (!privateName.ok) assertEquals(privateName.invalid, ["192.168.1.10"]);

  const lan = validateHostnameSource("panel.lan", "lets-encrypt");
  assertEquals(lan.ok, false);

  const wildcard = validateHostnameSource("*.example.com", "lets-encrypt");
  assertEquals(wildcard.ok, false);
  if (!wildcard.ok) {
    assertEquals(wildcard.error.includes("wildcard"), true);
  }

  assertEquals(validateHostnameSource("*.example.com", "platform-ca").ok, true);
  assertEquals(
    validateHostnameSource("panel.example.com", "lets-encrypt").ok,
    true,
  );
});

test("deriveInstanceHostnameStatus prefers failure, then expiry, then pending", () => {
  assertEquals(
    deriveInstanceHostnameStatus({
      source: "lets-encrypt",
      acmeLastError: "rate limited",
      notAfter: "2099-01-01T00:00:00.000Z",
    }),
    "failed",
  );
  assertEquals(
    deriveInstanceHostnameStatus({
      source: "uploaded",
      acmeLastError: null,
      notAfter: "2000-01-01T00:00:00.000Z",
    }, Date.parse("2026-01-01T00:00:00.000Z")),
    "expired",
  );
  assertEquals(
    deriveInstanceHostnameStatus({
      source: "lets-encrypt",
      acmeLastError: null,
      notAfter: null,
    }),
    "pending",
  );
  assertEquals(
    deriveInstanceHostnameStatus({
      source: "platform-ca",
      acmeLastError: null,
      notAfter: null,
    }),
    "ready",
  );
});

test("migrateLegacyPublicUrls backfills once and get/set still round-trip", async () => {
  const { db, hostnames, settings } = createMemoryDb();
  settings.push({
    key: PUBLIC_URLS_SETTING_KEY,
    value: " panel.example.com , https://other.example.com/ ",
  });

  assertEquals(await getPublicUrls(db), [
    "panel.example.com",
    "https://other.example.com",
  ]);
  assertEquals(hostnames.length, 2);
  assertEquals(hostnames.every((row) => row.source === "platform-ca"), true);

  await migrateLegacyPublicUrls(db);
  assertEquals(hostnames.length, 2);
  assertEquals(await getInstanceHostnamesLegacyShim(db), [
    "panel.example.com",
    "https://other.example.com",
  ]);

  await setPublicUrls(db, ["https://panel.example.com:9443"]);
  assertEquals(await getPublicUrls(db), ["https://panel.example.com:9443"]);
  assertEquals(hostnames.length, 1);
  const projected = settings.find((row) => row.key === PUBLIC_URLS_SETTING_KEY);
  assertEquals(projected?.value, ["https://panel.example.com:9443"]);
});

test("replaceInstanceHostnames rejects Let's Encrypt on a private name and keeps the prior set", async () => {
  const { db, hostnames } = createMemoryDb();
  await replacePublicUrlsWithPlatformCa(db, ["https://panel.example.com"]);
  const rejected = await replaceInstanceHostnames(db, [
    { host: "10.1.2.3", source: "lets-encrypt", uploadedCertId: null },
  ]);
  assertEquals(rejected.ok, false);
  if (!rejected.ok) assertEquals(rejected.invalid, ["10.1.2.3"]);
  assertEquals(hostnames.map((row) => row.host), ["https://panel.example.com"]);

  const wildcard = await replaceInstanceHostnames(db, [
    { host: "*.example.com", source: "lets-encrypt", uploadedCertId: null },
  ]);
  assertEquals(wildcard.ok, false);

  const missingCert = await replaceInstanceHostnames(db, [
    { host: "panel.example.com", source: "uploaded", uploadedCertId: null },
  ]);
  assertEquals(missingCert.ok, false);
});

test("recordInstanceAcmeIssuance updates the matching lets-encrypt hostname", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select() {
      return {
        from() {
          return {
            where: () =>
              Promise.resolve([{
                id: "row-1",
                host: "https://panel.example.com",
                source: "lets-encrypt",
              }]),
          };
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values);
          return { where: () => Promise.resolve() };
        },
      };
    },
  };
  await recordInstanceAcmeIssuance(db as unknown as Db, {
    hostname: "panel.example.com",
    ok: false,
    errorMessage: "tls alert",
    at: "2026-09-22T00:00:00.000Z",
  });
  assertEquals(updates, [{
    acmeLastAttemptAt: "2026-09-22T00:00:00.000Z",
    acmeLastError: "tls alert",
  }]);
});

test("recordInstanceAcmeIssuance stores notAfter only on success", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select() {
      return {
        from() {
          return {
            where: () =>
              Promise.resolve([{
                id: "row-1",
                host: "panel.example.com",
                source: "lets-encrypt",
              }]),
          };
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values);
          return { where: () => Promise.resolve() };
        },
      };
    },
  };
  await recordInstanceAcmeIssuance(db as unknown as Db, {
    hostname: "panel.example.com",
    ok: true,
    notAfter: "2027-01-01T00:00:00.000Z",
    at: "2026-09-22T00:00:00.000Z",
  });
  assertEquals(updates, [{
    acmeLastAttemptAt: "2026-09-22T00:00:00.000Z",
    acmeLastError: null,
    notAfter: "2027-01-01T00:00:00.000Z",
  }]);
});

test("instanceAcmeHttp01PreflightFailure parses only the preflight prefix", () => {
  assertEquals(instanceAcmeHttp01PreflightFailure("tls alert"), null);
  const parsed = instanceAcmeHttp01PreflightFailure(
    "Let's Encrypt HTTP-01 preflight failed for panel.example.com: http://panel.example.com/.well-known/acme-challenge/abc did not reach 127.0.0.1:8880 (HTTP 404)",
  );
  assertEquals(parsed?.hostname, "panel.example.com");
});

test("replaceInstanceHostnames clears notAfter when the source leaves Let's Encrypt", async () => {
  const { db, hostnames } = createMemoryDb();
  const saved = await replaceInstanceHostnames(db, [
    { host: "panel.example.com", source: "lets-encrypt", uploadedCertId: null },
  ]);
  assertEquals(saved.ok, true);
  const current = hostnames[0];
  if (!current) throw new TypeError("expected a hostname row");
  current.notAfter = "2027-01-01T00:00:00.000Z";
  const next = await replaceInstanceHostnames(db, [
    { host: "panel.example.com", source: "platform-ca", uploadedCertId: null },
  ]);
  assertEquals(next.ok, true);
  assertEquals(hostnames[0]?.notAfter, null);
  assertEquals(hostnames[0]?.source, "platform-ca");
});
