import { assertEquals } from "@std/assert";
import { eq } from "drizzle-orm";
import { createDenoDb, endDbConnection } from "../../db/connection.ts";
import { organization, server } from "../../db/schema.ts";
import { getDatabaseUrl } from "../../db/url.ts";
import { materializeDaemonJsonbWrite } from "../../test-fixtures/daemon-jsonb-simulator.ts";
import {
  daemonFeaturesColumnPatch,
  daemonProjectionColumnPatch,
} from "./daemon-jsonb-write.ts";
import type { ServerDaemonJsonb } from "./daemon-state.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * The two `server.daemon` writers run as real SQL against Postgres. Every case
 * also runs the host-free simulator the cell/ws suites use on the same inputs
 * and requires the same result, so those suites exercise what Postgres does.
 */

const dbUrl = getDatabaseUrl();

type Db = ReturnType<typeof createDenoDb>;
type Patch =
  | { kind: "features"; features: string[] }
  | { kind: "projection"; snapshot: ServerDaemonJsonb };

function patchSql(patch: Patch) {
  return patch.kind === "features"
    ? daemonFeaturesColumnPatch(patch.features)
    : daemonProjectionColumnPatch(patch.snapshot);
}

async function withServer(
  label: string,
  initial: ServerDaemonJsonb | null,
  fn: (db: Db, serverId: string) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(`Skipping ${label}: TURBOPANEL_DATABASE_URL not set`);
    return;
  }
  const db = createDenoDb();
  const [org] = await db.insert(organization).values({
    name: `jsonb write ${label}`,
  }).returning({ id: organization.id });
  const now = new Date().toISOString();
  const [row] = await db.insert(server).values({
    createdAt: now,
    updatedAt: now,
    organizationId: org!.id,
    name: `jsonb-${crypto.randomUUID().slice(0, 8)}`,
    isConnected: false,
    daemon: initial,
  }).returning({ id: server.id });
  try {
    await fn(db, row!.id);
  } finally {
    await db.delete(server).where(eq(server.id, row!.id));
    await db.delete(organization).where(eq(organization.id, org!.id));
    await endDbConnection(db);
  }
}

async function readDaemon(
  db: Db,
  serverId: string,
): Promise<ServerDaemonJsonb | null> {
  const [row] = await db.select({ daemon: server.daemon }).from(server).where(
    eq(server.id, serverId),
  );
  return (row?.daemon ?? null) as ServerDaemonJsonb | null;
}

/** Apply `patches` in order in Postgres and in the simulator; both must agree. */
async function applyBoth(
  label: string,
  initial: ServerDaemonJsonb | null,
  patches: Patch[],
  expected: ServerDaemonJsonb,
): Promise<void> {
  await withServer(label, initial, async (db, serverId) => {
    let simulated = initial;
    for (const patch of patches) {
      await db.update(server).set({ daemon: patchSql(patch) }).where(
        eq(server.id, serverId),
      );
      simulated = materializeDaemonJsonbWrite(simulated, patchSql(patch));
    }
    const actual = await readDaemon(db, serverId);
    assertEquals(actual, expected, "Postgres result");
    assertEquals(simulated, actual, "simulator agrees with Postgres");
  });
}

const SNAPSHOT: ServerDaemonJsonb = {
  projection: {
    daemonBuild: { commit: "c2", version: "0.1.1", buildId: "b2" },
  },
} as ServerDaemonJsonb;

test("the features patch creates the projection on an empty column", async () => {
  await applyBoth("features-empty", null, [
    { kind: "features", features: ["a", "b"] },
  ], { projection: { features: ["a", "b"] } } as ServerDaemonJsonb);
});

test("the features patch leaves the rest of the projection alone", async () => {
  await applyBoth("features-keeps", {
    projection: {
      daemonBuild: { commit: "c1", version: "0.1.0", buildId: "b1" },
      features: ["old"],
    },
  } as ServerDaemonJsonb, [{ kind: "features", features: ["new"] }], {
    projection: {
      daemonBuild: { commit: "c1", version: "0.1.0", buildId: "b1" },
      features: ["new"],
    },
  } as ServerDaemonJsonb);
});

test("the projection patch replaces the projection but keeps live features", async () => {
  await applyBoth("projection-keeps-features", {
    projection: {
      daemonBuild: { commit: "c1", version: "0.1.0", buildId: "b1" },
      features: ["hello-advertised"],
    },
  } as ServerDaemonJsonb, [{ kind: "projection", snapshot: SNAPSHOT }], {
    projection: {
      daemonBuild: { commit: "c2", version: "0.1.1", buildId: "b2" },
      features: ["hello-advertised"],
    },
  } as ServerDaemonJsonb);
});

test("the projection patch without live features writes the snapshot as-is", async () => {
  await applyBoth("projection-no-features", null, [
    { kind: "projection", snapshot: SNAPSHOT },
  ], SNAPSHOT);
});

test("hello and a projection write keep each other's keys in either order", async () => {
  const expected = {
    projection: {
      daemonBuild: { commit: "c2", version: "0.1.1", buildId: "b2" },
      features: ["f1"],
    },
  } as ServerDaemonJsonb;
  await applyBoth("hello-then-projection", null, [
    { kind: "features", features: ["f1"] },
    { kind: "projection", snapshot: SNAPSHOT },
  ], expected);
  await applyBoth("projection-then-hello", null, [
    { kind: "projection", snapshot: SNAPSHOT },
    { kind: "features", features: ["f1"] },
  ], expected);
});
