/**
 * Host-free coverage for organization route pure validation helpers.
 */

import { assertEquals } from "@std/assert";
import {
  applyManagedDefaultsPatch,
  defaultEnvironmentGetResponse,
  defaultEnvironmentPutResponse,
  defaultTimezoneGetResponse,
  defaultTimezonePutResponse,
  hostDefaultsGetResponse,
  hostDefaultsPutResponse,
  managedDefaultsGetResponse,
  managedDefaultsPutResponse,
  parseDefaultEnvironmentPutBody,
  parseDefaultTimezonePatch,
  parseHostDefaultsPatch,
  parseManagedDefaultsPatch,
  parseOrganizationCreateDisplayName,
  parseOrganizationPatchDisplayName,
  parseServerCapacityPutBody,
  parseTemperatureUnitPatch,
  temperatureUnitGetResponse,
  temperatureUnitPutResponse,
  toOrganizationRecord,
  validateManagedDefaults,
} from "./routes-helpers.ts";
import type { ManagedOrganizationDefaults } from "../../lib/managed/org-defaults.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseManagedDefaultsPatch accepts a mode or an explicit clear", () => {
  assertEquals(
    parseManagedDefaultsPatch({ sslMode: "verify-full" }),
    { ok: true, patch: { sslMode: "verify-full" } },
  );
  // `null` is how an operator returns the org to the platform default; it is
  // not the same as omitting the key, which is an empty patch.
  assertEquals(
    parseManagedDefaultsPatch({ sslMode: null }),
    { ok: true, patch: { sslMode: null } },
  );
  assertEquals(parseManagedDefaultsPatch({}).ok, false);
  // A typo must 400 rather than silently downgrade every inheriting service.
  assertEquals(
    parseManagedDefaultsPatch({ sslMode: "requrie" }),
    { ok: false, error: "Invalid sslMode", status: 400 },
  );
  assertEquals(parseManagedDefaultsPatch({ sslMode: true }).ok, false);
});

test("applyManagedDefaultsPatch preserves untouched sibling keys", () => {
  // The route writes the whole `managedDatabase` object back, so this merge is
  // the only thing keeping a future sibling key (ports) alive across a PUT that
  // only names sslMode.
  // `unrelated` stands in for a sibling key this helper does not know about,
  // so it has to be smuggled past the declared type on both sides.
  const current = {
    sslMode: "require" as const,
    unrelated: "keep-me",
  } as ManagedOrganizationDefaults;
  assertEquals(
    applyManagedDefaultsPatch(current, { sslMode: "verify-ca" }),
    {
      sslMode: "verify-ca",
      unrelated: "keep-me",
    } as ManagedOrganizationDefaults,
  );
  assertEquals(
    applyManagedDefaultsPatch(current, { sslMode: null }),
    { unrelated: "keep-me" } as ManagedOrganizationDefaults,
  );
  assertEquals(applyManagedDefaultsPatch({}, {}), {});
});

test("managed defaults responses separate configured from effective", () => {
  assertEquals(managedDefaultsGetResponse({}), {
    sslMode: null,
    effectiveSslMode: "require",
    ports: { postgres: null, mysqlFamily: null },
    effectivePorts: { postgres: 15432, mysqlFamily: 13306 },
  });
  assertEquals(managedDefaultsGetResponse({ sslMode: "prefer" }), {
    sslMode: "prefer",
    effectiveSslMode: "prefer",
    ports: { postgres: null, mysqlFamily: null },
    effectivePorts: { postgres: 15432, mysqlFamily: 13306 },
  });
  // One overridden family must not drag the other off its platform listener.
  assertEquals(managedDefaultsGetResponse({ ports: { postgres: 18432 } }), {
    sslMode: null,
    effectiveSslMode: "require",
    ports: { postgres: 18432, mysqlFamily: null },
    effectivePorts: { postgres: 18432, mysqlFamily: 13306 },
  });
  assertEquals(managedDefaultsPutResponse({ sslMode: "disable" }), {
    ok: true,
    sslMode: "disable",
    effectiveSslMode: "disable",
    ports: { postgres: null, mysqlFamily: null },
    effectivePorts: { postgres: 15432, mysqlFamily: 13306 },
  });
});

test("parseManagedDefaultsPatch names the offending listener port field", () => {
  assertEquals(
    parseManagedDefaultsPatch({ ports: { postgres: 18432 } }),
    { ok: true, patch: { ports: { postgres: 18432 } } },
  );
  // Clearing one family versus clearing the whole object are different edits.
  assertEquals(
    parseManagedDefaultsPatch({ ports: { mysqlFamily: null } }),
    { ok: true, patch: { ports: { mysqlFamily: null } } },
  );
  assertEquals(
    parseManagedDefaultsPatch({ ports: null }),
    { ok: true, patch: { ports: null } },
  );
  // The message has to say which family and why, or an operator cannot tell a
  // privileged port from a platform-reserved one.
  assertEquals(parseManagedDefaultsPatch({ ports: { postgres: 443 } }), {
    ok: false,
    error: "ports.postgres must be an integer between 1024 and 65535",
    status: 400,
  });
  assertEquals(parseManagedDefaultsPatch({ ports: { mysqlFamily: 6032 } }), {
    ok: false,
    error: "ports.mysqlFamily is reserved for the ProxySQL admin interface",
    status: 400,
  });
  assertEquals(parseManagedDefaultsPatch({ ports: { postgres: 45100 } }), {
    ok: false,
    error:
      "ports.postgres is reserved for managed member private listeners (45000-45999)",
    status: 400,
  });
  assertEquals(parseManagedDefaultsPatch({ ports: 15432 }).ok, false);
});

test("applyManagedDefaultsPatch merges listener ports per family", () => {
  const current: ManagedOrganizationDefaults = {
    ports: { postgres: 18432, mysqlFamily: 18306 },
  };
  assertEquals(
    applyManagedDefaultsPatch(current, { ports: { postgres: 19432 } }),
    { ports: { postgres: 19432, mysqlFamily: 18306 } },
  );
  assertEquals(
    applyManagedDefaultsPatch(current, { ports: { postgres: null } }),
    { ports: { mysqlFamily: 18306 } },
  );
  // Clearing the last family drops the whole object rather than persisting an
  // empty one, so the stored jsonb stays readable.
  assertEquals(
    applyManagedDefaultsPatch({ ports: { postgres: 18432 } }, {
      ports: { postgres: null },
    }),
    {},
  );
  assertEquals(applyManagedDefaultsPatch(current, { ports: null }), {});
  // sslMode and ports are independent keys on one object; editing one must not
  // disturb the other.
  assertEquals(
    applyManagedDefaultsPatch({ sslMode: "verify-full", ...current }, {
      sslMode: "prefer",
    }),
    { sslMode: "prefer", ports: { postgres: 18432, mysqlFamily: 18306 } },
  );
});

test("validateManagedDefaults catches a collision only visible after merge", () => {
  assertEquals(validateManagedDefaults({}), null);
  assertEquals(
    validateManagedDefaults({ ports: { postgres: 18432, mysqlFamily: 18306 } }),
    null,
  );
  // Two protocol modules on one port would leave ProxySQL half-bound. This is
  // reachable by overriding one family onto the other's inherited default, so
  // the per-field parser cannot see it.
  assertEquals(
    validateManagedDefaults({ ports: { postgres: 13306 } }),
    {
      ok: false,
      error:
        "ports.mysqlFamily must differ from the other protocol family's listener port",
      status: 400,
    },
  );
});

test("parseHostDefaultsPatch rejects empty and invalid patches", () => {
  assertEquals(parseHostDefaultsPatch({}).ok, false);
  assertEquals(
    parseHostDefaultsPatch({ sshPort: 0 }),
    { ok: false, error: "Invalid sshPort", status: 400 },
  );
  assertEquals(
    parseHostDefaultsPatch({ ntp: { servers: [] } }),
    { ok: false, error: "Invalid ntp", status: 400 },
  );
  assertEquals(
    parseHostDefaultsPatch({ defaultFabricEnabled: "yes" }),
    { ok: false, error: "Invalid defaultFabricEnabled", status: 400 },
  );
});

test("parseHostDefaultsPatch accepts sshPort, ntp, fabric default, and clears", () => {
  const port = parseHostDefaultsPatch({ sshPort: 2222 });
  if (!port.ok) {
    throw new TypeError("expected sshPort patch");
  }
  assertEquals(port.patch.sshPort, 2222);

  const clearPort = parseHostDefaultsPatch({ sshPort: null });
  if (!clearPort.ok) {
    throw new TypeError("expected sshPort clear");
  }
  assertEquals(clearPort.patch.sshPort, null);

  const ntp = parseHostDefaultsPatch({
    ntp: { enabled: true, servers: ["time.cloudflare.com"] },
    defaultFabricEnabled: true,
  });
  if (!ntp.ok) {
    throw new TypeError("expected ntp/fabric patch");
  }
  assertEquals(ntp.patch.ntp, {
    enabled: true,
    servers: ["time.cloudflare.com"],
  });
  assertEquals(ntp.patch.defaultFabricEnabled, true);
});

test("hostDefaultsGetResponse and PutResponse expose configured org values", () => {
  assertEquals(hostDefaultsGetResponse({}), {
    sshPort: null,
    ntp: null,
    defaultFabricEnabled: false,
  });
  assertEquals(
    hostDefaultsPutResponse({
      sshPort: 2222,
      ntp: { enabled: true },
      defaultFabricEnabled: true,
    }),
    {
      ok: true,
      sshPort: 2222,
      ntp: { enabled: true },
      defaultFabricEnabled: true,
    },
  );
});

test("parseDefaultTimezonePatch rejects empty and invalid patches", () => {
  assertEquals(parseDefaultTimezonePatch({}).ok, false);
  assertEquals(
    parseDefaultTimezonePatch({ defaultServerTimezone: "Not/AZone" }),
    { ok: false, error: "Invalid defaultServerTimezone", status: 400 },
  );
  assertEquals(
    parseDefaultTimezonePatch({ enforceServerTimezone: "yes" }),
    { ok: false, error: "Invalid enforceServerTimezone", status: 400 },
  );
});

test("parseDefaultTimezonePatch accepts null timezone and boolean enforcement", () => {
  const reset = parseDefaultTimezonePatch({ defaultServerTimezone: null });
  if (!reset.ok) {
    throw new TypeError("expected null timezone reset to succeed");
  }
  assertEquals(reset.patch.defaultServerTimezone, null);

  const enforce = parseDefaultTimezonePatch({
    defaultServerTimezone: "America/New_York",
    enforceServerTimezone: true,
  });
  if (!enforce.ok) {
    throw new TypeError("expected valid timezone patch");
  }
  assertEquals(enforce.patch.defaultServerTimezone, "America/New_York");
  assertEquals(enforce.patch.enforceServerTimezone, true);
});

test("parseTemperatureUnitPatch requires the field and validates the value", () => {
  assertEquals(parseTemperatureUnitPatch({}).ok, false);
  assertEquals(
    parseTemperatureUnitPatch({ temperatureUnit: "kelvin" }),
    { ok: false, error: "Invalid temperatureUnit", status: 400 },
  );
  assertEquals(
    parseTemperatureUnitPatch({ temperatureUnit: "fahrenheit" }),
    { ok: true, patch: { temperatureUnit: "fahrenheit" } },
  );
});

test("temperature unit response shapers", () => {
  assertEquals(temperatureUnitGetResponse({}), { temperatureUnit: "celsius" });
  assertEquals(
    temperatureUnitGetResponse({ temperatureUnit: "fahrenheit" }),
    { temperatureUnit: "fahrenheit" },
  );
  assertEquals(
    temperatureUnitPutResponse({ temperatureUnit: "fahrenheit" }),
    { ok: true, temperatureUnit: "fahrenheit" },
  );
});

test("parseDefaultEnvironmentPutBody requires field and validates names", () => {
  assertEquals(parseDefaultEnvironmentPutBody({}).ok, false);
  assertEquals(
    parseDefaultEnvironmentPutBody({ defaultEnvironmentName: "" }).ok,
    false,
  );
  assertEquals(
    parseDefaultEnvironmentPutBody({ defaultEnvironmentName: "bad\nname" }).ok,
    false,
  );
  assertEquals(
    parseDefaultEnvironmentPutBody({ defaultEnvironmentName: "bad/name" }).ok,
    true,
  );

  const ok = parseDefaultEnvironmentPutBody({
    defaultEnvironmentName: " Staging ",
  });
  if (!ok.ok) {
    throw new TypeError("expected valid default environment name");
  }
  assertEquals(ok.defaultEnvironmentName, "Staging");

  const reset = parseDefaultEnvironmentPutBody({
    defaultEnvironmentName: null,
  });
  if (!reset.ok) {
    throw new TypeError("expected null default environment reset");
  }
  assertEquals(reset.defaultEnvironmentName, null);
});

test("parseServerCapacityPutBody requires maxServers and validates values", () => {
  assertEquals(parseServerCapacityPutBody({}).ok, false);
  assertEquals(parseServerCapacityPutBody({ maxServers: -1 }).ok, false);
  assertEquals(parseServerCapacityPutBody({ maxServers: 1.5 }).ok, false);

  const unlimited = parseServerCapacityPutBody({ maxServers: null });
  if (!unlimited.ok) {
    throw new TypeError("expected null maxServers");
  }
  assertEquals(unlimited.maxServers, null);

  const capped = parseServerCapacityPutBody({ maxServers: 3 });
  if (!capped.ok) {
    throw new TypeError("expected integer maxServers");
  }
  assertEquals(capped.maxServers, 3);
});

test("parseOrganizationCreateDisplayName defaults when name is absent", () => {
  const defaultName = parseOrganizationCreateDisplayName({});
  if (!defaultName.ok) {
    throw new TypeError("expected default organization name");
  }
  assertEquals(defaultName.name, "New Organization");

  const apostrophe = parseOrganizationCreateDisplayName({
    name: "O'Reilly",
  });
  if (!apostrophe.ok) {
    throw new TypeError("expected apostrophe organization name");
  }
  assertEquals(apostrophe.name, "O'Reilly");

  const unicode = parseOrganizationCreateDisplayName({
    name: "Müller GmbH",
  });
  if (!unicode.ok) {
    throw new TypeError("expected Unicode organization name");
  }
  assertEquals(unicode.name, "Müller GmbH");

  // Control characters are rejected (wire field is validated, not ignored).
  const rejected = parseOrganizationCreateDisplayName({
    name: "bad\nname",
  });
  if (rejected.ok) {
    throw new TypeError("expected invalid name to be rejected");
  }
  assertEquals(rejected.status, 400);
});

test("parseOrganizationPatchDisplayName requires a valid display name", () => {
  assertEquals(parseOrganizationPatchDisplayName({}).ok, false);
  assertEquals(
    parseOrganizationPatchDisplayName({ name: "" }).ok,
    false,
  );
  assertEquals(
    parseOrganizationPatchDisplayName({ name: "bad\nname" }).ok,
    false,
  );
  assertEquals(
    parseOrganizationPatchDisplayName({ name: null }).ok,
    false,
  );

  const ok = parseOrganizationPatchDisplayName({
    name: " O'Reilly ",
  });
  if (!ok.ok) {
    throw new TypeError("expected apostrophe organization name");
  }
  assertEquals(ok.name, "O'Reilly");

  const folded = parseOrganizationPatchDisplayName({
    name: "McDonald\u2019s",
  });
  if (!folded.ok) {
    throw new TypeError("expected folded curly apostrophe");
  }
  assertEquals(folded.name, "McDonald's");
});

test("toOrganizationRecord maps DB name to name", () => {
  assertEquals(
    toOrganizationRecord({
      id: "11111111-1111-1111-1111-111111111111",
      name: "Acme",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    {
      id: "11111111-1111-1111-1111-111111111111",
      name: "Acme",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  );
});

test("default timezone and environment response shapers", () => {
  assertEquals(defaultTimezoneGetResponse({}), {
    defaultServerTimezone: null,
    enforceServerTimezone: false,
  });
  assertEquals(
    defaultTimezoneGetResponse({
      defaultServerTimezone: "UTC",
      enforceServerTimezone: true,
    }),
    { defaultServerTimezone: "UTC", enforceServerTimezone: true },
  );
  assertEquals(defaultTimezonePutResponse({ defaultServerTimezone: null }), {
    ok: true,
    defaultServerTimezone: null,
    enforceServerTimezone: false,
  });
  assertEquals(defaultEnvironmentGetResponse({}), {
    defaultEnvironmentName: null,
  });
  assertEquals(
    defaultEnvironmentPutResponse({ defaultEnvironmentName: "Staging" }),
    { ok: true, defaultEnvironmentName: "Staging" },
  );
});
