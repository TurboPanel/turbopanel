/**
 * Host-free coverage for organization route pure validation helpers.
 */

import { assertEquals } from "jsr:@std/assert";
import {
  defaultEnvironmentGetResponse,
  defaultEnvironmentPutResponse,
  defaultTimezoneGetResponse,
  defaultTimezonePutResponse,
  parseDefaultEnvironmentPutBody,
  parseDefaultTimezonePatch,
  parseOrganizationCreateDisplayName,
  parseOrganizationPatchDisplayName,
  parseServerCapacityPutBody,
  toOrganizationRecord,
} from "./routes-helpers.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

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

test("parseOrganizationCreateDisplayName defaults when displayName is absent", () => {
  const defaultName = parseOrganizationCreateDisplayName({});
  if (!defaultName.ok) {
    throw new TypeError("expected default organization name");
  }
  assertEquals(defaultName.displayName, "New Organization");

  const apostrophe = parseOrganizationCreateDisplayName({
    displayName: "O'Reilly",
  });
  if (!apostrophe.ok) {
    throw new TypeError("expected apostrophe organization name");
  }
  assertEquals(apostrophe.displayName, "O'Reilly");

  const unicode = parseOrganizationCreateDisplayName({
    displayName: "Müller GmbH",
  });
  if (!unicode.ok) {
    throw new TypeError("expected Unicode organization name");
  }
  assertEquals(unicode.displayName, "Müller GmbH");

  // Control characters are rejected (wire field is validated, not ignored).
  const rejected = parseOrganizationCreateDisplayName({
    displayName: "bad\nname",
  });
  if (rejected.ok) {
    throw new TypeError("expected invalid displayName to be rejected");
  }
  assertEquals(rejected.status, 400);
});

test("parseOrganizationPatchDisplayName requires a valid display name", () => {
  assertEquals(parseOrganizationPatchDisplayName({}).ok, false);
  assertEquals(
    parseOrganizationPatchDisplayName({ displayName: "" }).ok,
    false,
  );
  assertEquals(
    parseOrganizationPatchDisplayName({ displayName: "bad\nname" }).ok,
    false,
  );
  assertEquals(
    parseOrganizationPatchDisplayName({ displayName: null }).ok,
    false,
  );

  const ok = parseOrganizationPatchDisplayName({
    displayName: " O'Reilly ",
  });
  if (!ok.ok) {
    throw new TypeError("expected apostrophe organization name");
  }
  assertEquals(ok.displayName, "O'Reilly");

  const folded = parseOrganizationPatchDisplayName({
    displayName: "McDonald\u2019s",
  });
  if (!folded.ok) {
    throw new TypeError("expected folded curly apostrophe");
  }
  assertEquals(folded.displayName, "McDonald's");
});

test("toOrganizationRecord maps name to displayName", () => {
  assertEquals(
    toOrganizationRecord({
      id: "11111111-1111-1111-1111-111111111111",
      name: "Acme",
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    {
      id: "11111111-1111-1111-1111-111111111111",
      displayName: "Acme",
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
