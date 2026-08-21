/**
 * Host-free coverage for ProxySQL platform attachment / listener segment math.
 */

import { assertEquals } from "@std/assert";
import type { Db } from "../../db.ts";
import type { ComposeDocument } from "../../lib/compose/types.ts";
import {
  loadListenerAttachedSegmentNames,
  loadManagedIngressPlatformAttachments,
  reservedIngressHostsForServer,
} from "./ingress-attachments.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function thenableRows(rows: unknown[]) {
  const promise = Promise.resolve(rows);
  return {
    limit: () => promise,
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };
}

function composeDoc(
  services: Record<string, unknown> | null,
): ComposeDocument {
  return {
    version: 1,
    data: { services },
    presentation: { keyOrder: ["services"], comments: {} },
  };
}

/**
 * Queued select responses for drizzle chains used by attachment loaders.
 * Some queries end on `.innerJoin` (no `.where`) — the join leaf itself must
 * be thenable so `await db.select()…innerJoin()` resolves to rows.
 */
function queuedSelectDb(pages: unknown[][]): Db {
  let n = 0;
  return {
    select: () => {
      const rows = pages[n] ?? [];
      n += 1;
      const whereResult = thenableRows(rows);
      const joinLeaf = {
        innerJoin: () => joinLeaf,
        where: () => whereResult,
        then: whereResult.then.bind(whereResult),
        catch: whereResult.catch.bind(whereResult),
        finally: whereResult.finally.bind(whereResult),
      };
      return {
        from: () => joinLeaf,
      };
    },
  } as unknown as Db;
}

test("loadManagedIngressPlatformAttachments returns empty when no bindings", async () => {
  const db = queuedSelectDb([[]]);
  const result = await loadManagedIngressPlatformAttachments(db, {
    environmentId: "env-1",
    document: composeDoc({ web: { image: "nginx" } }),
    tasks: [{ serviceId: "svc-web", serverId: "s-a" }],
    serviceRows: [{ id: "svc-web", composeServiceName: "web" }],
  });
  assertEquals(result, { attachments: [], consumers: [] });
});

test("loadManagedIngressPlatformAttachments skips co-resident consumers", async () => {
  const db = queuedSelectDb([
    [{ serviceId: "svc-web" }],
    [{
      id: "svc-web",
      composeServiceName: "web",
      environmentServerId: "s-a",
      projectOptions: null,
    }],
  ]);
  const result = await loadManagedIngressPlatformAttachments(db, {
    environmentId: "env-1",
    document: composeDoc({
      web: { image: "nginx", networks: ["frontend"] },
    }),
    tasks: [{ serviceId: "svc-web", serverId: "s-a" }],
    serviceRows: [{ id: "svc-web", composeServiceName: "web" }],
  });
  assertEquals(result, { attachments: [], consumers: [] });
});

test("loadManagedIngressPlatformAttachments builds attachments for remote consumers", async () => {
  const listener = "00000000-0000-4000-8000-0000000000a1";
  const other = "00000000-0000-4000-8000-0000000000a2";
  const remote = "00000000-0000-4000-8000-0000000000a3";
  const db = queuedSelectDb([
    [{ serviceId: "svc-web" }, { serviceId: "svc-api" }],
    [
      {
        id: "svc-web",
        composeServiceName: "web",
        environmentServerId: listener,
        projectOptions: null,
      },
      {
        id: "svc-api",
        composeServiceName: "api",
        environmentServerId: null,
        projectOptions: { defaultServerId: other },
      },
      {
        id: "svc-skip",
        composeServiceName: "skip",
        environmentServerId: null,
        projectOptions: null,
      },
    ],
  ]);
  const result = await loadManagedIngressPlatformAttachments(db, {
    environmentId: "env-1",
    document: composeDoc({
      web: { image: "nginx", networks: { frontend: {}, backend: {} } },
      api: { image: "node", networks: ["backend"] },
      skip: { image: "busybox" },
    }),
    tasks: [
      { serviceId: "svc-web", serverId: remote },
      { serviceId: "svc-api", serverId: remote },
      { serviceId: "svc-skip", serverId: remote },
    ],
    serviceRows: [
      { id: "svc-web", composeServiceName: "web" },
      { id: "svc-api", composeServiceName: "api" },
      { id: "svc-skip", composeServiceName: "skip" },
    ],
  });

  // api uses project defaultServerId when env pin is null — still remote vs listener.
  // svc-skip has no listener placement → omitted.
  assertEquals(result.consumers.map((c) => c.composeServiceName), [
    "api",
    "web",
  ]);
  assertEquals(result.attachments, [
    {
      serverId: listener,
      networkKeys: ["backend", "frontend"],
    },
    {
      serverId: other,
      networkKeys: ["backend"],
    },
  ]);
  assertEquals(result.consumers[1]?.networkKeys, ["backend", "frontend"]);
  assertEquals(result.consumers[0]?.listenerServerId, other);
});

test("loadManagedIngressPlatformAttachments tolerates non-object services map", async () => {
  const db = queuedSelectDb([
    [{ serviceId: "svc-web" }],
    [{
      id: "svc-web",
      composeServiceName: "web",
      environmentServerId: "s-listener",
      projectOptions: null,
    }],
  ]);
  const result = await loadManagedIngressPlatformAttachments(db, {
    environmentId: "env-1",
    document: composeDoc(null),
    tasks: [{ serviceId: "svc-web", serverId: "s-remote" }],
    serviceRows: [{ id: "svc-web", composeServiceName: "web" }],
  });
  // Missing body → default network key
  assertEquals(result.consumers, [
    {
      composeServiceName: "web",
      networkKeys: ["default"],
      listenerServerId: "s-listener",
    },
  ]);
  assertEquals(result.attachments, [
    { serverId: "s-listener", networkKeys: ["default"] },
  ]);
});

test("loadListenerAttachedSegmentNames returns empty without matching placement", async () => {
  const listener = "00000000-0000-4000-8000-0000000000b1";
  const db = queuedSelectDb([
    [{
      serviceId: "svc-web",
      environmentServerId: "00000000-0000-4000-8000-0000000000b9",
      projectOptions: null,
    }],
  ]);
  assertEquals(await loadListenerAttachedSegmentNames(db, listener), []);
});

test("loadListenerAttachedSegmentNames returns empty when all tasks are co-resident", async () => {
  const listener = "00000000-0000-4000-8000-0000000000b1";
  const db = queuedSelectDb([
    [{
      serviceId: "svc-web",
      environmentServerId: listener,
      projectOptions: null,
    }],
    [{
      serviceId: "svc-web",
      serverId: listener,
      environmentId: "env-1",
    }],
  ]);
  assertEquals(await loadListenerAttachedSegmentNames(db, listener), []);
});

test("loadListenerAttachedSegmentNames maps remote envs to sorted tpn_ names", async () => {
  const listener = "00000000-0000-4000-8000-0000000000b1";
  const remote = "00000000-0000-4000-8000-0000000000b2";
  const netA = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const netB = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const db = queuedSelectDb([
    [
      {
        serviceId: "svc-web",
        environmentServerId: listener,
        projectOptions: null,
      },
      {
        serviceId: "svc-api",
        environmentServerId: null,
        projectOptions: { defaultServerId: listener },
      },
    ],
    [
      {
        serviceId: "svc-web",
        serverId: remote,
        environmentId: "env-1",
      },
      {
        serviceId: "svc-api",
        serverId: remote,
        environmentId: "env-2",
      },
      {
        serviceId: "svc-web",
        serverId: listener,
        environmentId: "env-local",
      },
    ],
    [
      { networkId: netB },
      { networkId: netA },
      { networkId: netA },
    ],
  ]);
  const names = await loadListenerAttachedSegmentNames(db, listener);
  assertEquals(names, [
    `tpn_${netA}`,
    `tpn_${netB}`,
  ]);
});

test("reservedIngressHostsForServer skips missing listener / attachment / cidr", () => {
  assertEquals(
    reservedIngressHostsForServer({
      thisServerId: "s-b",
      attachments: [],
      consumers: [{
        composeServiceName: "web",
        networkKeys: ["frontend"],
        listenerServerId: "s-a",
      }],
      spanning: new Map(),
      segmentsByServer: new Map(),
      listenerNameByServer: new Map(),
    }),
    new Map(),
  );

  assertEquals(
    reservedIngressHostsForServer({
      thisServerId: "s-b",
      attachments: [],
      consumers: [{
        composeServiceName: "web",
        networkKeys: ["frontend"],
        listenerServerId: "s-a",
      }],
      spanning: new Map([["frontend", "tpn_x"]]),
      segmentsByServer: new Map(),
      listenerNameByServer: new Map([["s-a", "svc-in"]]),
    }),
    new Map(),
  );

  assertEquals(
    reservedIngressHostsForServer({
      thisServerId: "s-b",
      attachments: [{ serverId: "s-a", networkKeys: ["frontend"] }],
      consumers: [{
        composeServiceName: "web",
        networkKeys: ["frontend"],
        listenerServerId: "s-a",
      }],
      spanning: new Map([["frontend", "tpn_missing"]]),
      segmentsByServer: new Map([
        ["s-a", [{ name: "tpn_other", subnet: "203.0.113.0/24" }]],
      ]),
      listenerNameByServer: new Map([["s-a", "svc-in"]]),
    }),
    new Map(),
  );
});
