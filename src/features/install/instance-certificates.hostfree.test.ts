/**
 * Certificate upload validation: SAN coverage and key/cert mismatch.
 */

import { assertEquals } from "@std/assert";
import type { Db } from "../../db/connection.ts";
import {
  instanceHostname,
  instanceUploadedCertificate,
  setting,
} from "../../db/schema.ts";
import { isSealedEnvelope } from "../../lib/secrets/data-encryption.ts";
import { deriveEncryptionSecretsConfig } from "../../lib/secrets/secrets.ts";
import { mintSelfSignedCertificate } from "../../lib/tls/self-signed.ts";
import { parseTestSecretsConfig } from "../../test-fixtures/secrets.ts";
import {
  attachUploadedCertificateToHostnames,
  listUploadedCertificates,
  storeUploadedCertificate,
  validateCertificateUpload,
} from "./instance-certificates.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type MemRow = Record<string, unknown> & { key?: string; id?: string };

function createMemoryDb(): { db: Db; certificates: MemRow[] } {
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
      row.id = typeof row.id === "string" ? row.id : crypto.randomUUID();
      certificates.push(row);
      return { id: row.id };
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
          });
        },
      };
    },
    transaction(fn: (tx: Db) => Promise<unknown>) {
      return fn(db as unknown as Db);
    },
  };

  return { db: db as unknown as Db, certificates };
}

async function secrets() {
  return await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig("deno"),
    "data-encryption",
  );
}

test("validateCertificateUpload accepts a matching pair and rejects a mismatched key", async () => {
  const leaf = await mintSelfSignedCertificate([
    "panel.example.com",
    "*.example.com",
  ]);
  const other = await mintSelfSignedCertificate(["other.example.com"]);

  const ok = await validateCertificateUpload(
    leaf.certificatePem,
    leaf.privateKeyPem,
  );
  assertEquals(ok.ok, true);
  if (ok.ok) {
    assertEquals(ok.dnsNames.includes("panel.example.com"), true);
    assertEquals(ok.hasWildcard, true);
    assertEquals(ok.fingerprintSha256.length > 0, true);
  }

  const mismatch = await validateCertificateUpload(
    leaf.certificatePem,
    other.privateKeyPem,
  );
  assertEquals(mismatch.ok, false);

  const garbage = await validateCertificateUpload(
    "not a certificate",
    leaf.privateKeyPem,
  );
  assertEquals(garbage.ok, false);
});

test("storeUploadedCertificate seals the key and attach checks SAN coverage", async () => {
  const { db, certificates } = createMemoryDb();
  const leaf = await mintSelfSignedCertificate(["panel.example.com"]);
  const stored = await storeUploadedCertificate(db, await secrets(), {
    label: "panel",
    certPem: leaf.certificatePem,
    keyPem: leaf.privateKeyPem,
  });
  assertEquals(stored.ok, true);
  if (!stored.ok) return;
  assertEquals(isSealedEnvelope(String(certificates[0]?.keyPem)), true);

  const listed = await listUploadedCertificates(db);
  assertEquals(listed[0]?.dnsNames, ["panel.example.com"]);
  assertEquals("keyPem" in (listed[0] ?? {}), false);

  const missed = await attachUploadedCertificateToHostnames(db, stored.id, [
    "other.example.com",
  ]);
  assertEquals(missed.ok, false);
  if (!missed.ok) assertEquals(missed.error.includes("does not cover"), true);

  const attached = await attachUploadedCertificateToHostnames(db, stored.id, [
    "https://panel.example.com",
  ]);
  assertEquals(attached.ok, true);
  if (attached.ok) {
    assertEquals(attached.hostnames, ["https://panel.example.com:8443"]);
  }

  const after = await listUploadedCertificates(db);
  assertEquals(after[0]?.hostnames, ["https://panel.example.com:8443"]);
});
