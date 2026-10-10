/**
 * Host-free coverage for release-tree identity on the control plane.
 */

import { assertEquals } from "@std/assert";
import {
  RELEASE_TREE_SERVICE_ID_RE,
  resolveDeployReleaseServiceId,
} from "./release-service-id.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("RELEASE_TREE_SERVICE_ID_RE accepts environment service UUIDs", () => {
  assertEquals(
    RELEASE_TREE_SERVICE_ID_RE.test("00000000-0000-4000-8000-0000000000a1"),
    true,
  );
  assertEquals(RELEASE_TREE_SERVICE_ID_RE.test("../escape"), false);
});

test("resolveDeployReleaseServiceId prefers the turbo service id", () => {
  const id = "00000000-0000-4000-8000-0000000000a1";
  assertEquals(resolveDeployReleaseServiceId("web", id), id);
});

test("resolveDeployReleaseServiceId falls back to the compose key", () => {
  assertEquals(resolveDeployReleaseServiceId("worker", undefined), "worker");
});
