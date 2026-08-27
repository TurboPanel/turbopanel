/**
 * Host-free coverage for Organization CA leaf tracking upserts.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { Db } from "../../db.ts";
import { leaf } from "../../lib/db/schema.ts";
import {
  organizationCaLeafNotAfterIso,
  parsePendingTlsLeafTracking,
  pendingTlsLeafMetadata,
  upsertTlsLeafTracking,
  commitPendingTlsLeafTracking,
} from "./leaf-tracking.ts";
import { ORGANIZATION_CA_LEAF_VALID_DAYS } from "../../lib/tls/self-signed.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type RecordedConflict = {
  target: unknown;
  targetWhere: unknown;
  set: Record<string, unknown>;
};

function recordingUpsertDb(): { db: Db; conflicts: RecordedConflict[] } {
  const conflicts: RecordedConflict[] = [];
  const db = {
    insert: (table: unknown) => {
      assertEquals(table, leaf);
      return {
        values: () => ({
          onConflictDoUpdate: (conflict: RecordedConflict) => {
            conflicts.push(conflict);
            return Promise.resolve(undefined);
          },
        }),
      };
    },
  } as unknown as Db;
  return { db, conflicts };
}

test("organizationCaLeafNotAfterIso uses the 90-day mint default", () => {
  const issuedAtMs = Date.parse("2026-01-01T00:00:00.000Z");
  const notAfter = organizationCaLeafNotAfterIso(issuedAtMs);
  assertEquals(
    notAfter,
    new Date(
      issuedAtMs + ORGANIZATION_CA_LEAF_VALID_DAYS * 86_400_000,
    ).toISOString(),
  );
});

test("upsertTlsLeafTracking ingress conflicts on serverId where kind=ingress", async () => {
  const { db, conflicts } = recordingUpsertDb();
  await upsertTlsLeafTracking(db, {
    kind: "ingress",
    organizationId: "org-1",
    serverId: "server-1",
    caId: "ca-1",
    caGeneration: 2,
    notAfter: "2026-04-01T00:00:00.000Z",
  });
  assertEquals(conflicts.length, 1);
  assertEquals(conflicts[0]?.target, leaf.serverId);
  assertEquals(typeof conflicts[0]?.set.notAfter, "string");
});

test("upsertTlsLeafTracking engine conflicts on replicaId where kind=engine", async () => {
  const { db, conflicts } = recordingUpsertDb();
  await upsertTlsLeafTracking(db, {
    kind: "engine",
    organizationId: "org-1",
    serverId: "server-1",
    managedId: "managed-1",
    replicaId: "node-1",
    caId: "ca-1",
    caGeneration: 2,
    notAfter: "2026-04-01T00:00:00.000Z",
  });
  assertEquals(conflicts.length, 1);
  assertEquals(conflicts[0]?.target, leaf.replicaId);
});

test("upsertTlsLeafTracking engine requires replicaId and managedId", async () => {
  const { db } = recordingUpsertDb();
  await assertRejects(
    () =>
      upsertTlsLeafTracking(db, {
        kind: "engine",
        organizationId: "org-1",
        serverId: "server-1",
        caId: "ca-1",
        caGeneration: 1,
        notAfter: "2026-04-01T00:00:00.000Z",
      }),
    TypeError,
    "engine leaf tracking requires replicaId and managedId",
  );
});

test("pendingTlsLeafMetadata round-trips through parsePendingTlsLeafTracking", () => {
  const engine = {
    kind: "engine" as const,
    organizationId: "org-1",
    serverId: "server-1",
    managedId: "managed-1",
    replicaId: "node-1",
    caId: "ca-1",
    caGeneration: 2,
    notAfter: "2026-04-01T00:00:00.000Z",
  };
  assertEquals(parsePendingTlsLeafTracking(pendingTlsLeafMetadata(engine)), engine);
  assertEquals(parsePendingTlsLeafTracking({}), null);
  assertEquals(parsePendingTlsLeafTracking(null), null);
  assertEquals(
    parsePendingTlsLeafTracking(
      pendingTlsLeafMetadata({
        kind: "ingress",
        organizationId: "org-1",
        serverId: "server-1",
        caId: "ca-1",
        caGeneration: 1,
        notAfter: "2026-04-01T00:00:00.000Z",
      }),
    )?.kind,
    "ingress",
  );
});

test("commitPendingTlsLeafTracking upserts only when metadata is valid", async () => {
  const { db, conflicts } = recordingUpsertDb();
  assertEquals(await commitPendingTlsLeafTracking(db, {}), false);
  assertEquals(conflicts.length, 0);
  assertEquals(
    await commitPendingTlsLeafTracking(
      db,
      pendingTlsLeafMetadata({
        kind: "ingress",
        organizationId: "org-1",
        serverId: "server-1",
        caId: "ca-1",
        caGeneration: 1,
        notAfter: "2026-04-01T00:00:00.000Z",
      }),
    ),
    true,
  );
  assertEquals(conflicts.length, 1);
  assertEquals(conflicts[0]?.target, leaf.serverId);
});
