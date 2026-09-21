import { assertEquals } from "@std/assert";
import {
  mergeRelayPolicyOptions,
  parseFabricPolicy,
  parseRelayPolicy,
  resolveEffectiveAllowRelay,
} from "./policy.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseFabricPolicy defaults allowRelay to false", () => {
  assertEquals(parseFabricPolicy(null), { allowRelay: false });
  assertEquals(parseFabricPolicy(undefined), { allowRelay: false });
  assertEquals(parseFabricPolicy({}), { allowRelay: false });
  assertEquals(parseFabricPolicy({ allowRelay: "yes" }), { allowRelay: false });
  assertEquals(parseFabricPolicy({ allowRelay: true }), { allowRelay: true });
  assertEquals(parseFabricPolicy({ allowRelay: false }), { allowRelay: false });
});

test("parseRelayPolicy inherits allowRelay and caps preferredGatewayIds", () => {
  assertEquals(parseRelayPolicy(null), {
    allowRelay: null,
    preferredGatewayIds: [],
  });
  assertEquals(parseRelayPolicy({ allowRelay: true }), {
    allowRelay: true,
    preferredGatewayIds: [],
  });
  assertEquals(parseRelayPolicy({ allowRelay: false }), {
    allowRelay: false,
    preferredGatewayIds: [],
  });
  assertEquals(parseRelayPolicy({ allowRelay: "no" }), {
    allowRelay: null,
    preferredGatewayIds: [],
  });
  assertEquals(
    parseRelayPolicy({
      preferredGatewayIds: ["gw-b", "", "gw-a", "gw-b", 1, "gw-c"],
    }),
    {
      allowRelay: null,
      preferredGatewayIds: ["gw-b", "gw-a", "gw-c"],
    },
  );
});

test("resolveEffectiveAllowRelay lets a relay only tighten org policy", () => {
  assertEquals(resolveEffectiveAllowRelay(false, null), false);
  assertEquals(resolveEffectiveAllowRelay(false, false), false);
  assertEquals(resolveEffectiveAllowRelay(false, true), false);
  assertEquals(resolveEffectiveAllowRelay(true, null), true);
  assertEquals(resolveEffectiveAllowRelay(true, false), false);
  assertEquals(resolveEffectiveAllowRelay(true, true), true);
});

test("mergeRelayPolicyOptions keeps unrelated relay.options keys", () => {
  const merged = mergeRelayPolicyOptions(
    { custom: "keep", allowRelay: true },
    { preferredGatewayIds: ["gw-1"] },
  );
  assertEquals(merged.custom, "keep");
  assertEquals(merged.allowRelay, true);
  assertEquals(merged.preferredGatewayIds, ["gw-1"]);
  assertEquals(
    mergeRelayPolicyOptions({ custom: 1 }, { allowRelay: null }).allowRelay,
    null,
  );
});
