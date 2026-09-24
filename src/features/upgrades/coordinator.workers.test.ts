import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { DaemonOutboundEnvelope } from "../../contracts/cell-protocol.ts";
import { createUpgradeCoordinator } from "./coordinator.ts";
import { FLEET_CELL_PROBE_BUDGET, UPGRADE_TICK_STEP_BUDGET } from "./run.ts";
import {
  createMemoryUpgradeStore,
  type FleetServerFact,
  type UpgradeRunRow,
  type UpgradeStepRow,
} from "./store.ts";

const SERVER = "22222222-2222-4222-8222-222222222222";

function fact(): FleetServerFact {
  return {
    serverId: SERVER,
    name: "edge",
    hostname: "edge.example",
    connected: true,
    commit: "old",
    version: "0.1.1",
    features: ["managed-upgrade-v1"],
    colocated: false,
  };
}

const target = {
  daemon: {
    version: "0.1.1",
    commit: "canary-b",
    buildId: "b",
    builtAt: "2026-09-24T00:00:00.000Z",
    manifestUrl: "https://example.test/daemon.json",
  },
  instance: null,
  ui: null,
};

function coordinator() {
  const enqueued: DaemonOutboundEnvelope[] = [];
  const store = createMemoryUpgradeStore({ facts: [fact()], latest: target });
  const api = createUpgradeCoordinator({
    store,
    enqueue: (_serverId, envelope) => {
      enqueued.push(envelope);
      return Promise.resolve();
    },
    runtime: "workers",
    channel: "canary",
    development: false,
    now: () => "2026-09-24T12:00:00.000Z",
    colocatedServerId: null,
    instanceInstalled: { version: "0.1.1", commit: "canary-a" },
    resolveTarget: () => Promise.resolve(target),
  });
  const app = new Hono();
  app.post(
    "/instance/updates/preflight",
    async (c) => c.json(await api.preflight()),
  );
  app.post("/instance/updates/runs", async (c) => {
    const started = await api.start({ source: "manual", startedBy: null });
    if (!started.ok) return c.json(started, 409);
    return c.json({ ok: true, runId: started.runId }, 202);
  });
  app.get("/instance/updates/runs/:id", async (c) => {
    const run = await api.run(c.req.param("id"));
    if (!run) return c.json({ ok: false, error: "upgrade_run_not_found" }, 404);
    return c.json({ ok: true, run });
  });
  app.get("/instance/updates/servers", async (c) => {
    const offset = Number(c.req.query("offset") ?? "0");
    const limit = Number(c.req.query("limit") ?? "50");
    return c.json({
      ok: true,
      ...(await api.servers({ offset, limit, status: "" })),
    });
  });
  app.post("/instance/updates/runs/:id/cancel", async (c) => {
    const result = await api.cancel(c.req.param("id"));
    return c.json(result, result.ok ? 200 : 404);
  });
  return { app, enqueued, api };
}

describe("managed upgrade HTTP", () => {
  it("starts a fleet run and does not treat a missing run as success", async () => {
    const { app, enqueued } = coordinator();
    const preflight = await app.request("/instance/updates/preflight", {
      method: "POST",
    });
    expect(preflight.status).toBe(200);
    const body = await preflight.json() as { canStart: boolean };
    expect(body.canStart).toBe(true);

    const started = await app.request("/instance/updates/runs", {
      method: "POST",
    });
    expect(started.status).toBe(202);
    const created = await started.json() as { runId: string };
    expect(enqueued.map((entry) => entry.kind)).toEqual(["update"]);

    const missing = await app.request("/instance/updates/runs/does-not-exist");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      ok: false,
      error: "upgrade_run_not_found",
    });

    const live = await app.request(`/instance/updates/runs/${created.runId}`);
    expect(live.status).toBe(200);
    const run = await live.json() as { run: { status: string } };
    expect(run.run.status).not.toBe("succeeded");
  });

  it("returns the requested server page past the first fifty", async () => {
    const facts: FleetServerFact[] = Array.from(
      { length: 60 },
      (_unused, index) => ({
        serverId: `server-${index}`,
        name: `s${index}`,
        hostname: null,
        connected: true,
        commit: "old",
        version: "0.1.1",
        features: ["managed-upgrade-v1"],
        colocated: false,
      }),
    );
    const store = createMemoryUpgradeStore({ facts, latest: target });
    const api = createUpgradeCoordinator({
      store,
      enqueue: () => Promise.resolve(),
      runtime: "workers",
      channel: "canary",
      development: false,
      now: () => "2026-09-24T12:00:00.000Z",
      colocatedServerId: null,
      instanceInstalled: { version: "0.1.1", commit: "canary-a" },
      resolveTarget: () => Promise.resolve(target),
    });
    const page = await api.servers({ offset: 50, limit: 50, status: "" });
    expect(page.total).toBe(60);
    expect(page.servers).toHaveLength(10);
    expect(page.servers[0]?.serverId).toBe("server-50");
  });

  it("pages a large fleet without waking a cell per server", async () => {
    const facts: FleetServerFact[] = Array.from(
      { length: 1000 },
      (_unused, index) => ({
        serverId: `server-${index}`,
        name: `s${index}`,
        hostname: null,
        connected: index % 2 === 0,
        commit: "old",
        version: "0.1.1",
        features: ["managed-upgrade-v1"],
        colocated: false,
      }),
    );
    const store = createMemoryUpgradeStore({ facts, latest: target });
    const probes: number[] = [];
    const pageLimits: number[] = [];
    const innerProbe = store.probeCandidates.bind(store);
    store.probeCandidates = async (ids) => {
      probes.push(ids.length);
      if (ids.length > FLEET_CELL_PROBE_BUDGET) {
        throw new Error(`unbounded cell probe: ${ids.length}`);
      }
      return await innerProbe(ids);
    };
    const innerPage = store.pageFleet.bind(store);
    store.pageFleet = async (query, colocatedServerId) => {
      pageLimits.push(query.limit);
      if (query.limit > 100) {
        throw new Error(`query wider than a page: ${query.limit}`);
      }
      return await innerPage(query, colocatedServerId);
    };
    const api = createUpgradeCoordinator({
      store,
      enqueue: () => Promise.resolve(),
      runtime: "workers",
      channel: "canary",
      development: false,
      now: () => "2026-09-24T12:00:00.000Z",
      colocatedServerId: null,
      instanceInstalled: { version: "0.1.1", commit: "canary-a" },
      resolveTarget: () => Promise.resolve(target),
    });
    const page = await api.servers({ offset: 0, limit: 50, status: "" });
    expect(page.total).toBe(1000);
    expect(page.servers).toHaveLength(50);
    expect(pageLimits).toEqual([50]);
    expect(probes).toEqual([]);
    await api.start({ source: "manual", startedBy: null });
    expect(probes.length).toBe(1);
    expect(probes[0]).toBeLessThanOrEqual(FLEET_CELL_PROBE_BUDGET);
  });

  it("pages a large offline batch with bounded reads and writes per tick", async () => {
    const total = 200;
    const facts: FleetServerFact[] = Array.from(
      { length: total },
      (_unused, index) => ({
        serverId: `server-${String(index).padStart(4, "0")}`,
        name: `s${index}`,
        hostname: null,
        connected: false,
        commit: "old",
        version: "0.1.1",
        features: ["managed-upgrade-v1"],
        colocated: false,
      }),
    );
    const store = createMemoryUpgradeStore({ facts, latest: target });
    const runId = "offline-batch";
    const run: UpgradeRunRow = {
      id: runId,
      createdAt: "2026-09-24T12:00:00.000Z",
      source: "auto",
      channel: "canary",
      status: "running",
      phase: "fleet",
      startedBy: null,
      startedByEmail: null,
      target,
      batchPolicy: { mode: "percent", value: 100 },
      counts: null,
      error: null,
      startedAt: "2026-09-24T12:00:00.000Z",
      finishedAt: null,
    };
    const steps: UpgradeStepRow[] = facts.map((fact, index) => ({
      id: `step-${String(index).padStart(4, "0")}`,
      upgradeId: runId,
      serverId: fact.serverId,
      unit: "daemon",
      phase: "fleet",
      batchIndex: 0,
      status: "waiting",
      requestId: null,
      attempts: 0,
      nextAttemptAt: null,
      fromVersion: "0.1.1",
      toVersion: "0.1.1",
      fromCommit: "old",
      toCommit: "canary-b",
      lastStageAt: "2026-09-24T12:00:00.000Z",
      errorCode: null,
      errorMessage: null,
      detail: { phase: "fleet" },
    }));
    expect(await store.insertRun(run, steps)).toBe("created");

    const pages: string[][] = [];
    const writes: string[] = [];
    const runWrites: number[] = [];
    const innerWindow = store.tickWindow.bind(store);
    store.tickWindow = async (id, cursor, limit) => {
      if (limit > UPGRADE_TICK_STEP_BUDGET) {
        throw new Error(`tick read wider than the budget: ${limit}`);
      }
      const window = await innerWindow(id, cursor, limit);
      if (window.steps.length > UPGRADE_TICK_STEP_BUDGET) {
        throw new Error(`tick materialized ${window.steps.length} steps`);
      }
      pages.push(window.steps.map((step) => step.serverId));
      return window;
    };
    const innerSave = store.saveStep.bind(store);
    store.saveStep = async (step) => {
      writes.push(step.id);
      await innerSave(step);
    };
    const innerRun = store.saveRun.bind(store);
    store.saveRun = async (row) => {
      runWrites.push(1);
      await innerRun(row);
    };
    store.fleetFacts = () => {
      throw new Error("tick read the full fleet");
    };
    const readSteps = store.stepsFor.bind(store);
    store.stepsFor = () => {
      throw new Error("tick read every step");
    };
    const innerFacts = store.factsFor.bind(store);
    store.factsFor = async (ids, colocatedServerId) => {
      if (ids.length > UPGRADE_TICK_STEP_BUDGET + 1) {
        throw new Error(`facts read wider than the page: ${ids.length}`);
      }
      return await innerFacts(ids, colocatedServerId);
    };

    const api = createUpgradeCoordinator({
      store,
      enqueue: () => Promise.resolve(),
      runtime: "workers",
      channel: "canary",
      development: false,
      now: () => "2026-09-24T12:00:00.000Z",
      colocatedServerId: null,
      instanceInstalled: { version: "0.1.1", commit: "canary-a" },
      resolveTarget: () => Promise.resolve(target),
    });
    await api.tick({ resolveManifests: false });
    await api.tick({ resolveManifests: false });
    expect(pages).toHaveLength(2);
    expect(pages[0]?.length).toBeLessThanOrEqual(UPGRADE_TICK_STEP_BUDGET);
    expect(pages[1]?.length).toBeLessThanOrEqual(UPGRADE_TICK_STEP_BUDGET);
    expect(pages[0]?.[0]).not.toBe(pages[1]?.[0]);
    expect(writes).toEqual([]);
    expect(runWrites.length).toBeLessThanOrEqual(1);
    const untouched = await readSteps(runId);
    expect(untouched.filter((step) => step.status === "waiting")).toHaveLength(
      total,
    );
  });
});
