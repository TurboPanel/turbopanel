import { assertEquals } from "@std/assert";
import { suggestDatacenterNames } from "./datacenter-name-suggestions.ts";

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
      displayName: null,
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
      displayName: null,
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
      displayName: null,
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
      displayName: "Amsterdam NL - Cloudflare AS13335",
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
      displayName: "Dallas TX - AS64500",
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
    displayName: null,
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
    suggestion?.displayName,
    "Montreal CA - Example S.A. Hosting AS64500",
  );
});

test("suggestDatacenterNames ignores absent or malformed geo and caps results", () => {
  const suggestions = suggestDatacenterNames([
    {
      id: "1",
      displayName: null,
      hostname: null,
      datacenterId: null,
      metadata: {},
    },
    {
      id: "2",
      displayName: null,
      hostname: null,
      datacenterId: null,
      metadata: { geo: { city: "" } },
    },
    {
      id: "3",
      displayName: null,
      hostname: null,
      datacenterId: null,
      metadata: { geo: { country: "US" } },
    },
    {
      id: "4",
      displayName: null,
      hostname: null,
      datacenterId: null,
      metadata: { geo: { country: "NL" } },
    },
  ], { limit: 1 });

  assertEquals(suggestions.length, 1);
  assertEquals(suggestions[0]?.displayName, "NL");
  assertEquals(suggestDatacenterNames([], { limit: 0 }), []);
});

test("suggestDatacenterNames can require unassigned hosts only", () => {
  const suggestions = suggestDatacenterNames([
    {
      id: "free",
      displayName: "Free",
      hostname: null,
      datacenterId: null,
      metadata: { geo: { country: "US", city: "Chicago" } },
    },
    {
      id: "taken",
      displayName: "Taken",
      hostname: null,
      datacenterId: "dc-1",
      metadata: { geo: { country: "US", city: "Chicago" } },
    },
  ], { unassignedOnly: true, limit: 10 });

  assertEquals(suggestions[0]?.serverIds, ["free"]);
});
