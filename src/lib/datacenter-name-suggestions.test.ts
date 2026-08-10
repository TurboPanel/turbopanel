import { assertEquals } from "@std/assert";
import {
  suggestDatacenterDisplayNameFromGeo,
  suggestDatacenterNames,
} from "./datacenter-name-suggestions.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("suggestDatacenterNames groups trusted geo and ASN metadata", () => {
  const suggestions = suggestDatacenterNames([
    {
      id: "a",
      name: null,
      hostname: null,
      datacenterId: null,
      metadata: {
        geo: {
          city: "Amsterdam",
          country: "NL",
          asn: 13335,
          asOrganization: "Cloudflare",
        },
      },
    },
    {
      id: "b",
      name: null,
      hostname: null,
      datacenterId: null,
      metadata: {
        geo: {
          city: "Amsterdam",
          country: "NL",
          asn: 13335,
          asOrganization: "Cloudflare",
        },
      },
    },
    {
      id: "c",
      name: null,
      hostname: null,
      datacenterId: null,
      metadata: {
        geo: {
          city: "Dallas",
          regionCode: "TX",
          country: "US",
          asn: 64500,
        },
      },
    },
  ]);

  assertEquals(suggestions, [
    {
      name: "Amsterdam NL - Cloudflare AS13335",
      serverCount: 2,
      serverIds: ["a", "b"],
      serverLabels: ["a", "b"],
      geo: {
        city: "Amsterdam",
        country: "NL",
        asn: 13335,
        asOrganization: "Cloudflare",
      },
    },
    {
      name: "Dallas TX - AS64500",
      serverCount: 1,
      serverIds: ["c"],
      serverLabels: ["c"],
      geo: {
        city: "Dallas",
        regionCode: "TX",
        country: "US",
        asn: 64500,
      },
    },
  ]);
});

test("suggestDatacenterNames emits names accepted by display-name validation", () => {
  const [suggestion] = suggestDatacenterNames([{
    id: "x",
    name: null,
    hostname: null,
    datacenterId: null,
    metadata: {
      geo: {
        city: "Montréal",
        country: "CA",
        asn: 64500,
        asOrganization: "Example, S.A. / Hosting",
      },
    },
  }]);

  assertEquals(
    suggestion?.name,
    "Montreal CA - Example S.A. Hosting AS64500",
  );
});

test("suggestDatacenterNames ignores absent or malformed geo and caps results", () => {
  const suggestions = suggestDatacenterNames([
    {
      id: "1",
      name: null,
      hostname: null,
      datacenterId: null,
      metadata: {},
    },
    {
      id: "2",
      name: null,
      hostname: null,
      datacenterId: null,
      metadata: { geo: { city: "" } },
    },
    {
      id: "3",
      name: null,
      hostname: null,
      datacenterId: null,
      metadata: { geo: { country: "US" } },
    },
    {
      id: "4",
      name: null,
      hostname: null,
      datacenterId: null,
      metadata: { geo: { country: "NL" } },
    },
  ], { limit: 1 });

  assertEquals(suggestions.length, 1);
  assertEquals(suggestions[0]?.name, "NL");
  assertEquals(suggestDatacenterNames([], { limit: 0 }), []);
});

test("suggestDatacenterDisplayNameFromGeo builds location and network labels", () => {
  assertEquals(
    suggestDatacenterDisplayNameFromGeo({
      city: "Dallas",
      regionCode: "TX",
      country: "US",
      asn: 64500,
      asOrganization: "Example ISP",
    }),
    "Dallas TX - Example ISP AS64500",
  );
  assertEquals(
    suggestDatacenterDisplayNameFromGeo({ country: "DE" }),
    "DE",
  );
  assertEquals(suggestDatacenterDisplayNameFromGeo({ city: "" }), null);
});

test("suggestDatacenterNames prefers name and hostname labels", () => {
  const [suggestion] = suggestDatacenterNames([
    {
      id: "srv-1",
      name: " Edge-1 ",
      hostname: "host-a",
      datacenterId: null,
      metadata: { geo: { country: "US", city: "Chicago" } },
    },
    {
      id: "srv-2",
      name: null,
      hostname: " host-b ",
      datacenterId: null,
      metadata: { geo: { country: "US", city: "Chicago" } },
    },
  ]);

  assertEquals(suggestion?.serverLabels, ["Edge-1", "host-b"]);
});

test("suggestDatacenterNames skips non-object metadata", () => {
  assertEquals(
    suggestDatacenterNames([
      {
        id: "bad",
        name: null,
        hostname: null,
        datacenterId: null,
        metadata: ["not", "geo"],
      },
    ]),
    [],
  );
});

test("suggestDatacenterNames can require unassigned hosts only", () => {
  const suggestions = suggestDatacenterNames([
    {
      id: "free",
      name: "Free",
      hostname: null,
      datacenterId: null,
      metadata: { geo: { country: "US", city: "Chicago" } },
    },
    {
      id: "taken",
      name: "Taken",
      hostname: null,
      datacenterId: "dc-1",
      metadata: { geo: { country: "US", city: "Chicago" } },
    },
  ], { unassignedOnly: true, limit: 10 });

  assertEquals(suggestions[0]?.serverIds, ["free"]);
});
