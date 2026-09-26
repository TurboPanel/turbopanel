import { assertEquals } from "@std/assert";
import { eq, inArray } from "drizzle-orm";
import type { DaemonOutboundEnvelope } from "../../contracts/cell-protocol.ts";
import { createDenoDb, endDbConnection } from "../../db/connection.ts";
import { organization, server, setting, upgrade } from "../../db/schema.ts";
import { getDatabaseUrl } from "../../db/url.ts";
import { createUpgradeCoordinator } from "./coordinator.ts";
import {
  persistDaemonReachedTarget,
  persistUpgradeOutcome,
  persistUpgradeProgress,
} from "./persist.ts";
import {
  createDrizzleUpgradeStore,
  createMemoryUpgradeStore,
  UPGRADE_TICK_CURSOR_KEY,
  type UpgradeStore,
  type UpgradeTickCursor,
  type UpgradeRunRow,
  type UpgradeStepRow,
} from "./store.ts";
import type { UpgradeTarget } from "./target.ts";
import type {
  UpgradePhase,
  UpgradeStepStatus,
  UpgradeStepUnit,
} from "./vocabulary.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * These suites drive `createDrizzleUpgradeStore` through the coordinator: the
 * tick reads the step window with the store's SQL and writes every decision
 * back to Postgres, and the progress/result frames go through `persist.ts`,
 * the same entry points the daemon sockets call. There is exactly one active
 * run per database (`uniq_upgrade_active`), so each test seeds its own run,
 * refuses to start if another is active, and deletes what it made.
 */

const dbUrl = getDatabaseUrl();

const T0 = "2026-09-24T12:00:00.000Z";

function minutesAfter(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60 * 1000).toISOString();
}

const TARGET: UpgradeTarget = {
  daemon: {
    version: "0.1.1",
    commit: "new-daemon",
    buildId: "d1",
    builtAt: T0,
    manifestUrl:
      "https://github.com/TurboPanel/turbopaneld/releases/download/v0.1.1/manifest.json",
  },
  instance: {
    version: "0.1.1",
    commit: "new-instance",
    buildId: "i1",
    builtAt: T0,
    manifestUrl:
      "https://github.com/TurboPanel/turbopanel/releases/download/v0.1.1/manifest.json",
  },
  ui: {
    version: "0.1.1",
    commit: "new-ui",
    buildId: "u1",
    builtAt: T0,
    manifestUrl:
      "https://github.com/TurboPanel/ui/releases/download/v0.1.1/manifest.json",
  },
};

type Db = ReturnType<typeof createDenoDb>;

type Fixture = {
  db: Db;
  organizationId: string;
  serverIds: string[];
  runIds: string[];
};

async function withFixture(
  label: string,
  fn: (fx: Fixture) => Promise<void>,
): Promise<void> {
  if (!dbUrl) {
    console.warn(`Skipping ${label}: TURBOPANEL_DATABASE_URL not set`);
    return;
  }
  const db = createDenoDb();
  const [org] = await db
    .insert(organization)
    .values({ name: `Upgrade store ${label}` })
    .returning({ id: organization.id });
  const fx: Fixture = {
    db,
    organizationId: org!.id,
    serverIds: [],
    runIds: [],
  };
  try {
    await fn(fx);
  } finally {
    if (fx.runIds.length > 0) {
      await db.delete(upgrade).where(inArray(upgrade.id, fx.runIds));
    }
    await db.delete(setting).where(eq(setting.key, UPGRADE_TICK_CURSOR_KEY));
    if (fx.serverIds.length > 0) {
      await db.delete(server).where(inArray(server.id, fx.serverIds));
    }
    await db.delete(organization).where(eq(organization.id, fx.organizationId));
    await endDbConnection(db);
  }
}

async function addServer(
  fx: Fixture,
  input: {
    connected: boolean;
    commit: string;
    version?: string;
    features?: string[];
  },
): Promise<string> {
  const now = new Date().toISOString();
  const [row] = await fx.db
    .insert(server)
    .values({
      createdAt: now,
      updatedAt: now,
      organizationId: fx.organizationId,
      name: `upgrade-${crypto.randomUUID().slice(0, 8)}`,
      isConnected: input.connected,
      daemon: {
        projection: {
          daemonBuild: {
            commit: input.commit,
            version: input.version ?? "0.1.0",
            buildId: "b0",
          },
          features: input.features ?? ["managed-upgrade-v1"],
        },
      },
    })
    .returning({ id: server.id });
  fx.serverIds.push(row!.id);
  return row!.id;
}

function stepRow(
  runId: string,
  input: {
    serverId: string;
    unit: UpgradeStepUnit;
    phase: UpgradePhase;
    status?: UpgradeStepStatus;
    errorCode?: string;
  },
): UpgradeStepRow {
  const pin = input.unit === "instance" ? TARGET.instance : TARGET.daemon;
  return {
    id: crypto.randomUUID(),
    upgradeId: runId,
    serverId: input.serverId,
    unit: input.unit,
    phase: input.phase,
    batchIndex: 0,
    status: input.status ?? "pending",
    requestId: null,
    attempts: 0,
    nextAttemptAt: null,
    fromVersion: "0.1.0",
    toVersion: pin?.version ?? null,
    fromCommit: null,
    toCommit: pin?.commit ?? null,
    lastStageAt: T0,
    errorCode: input.errorCode ?? null,
    errorMessage: null,
    detail: { phase: input.phase },
  };
}

async function seedRun(
  fx: Fixture,
  phase: UpgradePhase,
  steps: (runId: string) => UpgradeStepRow[],
): Promise<string> {
  const id = crypto.randomUUID();
  const run: UpgradeRunRow = {
    id,
    createdAt: T0,
    source: "manual",
    channel: "release",
    status: "running",
    phase,
    startedBy: null,
    startedByEmail: null,
    target: TARGET,
    batchPolicy: { mode: "percent", value: 100 },
    counts: null,
    error: null,
    startedAt: T0,
    finishedAt: null,
  };
  const inserted = await createDrizzleUpgradeStore(fx.db, null).insertRun(
    run,
    steps(id),
  );
  if (inserted !== "created") {
    throw new TypeError(
      "another upgrade run is active in this database; these tests need it empty",
    );
  }
  fx.runIds.push(id);
  return id;
}

function coordinatorFor(
  fx: Fixture,
  input: {
    runtime: "deno" | "workers";
    colocatedServerId: string | null;
    instanceCommit?: string;
  },
) {
  const clock = { now: T0 };
  const enqueued: Array<{ serverId: string; envelope: DaemonOutboundEnvelope }> =
    [];
  const coordinator = createUpgradeCoordinator({
    store: createDrizzleUpgradeStore(fx.db, null),
    enqueue: (serverId, envelope) => {
      enqueued.push({ serverId, envelope });
      return Promise.resolve();
    },
    runtime: input.runtime,
    channel: "release",
    development: false,
    now: () => clock.now,
    colocatedServerId: input.colocatedServerId,
    instanceInstalled: {
      version: "0.1.0",
      commit: input.instanceCommit ?? "old-instance",
    },
    resolveTarget: () => Promise.resolve(TARGET),
  });
  return { coordinator, enqueued, clock };
}

async function stepById(fx: Fixture, runId: string, stepId: string) {
  const steps = await createDrizzleUpgradeStore(fx.db, null).stepsFor(runId);
  return steps.find((step) => step.id === stepId) ?? null;
}

test("Postgres upgrades: a server offline past the deadline ends the run", async () => {
  await withFixture("offline-deadline", async (fx) => {
    const offline = await addServer(fx, {
      connected: false,
      commit: "old-daemon",
    });
    let stepId = "";
    const runId = await seedRun(fx, "fleet", (id) => {
      const row = stepRow(id, {
        serverId: offline,
        unit: "daemon",
        phase: "fleet",
      });
      stepId = row.id;
      return [row];
    });
    const { coordinator, clock, enqueued } = coordinatorFor(fx, {
      runtime: "workers",
      colocatedServerId: null,
    });

    clock.now = minutesAfter(T0, 90);
    await coordinator.tick({ resolveManifests: false });
    assertEquals((await stepById(fx, runId, stepId))?.status, "waiting");

    clock.now = minutesAfter(T0, 120);
    await coordinator.tick({ resolveManifests: false });
    assertEquals((await stepById(fx, runId, stepId))?.status, "waiting");

    clock.now = minutesAfter(T0, 151);
    await coordinator.tick({ resolveManifests: false });
    const gaveUp = await stepById(fx, runId, stepId);
    assertEquals(gaveUp?.status, "needs_attention");
    assertEquals(gaveUp?.errorCode, "server_offline");
    const store = createDrizzleUpgradeStore(fx.db, null);
    assertEquals(await store.activeRun(), null);
    assertEquals((await store.runById(runId))?.status, "failed");
    assertEquals(enqueued.length, 0);
  });
});

test("Postgres upgrades: a failed co-located daemon step fails the run", async () => {
  await withFixture("colocated-failed", async (fx) => {
    const panel = await addServer(fx, { connected: true, commit: "old-daemon" });
    const fleet = await addServer(fx, { connected: true, commit: "old-daemon" });
    const runId = await seedRun(fx, "colocated_daemon", (id) => [
      stepRow(id, {
        serverId: panel,
        unit: "daemon",
        phase: "colocated_daemon",
        status: "failed",
        errorCode: "update_failed",
      }),
      stepRow(id, { serverId: fleet, unit: "daemon", phase: "fleet" }),
    ]);
    const { coordinator, enqueued } = coordinatorFor(fx, {
      runtime: "deno",
      colocatedServerId: panel,
    });
    await coordinator.tick({ resolveManifests: false });
    const store = createDrizzleUpgradeStore(fx.db, null);
    assertEquals(await store.activeRun(), null);
    const recorded = await store.runById(runId);
    assertEquals(recorded?.status, "failed");
    assertEquals(recorded?.error, "colocated_daemon_failed");
    assertEquals(enqueued.length, 0);
  });
});

test("Postgres upgrades: a stall retry refused as in progress still finishes", async () => {
  await withFixture("stall-retry", async (fx) => {
    const host = await addServer(fx, { connected: true, commit: "old-daemon" });
    let stepId = "";
    const runId = await seedRun(fx, "fleet", (id) => {
      const row = stepRow(id, { serverId: host, unit: "daemon", phase: "fleet" });
      stepId = row.id;
      return [row];
    });
    const { coordinator, clock, enqueued } = coordinatorFor(fx, {
      runtime: "workers",
      colocatedServerId: null,
    });

    await coordinator.tick({ resolveManifests: false });
    const first = enqueued[0]?.envelope.requestId;
    if (!first) throw new TypeError("expected the first dispatch");

    clock.now = minutesAfter(T0, 16);
    await coordinator.tick({ resolveManifests: false });
    clock.now = minutesAfter(T0, 18);
    await coordinator.tick({ resolveManifests: false });
    const second = enqueued[1]?.envelope.requestId;
    if (!second) throw new TypeError("expected the stall retry");

    const at = minutesAfter(T0, 18);
    await persistUpgradeProgress(fx.db, {
      serverId: host,
      unit: "daemon",
      stage: "failed",
      at,
      detail: "update already in progress",
      errorCode: "preflight_in_progress",
      requestId: second,
    });
    await persistUpgradeOutcome(fx.db, {
      serverId: host,
      unit: "daemon",
      ok: false,
      at,
      error: "preflight_in_progress: update already in progress",
      errorCode: "preflight_in_progress",
      requestId: second,
    });
    const held = await stepById(fx, runId, stepId);
    assertEquals(held?.status === "failed", false);
    assertEquals(
      (held?.detail as { priorRequestIds?: string[] })?.priorRequestIds,
      [first],
    );

    await persistDaemonReachedTarget(
      fx.db,
      host,
      "new-daemon",
      minutesAfter(T0, 25),
    );
    assertEquals((await stepById(fx, runId, stepId))?.status, "done");
    clock.now = minutesAfter(T0, 26);
    await coordinator.tick({ resolveManifests: false });
    const recorded = await createDrizzleUpgradeStore(fx.db, null).runById(
      runId,
    );
    assertEquals(recorded?.status, "succeeded");
  });
});

test("Postgres upgrades: a control-plane rollback is recorded as rolled_back", async () => {
  await withFixture("rollback", async (fx) => {
    const panel = await addServer(fx, {
      connected: true,
      commit: "new-daemon",
      version: "0.1.1",
    });
    let stepId = "";
    const runId = await seedRun(fx, "control_plane", (id) => {
      const colocated = stepRow(id, {
        serverId: panel,
        unit: "daemon",
        phase: "colocated_daemon",
        status: "done",
      });
      const instance = stepRow(id, {
        serverId: panel,
        unit: "instance",
        phase: "control_plane",
      });
      stepId = instance.id;
      return [colocated, instance];
    });
    const { coordinator, enqueued, clock } = coordinatorFor(fx, {
      runtime: "deno",
      colocatedServerId: panel,
    });
    await coordinator.tick({ resolveManifests: false });
    const dispatched = enqueued[0]?.envelope;
    if (dispatched?.kind !== "instance-update") {
      throw new TypeError("expected the control-plane dispatch");
    }

    const at = minutesAfter(T0, 5);
    await persistUpgradeProgress(fx.db, {
      serverId: panel,
      unit: "instance",
      stage: "rolled-back",
      at,
      detail: "health_timeout: new build never became healthy",
      errorCode: "health_timeout",
      requestId: dispatched.requestId,
    });
    await persistUpgradeOutcome(fx.db, {
      serverId: panel,
      upgradeId: runId,
      unit: "instance",
      ok: false,
      at,
      error: "health_timeout: new build never became healthy",
      errorCode: "health_timeout",
      requestId: dispatched.requestId,
    });
    const rolled = await stepById(fx, runId, stepId);
    assertEquals(rolled?.status, "rolled_back");
    assertEquals(rolled?.errorCode, "health_timeout");

    clock.now = minutesAfter(T0, 6);
    await coordinator.tick({ resolveManifests: false });
    const retry = enqueued[1]?.envelope;
    assertEquals(retry?.kind, "instance-update");
    const again = await stepById(fx, runId, stepId);
    assertEquals(again?.status, "dispatched");
    assertEquals(again?.attempts, 2);
  });
});

/**
 * The coordinator's host-free suites run on `createMemoryUpgradeStore`, whose
 * `tickWindow` re-implements `loadTickWindow`'s SQL in JavaScript. Seed the
 * same steps into both and require the same window, page by page, so those
 * suites exercise what Postgres returns.
 */
test("Postgres upgrades: the in-memory tick window matches the SQL one", async () => {
  await withFixture("tick-window-parity", async (fx) => {
    const servers: string[] = [];
    for (let i = 0; i < 6; i++) {
      servers.push(await addServer(fx, { connected: true, commit: "old" }));
    }
    // Ordered ids under one random prefix: batch-1 steps sort after batch 0,
    // so the page after the last batch-0 step is where a window that ignored
    // the batch would leak batch-1 rows.
    const prefix = crypto.randomUUID().slice(0, 34);
    const orderedId = (n: number) => `${prefix}${n.toString(16).padStart(2, "0")}`;
    const plan = (runId: string): UpgradeStepRow[] => [
      stepRow(runId, {
        serverId: servers[0]!,
        unit: "daemon",
        phase: "colocated_daemon",
        status: "done",
      }),
      stepRow(runId, {
        serverId: servers[0]!,
        unit: "instance",
        phase: "control_plane",
        status: "done",
      }),
      ...servers.slice(1).map((serverId, i) => ({
        ...stepRow(runId, {
          serverId,
          unit: "daemon",
          phase: "fleet",
          status: i === 0 ? "done" : "pending",
        }),
        id: orderedId(i + 1),
        batchIndex: i < 3 ? 0 : 1,
      })),
    ];
    const runId = await seedRun(fx, "fleet", plan);
    const sqlStore = createDrizzleUpgradeStore(fx.db, null);
    const memoryStore = createMemoryUpgradeStore();
    const run = await sqlStore.runById(runId);
    await memoryStore.insertRun(run!, await sqlStore.stepsFor(runId));

    const view = async (store: UpgradeStore, cursor: UpgradeTickCursor | null) => {
      const window = await store.tickWindow(runId, cursor, 1);
      return {
        steps: window.steps.map((step) => [step.id, step.status]),
        counts: window.counts,
        phase: window.phase,
        batchIndex: window.batchIndex,
        failedPlatformPhase: window.failedPlatformPhase,
        allTerminal: window.allTerminal,
      };
    };

    let cursor: UpgradeTickCursor | null = null;
    for (let page = 0; page < 4; page++) {
      const fromSql = await view(sqlStore, cursor);
      assertEquals(await view(memoryStore, cursor), fromSql, `page ${page}`);
      const last = fromSql.steps.at(-1);
      cursor = last && fromSql.phase && fromSql.batchIndex !== null
        ? {
          phase: fromSql.phase,
          batchIndex: fromSql.batchIndex,
          afterId: String(last[0]),
        }
        : null;
    }

    // Finish batch 0 in both stores: the window must move to batch 1 alike.
    for (const store of [sqlStore, memoryStore]) {
      for (const step of await store.stepsFor(runId)) {
        if (step.phase === "fleet" && step.batchIndex === 0) {
          await store.saveStep({ ...step, status: "done" });
        }
      }
    }
    assertEquals(await view(memoryStore, null), await view(sqlStore, null));
  });
});

