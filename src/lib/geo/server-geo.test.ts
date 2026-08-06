import { assertEquals } from "jsr:@std/assert";
import {
  extractCloudflareGeo,
  geoEquals,
  parseServerGeo,
} from "./server-geo.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test("extractCloudflareGeo maps cf.colo to datacenter", () => {
  const geo = extractCloudflareGeo({
    country: "US",
    city: "Austin",
    colo: "DFW",
  });

  assertEquals(geo, {
    country: "US",
    city: "Austin",
    datacenter: "DFW",
    capturedAt: geo?.capturedAt,
  });
});

test("parseServerGeo ignores legacy colo field", () => {
  assertEquals(parseServerGeo({ country: "US", colo: "AMS" }), {
    country: "US",
  });
});

test("geoEquals ignores capturedAt", () => {
  assertEquals(
    geoEquals(
      { country: "US", capturedAt: "2020-01-01T00:00:00.000Z" },
      { country: "US", capturedAt: "2020-06-01T00:00:00.000Z" },
    ),
    true,
  );
});

test("parseServerGeo preserves capturedAt and numeric asn", () => {
  assertEquals(
    parseServerGeo({
      country: "US",
      asn: "64500",
      capturedAt: " 2026-01-01T00:00:00.000Z ",
    }),
    {
      country: "US",
      asn: 64500,
      capturedAt: "2026-01-01T00:00:00.000Z",
    },
  );
});

test("extractCloudflareGeo returns null for non-records", () => {
  assertEquals(extractCloudflareGeo(null), null);
  assertEquals(extractCloudflareGeo("nope"), null);
});

test("geoEquals detects field differences", () => {
  assertEquals(geoEquals({ country: "US" }, { country: "CA" }), false);
  assertEquals(geoEquals(null, { country: "US" }), false);
});
