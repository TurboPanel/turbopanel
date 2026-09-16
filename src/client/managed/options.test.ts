import { assertEquals } from "@std/assert";
import { postgresEngineSpec } from "../../lib/managed/postgres.ts";
import {
  type ManagedRowOptions,
  parseManagedRowOptions,
  writeManagedRowOptions,
} from "./options.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function defaultSettings(): ManagedRowOptions["settings"] {
  const settings = postgresEngineSpec.parseSettings(
    postgresEngineSpec.defaultSettings,
  );
  if (!settings) {
    throw new TypeError("failed to parse default postgres settings");
  }
  return settings;
}

test("parseManagedRowOptions rejects non-objects", () => {
  assertEquals(parseManagedRowOptions(postgresEngineSpec, null), null);
  assertEquals(parseManagedRowOptions(postgresEngineSpec, []), null);
  assertEquals(parseManagedRowOptions(postgresEngineSpec, "x"), null);
});

test("parseManagedRowOptions rejects invalid settings", () => {
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      settings: { image: "" },
      databases: ["postgres"],
    }),
    null,
  );
});

test("parseManagedRowOptions rejects invalid database names", () => {
  const settings = defaultSettings();
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      settings,
      databases: [123],
    }),
    null,
  );
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      settings,
      databases: ["  "],
    }),
    null,
  );
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      settings,
      databases: ["bad-name-with-hyphen"],
    }),
    null,
  );
  assertEquals(
    parseManagedRowOptions(postgresEngineSpec, {
      settings,
      databases: "postgres",
    }),
    null,
  );
});

test("parseManagedRowOptions parses settings and databases", () => {
  const settings = defaultSettings();
  const parsed = parseManagedRowOptions(postgresEngineSpec, {
    settings,
    databases: ["postgres", " app "],
  });
  assertEquals(parsed, {
    settings,
    databases: ["postgres", "app"],
  });
});

test("writeManagedRowOptions round-trips settings and databases", () => {
  const options: ManagedRowOptions = {
    settings: defaultSettings(),
    databases: ["postgres", "app"],
  };
  assertEquals(writeManagedRowOptions(options), {
    settings: options.settings,
    databases: options.databases,
  });
});
