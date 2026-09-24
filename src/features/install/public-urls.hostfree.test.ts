/**
 * Pure public-URL parsers (Deno LCOV). Storage round-trip lives in
 * `instance-hostnames.hostfree.test.ts`.
 */

import { assertEquals } from "@std/assert";
import {
  hostFromPublicUrlEntry,
  parsePublicUrlEntries,
  publicUrlEntryToInstallOrigin,
} from "./public-urls.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("hostFromPublicUrlEntry extracts host and rejects invalids", () => {
  assertEquals(hostFromPublicUrlEntry(""), null);
  assertEquals(
    hostFromPublicUrlEntry("https://panel.example.com"),
    "panel.example.com",
  );
  assertEquals(
    hostFromPublicUrlEntry("panel.example.com:8443"),
    "panel.example.com",
  );
  assertEquals(hostFromPublicUrlEntry("https://[2001:db8::1]"), "2001:db8::1");
  assertEquals(hostFromPublicUrlEntry("localhost"), null);
  assertEquals(hostFromPublicUrlEntry("not a url"), null);
  assertEquals(hostFromPublicUrlEntry("https://null"), null);
});

test("publicUrlEntryToInstallOrigin https bare host and http allowance", () => {
  assertEquals(publicUrlEntryToInstallOrigin(""), null);
  assertEquals(
    publicUrlEntryToInstallOrigin("https://panel.example.com/"),
    "https://panel.example.com:8443",
  );
  assertEquals(
    publicUrlEntryToInstallOrigin("https://panel.example.com:443"),
    "https://panel.example.com:8443",
  );
  assertEquals(
    publicUrlEntryToInstallOrigin("http://dev.example.com"),
    null,
  );
  assertEquals(
    publicUrlEntryToInstallOrigin("panel.example.com"),
    "https://panel.example.com:8443",
  );
  assertEquals(
    publicUrlEntryToInstallOrigin("https://[2001:db8::1]:9443"),
    "https://[2001:db8::1]:8443",
  );
  assertEquals(
    publicUrlEntryToInstallOrigin("https://[2001:db8::1]"),
    "https://[2001:db8::1]:8443",
  );
  assertEquals(
    publicUrlEntryToInstallOrigin("[2001:db8::1]"),
    "https://[2001:db8::1]:8443",
  );
  assertEquals(
    publicUrlEntryToInstallOrigin("https://panel.example.com:9443"),
    "https://panel.example.com:8443",
  );
  assertEquals(
    publicUrlEntryToInstallOrigin("ftp://panel.example.com"),
    null,
  );
  assertEquals(
    publicUrlEntryToInstallOrigin("https://localhost"),
    null,
  );
  assertEquals(
    publicUrlEntryToInstallOrigin("https://user:pass@panel.example.com"),
    null,
  );
  assertEquals(
    publicUrlEntryToInstallOrigin("https://panel.example.com/path"),
    null,
  );
  assertEquals(
    publicUrlEntryToInstallOrigin("https://panel.example.com?q=1"),
    null,
  );
  assertEquals(
    publicUrlEntryToInstallOrigin("https://panel.example.com#hash"),
    null,
  );
  assertEquals(publicUrlEntryToInstallOrigin("panel.example.com/path"), null);
  assertEquals(publicUrlEntryToInstallOrigin("panel.example.com?q=1"), null);
  assertEquals(publicUrlEntryToInstallOrigin("host with spaces"), null);
});

test("parsePublicUrlEntries validates dedupes and reports invalids", () => {
  assertEquals(parsePublicUrlEntries([]), { ok: true, urls: [] });
  assertEquals(
    parsePublicUrlEntries(["https://a.example.com", "https://a.example.com/"]),
    { ok: true, urls: ["https://a.example.com:8443"] },
  );
  const invalid = parsePublicUrlEntries([
    "localhost",
    "https://ok.example.com",
  ]);
  assertEquals(invalid.ok, false);
  if (!invalid.ok) {
    assertEquals(invalid.invalid, ["localhost"]);
  }
  assertEquals(
    parsePublicUrlEntries(["http://dev.example.com"]).ok,
    false,
  );
  const blanks = parsePublicUrlEntries(["", "  ", "panel.example.com:9443"]);
  assertEquals(blanks.ok, false);
  if (!blanks.ok) {
    assertEquals(blanks.invalid, ["", "  "]);
  }
  assertEquals(
    parsePublicUrlEntries(["[2001:db8::1]:8443"]),
    { ok: true, urls: ["[2001:db8::1]:8443"] },
  );
  assertEquals(
    parsePublicUrlEntries(["https://[2001:db8::1]"]),
    { ok: true, urls: ["https://[2001:db8::1]:8443"] },
  );
  assertEquals(
    parsePublicUrlEntries(["[2001:db8::1]"]),
    { ok: true, urls: ["[2001:db8::1]"] },
  );
  assertEquals(
    parsePublicUrlEntries(["https://panel.example.com:9443"]),
    { ok: true, urls: ["https://panel.example.com:8443"] },
  );
  assertEquals(
    parsePublicUrlEntries(["https://user:pass@panel.example.com"]).ok,
    false,
  );
  assertEquals(
    parsePublicUrlEntries(["ftp://panel.example.com", "panel.example.com/path"])
      .ok,
    false,
  );
  // Bare host and https origin that share an install origin dedupe.
  assertEquals(
    parsePublicUrlEntries([
      "panel.example.com:8443",
      "https://panel.example.com:8443",
    ]),
    { ok: true, urls: ["panel.example.com:8443"] },
  );
});
