import { assertEquals } from "@std/assert";
import { INSTANCE_VERSION } from "../app/version.ts";
import { instanceAttachVersionFrame } from "./attach-version.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("attach version frame carries INSTANCE_VERSION and the revision commit", () => {
  const frame = instanceAttachVersionFrame("2026-09-22T00:00:00.000Z", {
    TURBOPANEL_REVISION: "abc1234",
  });
  assertEquals(frame.type, "version");
  assertEquals(frame.at, "2026-09-22T00:00:00.000Z");
  assertEquals(frame.commit, "abc1234");
  assertEquals(frame.branch, "unknown");
  assertEquals(frame.instanceVersion, INSTANCE_VERSION);
});

test("attach version frame omits a non-string revision", () => {
  const frame = instanceAttachVersionFrame("2026-09-22T00:00:00.000Z", {
    TURBOPANEL_REVISION: 12,
  });
  assertEquals(frame.commit, "unknown");
  assertEquals(frame.instanceVersion, INSTANCE_VERSION);
});
