import { assertEquals } from "@std/assert";
import {
  DEFAULT_SSH_PORT,
  parseDefaultFabricEnabledInput,
  parseNtpDefaults,
  parseNtpDefaultsInput,
  parseSshPort,
  parseSshPortInput,
  resolveEffectiveNtpDefaults,
  resolveEffectiveSshPort,
} from "./host-defaults.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseSshPortInput accepts TCP ports and null clear", () => {
  assertEquals(parseSshPortInput(null), { ok: true, value: null });
  assertEquals(parseSshPortInput(22), { ok: true, value: 22 });
  assertEquals(parseSshPortInput(2222), { ok: true, value: 2222 });
  assertEquals(parseSshPortInput(65535), { ok: true, value: 65535 });
  assertEquals(parseSshPortInput(1), { ok: true, value: 1 });
});

test("parseSshPortInput rejects out of range and non-integers", () => {
  assertEquals(parseSshPortInput(0).ok, false);
  assertEquals(parseSshPortInput(65536).ok, false);
  assertEquals(parseSshPortInput(22.5).ok, false);
  assertEquals(parseSshPortInput("2222").ok, false);
  assertEquals(parseSshPortInput(undefined).ok, false);
});

test("parseSshPort omits invalid jsonb values", () => {
  assertEquals(parseSshPort(2222), 2222);
  assertEquals(parseSshPort(null), undefined);
  assertEquals(parseSshPort("22"), undefined);
  assertEquals(parseSshPort(0), undefined);
});

test("parseNtpDefaultsInput accepts a full object, enabled-only, and null", () => {
  assertEquals(parseNtpDefaultsInput(null), { ok: true, value: null });
  assertEquals(parseNtpDefaultsInput({ enabled: true }), {
    ok: true,
    value: { enabled: true },
  });
  assertEquals(
    parseNtpDefaultsInput({
      enabled: false,
      servers: ["time.cloudflare.com"],
      fallbackServers: ["pool.ntp.org"],
    }),
    {
      ok: true,
      value: {
        enabled: false,
        servers: ["time.cloudflare.com"],
        fallbackServers: ["pool.ntp.org"],
      },
    },
  );
});

test("parseNtpDefaultsInput rejects empty objects and invalid hosts", () => {
  assertEquals(parseNtpDefaultsInput({}).ok, false);
  assertEquals(parseNtpDefaultsInput({ servers: [] }).ok, false);
  assertEquals(parseNtpDefaultsInput({ servers: ["not a host"] }).ok, false);
  assertEquals(parseNtpDefaultsInput({ enabled: "yes" }).ok, false);
  assertEquals(parseNtpDefaultsInput([]).ok, false);
});

test("parseNtpDefaults is lenient on jsonb reads", () => {
  assertEquals(parseNtpDefaults(null), undefined);
  assertEquals(parseNtpDefaults({ enabled: true, servers: ["bad host"] }), {
    enabled: true,
  });
  assertEquals(
    parseNtpDefaults({ servers: ["time.google.com"] }),
    { servers: ["time.google.com"] },
  );
});

test("parseDefaultFabricEnabledInput accepts boolean and null", () => {
  assertEquals(parseDefaultFabricEnabledInput(true), {
    ok: true,
    value: true,
  });
  assertEquals(parseDefaultFabricEnabledInput(false), {
    ok: true,
    value: false,
  });
  assertEquals(parseDefaultFabricEnabledInput(null), {
    ok: true,
    value: null,
  });
  assertEquals(parseDefaultFabricEnabledInput("yes").ok, false);
});

test("resolveEffectiveSshPort prefers server then datacenter then org then 22", () => {
  assertEquals(
    resolveEffectiveSshPort(
      { sshPort: 2200 },
      { sshPort: 2222 },
      { sshPort: 22022 },
    ),
    { sshPort: 2200, source: "server" },
  );
  assertEquals(
    resolveEffectiveSshPort({}, { sshPort: 2222 }, { sshPort: 22022 }),
    { sshPort: 2222, source: "datacenter" },
  );
  assertEquals(
    resolveEffectiveSshPort({}, {}, { sshPort: 22022 }),
    { sshPort: 22022, source: "organization" },
  );
  assertEquals(resolveEffectiveSshPort({}, {}, {}), {
    sshPort: DEFAULT_SSH_PORT,
    source: null,
  });
});

test("resolveEffectiveNtpDefaults prefers the most specific configured layer", () => {
  const serverNtp = { enabled: false };
  const dcNtp = { enabled: true, servers: ["time.cloudflare.com"] };
  const orgNtp = { enabled: true, servers: ["pool.ntp.org"] };
  assertEquals(
    resolveEffectiveNtpDefaults(
      { ntp: serverNtp },
      { ntp: dcNtp },
      { ntp: orgNtp },
    ),
    { ntp: serverNtp, source: "server" },
  );
  assertEquals(
    resolveEffectiveNtpDefaults({}, { ntp: dcNtp }, { ntp: orgNtp }),
    { ntp: dcNtp, source: "datacenter" },
  );
  assertEquals(
    resolveEffectiveNtpDefaults({}, {}, { ntp: orgNtp }),
    { ntp: orgNtp, source: "organization" },
  );
  assertEquals(resolveEffectiveNtpDefaults({}, {}, {}), {
    ntp: null,
    source: null,
  });
});
