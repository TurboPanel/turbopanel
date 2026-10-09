import { assertEquals } from "@std/assert";
import type { CaRotationResultRow } from "./changeover-fanout.ts";
import {
  CA_ROTATION_TARGET_GONE,
  rotationConvergedForRetire,
  rotationResultReason,
  rotationRowConverged,
} from "./rotation-converge.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SERVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MANAGED = "bbbbbbbb-bbbb-4bbb-8bbb-000000000001";
const COMMAND = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function applyRow(
  overrides: Partial<CaRotationResultRow> = {},
): CaRotationResultRow {
  return {
    serverId: SERVER,
    kind: "apply",
    managedId: MANAGED,
    status: "queued",
    ...overrides,
  };
}

test("rotationRowConverged accepts skipped target_gone without commandId", () => {
  assertEquals(
    rotationRowConverged(
      applyRow({ status: "skipped", error: CA_ROTATION_TARGET_GONE }),
      "queued",
    ),
    true,
  );
});

test("rotationRowConverged blocks apply rows queued without commandId", () => {
  assertEquals(rotationRowConverged(applyRow(), "queued"), false);
});

test("rotationRowConverged requires succeeded when commandId is set", () => {
  assertEquals(
    rotationRowConverged(
      applyRow({ commandId: COMMAND }),
      "succeeded",
    ),
    true,
  );
  assertEquals(
    rotationRowConverged(
      applyRow({ commandId: COMMAND }),
      "queued",
    ),
    false,
  );
});

test("rotationConvergedForRetire allows retire when only target_gone rows remain", () => {
  assertEquals(
    rotationConvergedForRetire(
      [
        applyRow({ status: "skipped", error: CA_ROTATION_TARGET_GONE }),
        {
          serverId: SERVER,
          kind: "ingress",
          status: "skipped",
          error: CA_ROTATION_TARGET_GONE,
        },
      ],
      [],
    ),
    true,
  );
});

test("rotationConvergedForRetire blocks while a live apply row is still queued", () => {
  assertEquals(
    rotationConvergedForRetire(
      [applyRow({ commandId: COMMAND })],
      [{ id: COMMAND, status: "queued" }],
    ),
    false,
  );
});

test("rotationResultReason explains deferred apply rows in plain words", () => {
  assertEquals(
    rotationResultReason({
      row: applyRow(),
      effectiveStatus: "queued",
    }),
    "Waiting for a managed apply command to be enqueued for this cluster member.",
  );
  assertEquals(
    rotationResultReason({
      row: applyRow({ status: "skipped", error: CA_ROTATION_TARGET_GONE }),
      effectiveStatus: "skipped",
      effectiveError: CA_ROTATION_TARGET_GONE,
    }),
    "Skipped because the managed cluster, member, or server no longer exists.",
  );
});
