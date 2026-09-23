/**
 * Instance ACME settings round-trip and the encryption gate.
 */

import { assertEquals } from "@std/assert";
import type { Db } from "../../db/connection.ts";
import { setting } from "../../db/schema.ts";
import {
  instanceAcmeSettingsToApiShape,
  instanceAcmeUpdatesRequireEncryption,
  resolveInstanceAcmeSettings,
  updateInstanceAcmeSettings,
} from "./instance-acme-settings.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type MemRow = { key: string; value: unknown };

function createSettingsDb(): Db {
  const settings: MemRow[] = [];
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve(settings.map((row) => ({ ...row })));
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(value: MemRow) {
          const promise = Promise.resolve().then(() => {
            if (table !== setting) return;
            const index = settings.findIndex((item) => item.key === value.key);
            if (index >= 0) settings[index] = value;
            else settings.push(value);
          });
          return Object.assign(promise, {
            onConflictDoUpdate() {
              return promise;
            },
          });
        },
      };
    },
  };
  return db as unknown as Db;
}

test("instance ACME settings round-trip and reject a bad directory", async () => {
  const db = createSettingsDb();
  const updated = await updateInstanceAcmeSettings(db, {}, {
    contactEmail: "ops@example.com",
    tosAccepted: "true",
    useStaging: "false",
  });
  assertEquals(updated.ok, true);
  if (!updated.ok) return;
  assertEquals(updated.settings.contactEmail, "ops@example.com");
  assertEquals(updated.settings.tosAccepted, true);
  assertEquals(updated.settings.useStaging, false);

  const again = await resolveInstanceAcmeSettings(db, {});
  assertEquals(again.contactEmail, "ops@example.com");
  const api = instanceAcmeSettingsToApiShape(again);
  const contact = api.TURBOPANEL_INSTANCE_ACME__CONTACT_EMAIL;
  assertEquals(contact?.value, "ops@example.com");
  assertEquals(contact?.source, "db");

  const bad = await updateInstanceAcmeSettings(db, {}, {
    DIRECTORY_URL: "http://example.com/directory",
  });
  assertEquals(bad.ok, false);

  const stored = await resolveInstanceAcmeSettings(db, {});
  assertEquals(stored.contactEmail, "ops@example.com");
});

test("instance ACME updates do not require encryption", async () => {
  assertEquals(
    instanceAcmeUpdatesRequireEncryption({
      CONTACT_EMAIL: "ops@example.com",
      TOS_ACCEPTED: "true",
    }),
    false,
  );
  assertEquals(
    instanceAcmeUpdatesRequireEncryption({
      CONTACT_EMAIL: null,
    }),
    false,
  );

  const db = createSettingsDb();
  const updated = await updateInstanceAcmeSettings(
    db,
    {},
    { CONTACT_EMAIL: "ops@example.com" },
  );
  assertEquals(updated.ok, true);
});
