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
  assertEquals(geoEquals(null, null), true);
  assertEquals(geoEquals(undefined, undefined), true);
});

test("extractCloudflareGeo returns null when cf has no usable geo fields", () => {
  assertEquals(extractCloudflareGeo({}), null);
  assertEquals(extractCloudflareGeo({ country: "  " }), null);
});

test("extractCloudflareGeo maps the full string field set", () => {
  const geo = extractCloudflareGeo({
    asOrganization: " Example ISP ",
    country: "US",
    city: "Austin",
    continent: "NA",
    region: "Texas",
    regionCode: "TX",
    timezone: "America/Chicago",
    longitude: "-97.7",
    latitude: "30.2",
    postalCode: "78701",
    metroCode: "635",
    colo: "DFW",
    asn: 64500,
  });
  assertEquals(geo?.asOrganization, "Example ISP");
  assertEquals(geo?.country, "US");
  assertEquals(geo?.city, "Austin");
  assertEquals(geo?.continent, "NA");
  assertEquals(geo?.region, "Texas");
  assertEquals(geo?.regionCode, "TX");
  assertEquals(geo?.timezone, "America/Chicago");
  assertEquals(geo?.longitude, "-97.7");
  assertEquals(geo?.latitude, "30.2");
  assertEquals(geo?.postalCode, "78701");
  assertEquals(geo?.metroCode, "635");
  assertEquals(geo?.datacenter, "DFW");
  assertEquals(geo?.asn, 64500);
  assertEquals(typeof geo?.capturedAt, "string");
});

test("parseServerGeo rejects non-records and empty payloads", () => {
  assertEquals(parseServerGeo(null), null);
  assertEquals(parseServerGeo([]), null);
  assertEquals(parseServerGeo({ country: "" }), null);
});
