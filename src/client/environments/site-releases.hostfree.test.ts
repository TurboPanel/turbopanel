/**
 * Host-free coverage for resolving the per-service release trees
 * `environment.stop` reclaims — the generic `<principalHome>/sites/<serviceId>`
 * layout, captured while the rows naming it still exist.
 */

import { assertEquals } from "@std/assert";
import type { Db } from "../../db.ts";
import {
  resolveEnvironmentSiteReleases,
  resolveSourcedEnvironmentSiteReleases,
} from "./site-releases.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ENV_ID = "env-1";
const PROJECT_ID = "proj-1";
const SERVICE_ID = "00000000-0000-4000-8000-0000000000a1";
const PRINCIPAL_ID = "00000000-0000-4000-8000-0000000000b1";

/**
 * Drizzle-shaped double: every builder method returns the same chain, and each
 * `await` consumes the next queued result set (queries run in call order).
 */
function fakeDb(resultSets: unknown[][]): Db {
  const queue = [...resultSets];
  const chain: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          const promise = Promise.resolve(queue.shift() ?? []);
          return promise.then.bind(promise);
        }
        if (prop === "catch" || prop === "finally") return undefined;
        return () => chain;
      },
    },
  );
  return chain as Db;
}

function composeOptions(services: Record<string, unknown>): unknown {
  return {
    compose: {
      version: 1,
      data: { services },
      presentation: { keyOrder: ["services"], comments: {} },
    },
  };
}

/** `x-turbopanel.source.sourceId` only parses as a binding when it is a UUID. */
const SOURCE_ID = "00000000-0000-4000-8000-0000000000c1";
const PLAIN_SERVICE = { web: { image: "nginx:1" } };
const SOURCED_SERVICE = {
  web: {
    image: "nginx:1",
    "x-turbopanel": { source: { sourceId: SOURCE_ID } },
  },
};

test("resolveEnvironmentSiteReleases returns [] when the environment is gone", async () => {
  assertEquals(await resolveEnvironmentSiteReleases(fakeDb([[]]), ENV_ID), []);
});

test("resolveEnvironmentSiteReleases returns [] when no compose service declares a source", async () => {
  const db = fakeDb([
    [{
      id: ENV_ID,
      projectId: PROJECT_ID,
      options: composeOptions(PLAIN_SERVICE),
    }],
    [{ id: PROJECT_ID, options: composeOptions(PLAIN_SERVICE) }],
  ]);
  assertEquals(await resolveEnvironmentSiteReleases(db, ENV_ID), []);
});

test("resolveEnvironmentSiteReleases uses the service UUID when the service publishes a hosting", async () => {
  const db = fakeDb([
    [{ id: ENV_ID, projectId: PROJECT_ID, options: composeOptions({}) }],
    [{ id: PROJECT_ID, options: composeOptions(SOURCED_SERVICE) }],
    [{ id: SERVICE_ID, composeServiceName: "web" }],
    [{ serviceId: SERVICE_ID }],
    [{ principalId: PRINCIPAL_ID, serviceId: SERVICE_ID }],
    [{ id: PRINCIPAL_ID, username: "appuser" }],
  ]);
  assertEquals(await resolveEnvironmentSiteReleases(db, ENV_ID), [
    { serviceId: SERVICE_ID, username: "appuser" },
  ]);
});

test("resolveEnvironmentSiteReleases falls back to the compose key with no hosting", async () => {
  // Mirrors the daemon's resolveReleaseServiceId: a worker publishes nothing,
  // so the compose key is the directory segment.
  const db = fakeDb([
    [{ id: ENV_ID, projectId: PROJECT_ID, options: composeOptions({}) }],
    [{ id: PROJECT_ID, options: composeOptions(SOURCED_SERVICE) }],
    [{ id: SERVICE_ID, composeServiceName: "web" }],
    [],
    [{ principalId: PRINCIPAL_ID, serviceId: SERVICE_ID }],
    [{ id: PRINCIPAL_ID, username: "appuser" }],
  ]);
  assertEquals(await resolveEnvironmentSiteReleases(db, ENV_ID), [
    { serviceId: "web", username: "appuser" },
  ]);
});

test("resolveEnvironmentSiteReleases skips a service with no sole tenancy", async () => {
  // Ambiguous or absent ownership means no release was ever published under a
  // principal home, so there is nothing to reclaim.
  const ambiguous = fakeDb([
    [{ id: ENV_ID, projectId: PROJECT_ID, options: composeOptions({}) }],
    [{ id: PROJECT_ID, options: composeOptions(SOURCED_SERVICE) }],
    [{ id: SERVICE_ID, composeServiceName: "web" }],
    [{ serviceId: SERVICE_ID }],
    [
      { principalId: PRINCIPAL_ID, serviceId: SERVICE_ID },
      {
        principalId: "00000000-0000-4000-8000-0000000000b2",
        serviceId: SERVICE_ID,
      },
    ],
  ]);
  assertEquals(await resolveEnvironmentSiteReleases(ambiguous, ENV_ID), []);

  const unowned = fakeDb([
    [{ id: ENV_ID, projectId: PROJECT_ID, options: composeOptions({}) }],
    [{ id: PROJECT_ID, options: composeOptions(SOURCED_SERVICE) }],
    [{ id: SERVICE_ID, composeServiceName: "web" }],
    [{ serviceId: SERVICE_ID }],
    [],
  ]);
  assertEquals(await resolveEnvironmentSiteReleases(unowned, ENV_ID), []);
});

// ---------------------------------------------------------------------------
// Services removed from the compose: the current document no longer names their
// release tree, so reclaim falls back to what the last deploy recorded.
// ---------------------------------------------------------------------------

const REMOVED_SERVICE_ID = "00000000-0000-4000-8000-0000000000a2";

/** One `deployment` row's `options`, as `upsertDeploymentTargets` writes it. */
function deploymentOptions(siteReleases: unknown): unknown[] {
  return [{ options: { secretPlan: [], siteReleases } }];
}

test("resolveEnvironmentSiteReleases still names a service dropped from the compose", async () => {
  // The compose lost its only sourced service, so the current-document pass
  // returns nothing — but the previous deploy recorded the tree it published.
  const db = fakeDb([
    [{
      id: ENV_ID,
      projectId: PROJECT_ID,
      options: composeOptions(PLAIN_SERVICE),
    }],
    [{ id: PROJECT_ID, options: composeOptions(PLAIN_SERVICE) }],
    deploymentOptions([{ serviceId: REMOVED_SERVICE_ID, username: "appuser" }]),
  ]);
  assertEquals(await resolveEnvironmentSiteReleases(db, ENV_ID), [
    { serviceId: REMOVED_SERVICE_ID, username: "appuser" },
  ]);
});

test("resolveEnvironmentSiteReleases unions the recorded set with the current one", async () => {
  const db = fakeDb([
    [{ id: ENV_ID, projectId: PROJECT_ID, options: composeOptions({}) }],
    [{ id: PROJECT_ID, options: composeOptions(SOURCED_SERVICE) }],
    [{ id: SERVICE_ID, composeServiceName: "web" }],
    [{ serviceId: SERVICE_ID }],
    [{ principalId: PRINCIPAL_ID, serviceId: SERVICE_ID }],
    [{ id: PRINCIPAL_ID, username: "appuser" }],
    // The still-present service is recorded too; it must not be listed twice.
    deploymentOptions([
      { serviceId: SERVICE_ID, username: "appuser" },
      { serviceId: REMOVED_SERVICE_ID, username: "appuser" },
    ]),
  ]);
  assertEquals(await resolveEnvironmentSiteReleases(db, ENV_ID), [
    { serviceId: SERVICE_ID, username: "appuser" },
    { serviceId: REMOVED_SERVICE_ID, username: "appuser" },
  ]);
});

test("resolveEnvironmentSiteReleases drops recorded entries with unsafe segments", async () => {
  const db = fakeDb([
    [{
      id: ENV_ID,
      projectId: PROJECT_ID,
      options: composeOptions(PLAIN_SERVICE),
    }],
    [{ id: PROJECT_ID, options: composeOptions(PLAIN_SERVICE) }],
    deploymentOptions([
      { serviceId: "../etc", username: "appuser" },
      { serviceId: "svc-1", username: "../root" },
      { serviceId: "svc-1" },
      "nonsense",
    ]),
  ]);
  assertEquals(await resolveEnvironmentSiteReleases(db, ENV_ID), []);
});

test("resolveSourcedEnvironmentSiteReleases records only what the compose declares", async () => {
  // Deploy writes this into `deployment.options`; keeping it current-only is
  // what stops the record growing without bound.
  const db = fakeDb([
    [{
      id: ENV_ID,
      projectId: PROJECT_ID,
      options: composeOptions(PLAIN_SERVICE),
    }],
    [{ id: PROJECT_ID, options: composeOptions(PLAIN_SERVICE) }],
    deploymentOptions([{ serviceId: REMOVED_SERVICE_ID, username: "appuser" }]),
  ]);
  assertEquals(await resolveSourcedEnvironmentSiteReleases(db, ENV_ID), []);
});
