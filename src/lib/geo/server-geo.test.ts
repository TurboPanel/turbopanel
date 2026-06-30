import { assertEquals } from "jsr:@std/assert";
import {
  extractCloudflareGeo,
  geoEquals,
  parseServerGeo,
} from "./server-geo.ts";

Deno.test("extractCloudflareGeo maps cf.colo to datacenter", () => {
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

Deno.test("parseServerGeo accepts legacy colo field as datacenter", () => {
  assertEquals(parseServerGeo({ country: "US", colo: "AMS" }), {
    country: "US",
    datacenter: "AMS",
  });
});

Deno.test("geoEquals ignores capturedAt", () => {
  assertEquals(
    geoEquals(
      { country: "US", capturedAt: "2020-01-01T00:00:00.000Z" },
      { country: "US", capturedAt: "2020-06-01T00:00:00.000Z" },
    ),
    true,
  );
});
