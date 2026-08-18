import { assertEquals, assertRejects } from "@std/assert";
import type { Db } from "../../db.ts";
import type { CommandQueue } from "../commands/queue.ts";
import { buildFabricReconcilePayload } from "../db/fabric-records.ts";
import {
  awaitParticipatingFabricConvergence,
  enqueueFabricReconcileForServers,
  fabricEnqueueTypedError,
  isFabricEnqueueTypedError,
  isFabricMembershipConverged,
  reconcileFabricMembership,
  relayNeedsFabricEnqueue,
} from "./enqueue.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type RelayRow = {
  id: string;
  fabricId: string;
  serverId: string;
  address: string;
  role: "gateway" | "member";
  keepalive: number | null;
  endpointAddress: string | null;
  publicKey: string | null;
  prefix: string;
  advertisedCidrs: string[];
  metadata: { appliedPayloadHash?: string };
};

type MembershipPinRow = {
  ipId: string;
  serverId: string;
  datacenterId: string;
  networkId: string | null;
  address: string;
};

type DatacenterNetworkRow = {
  id: string;
  datacenterId: string;
  cidr: string;
  name: string | null;
};

function thenable<T>(value: T) {
  return {
    then(resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

function createEndpointlessFabricDb(
  relays: RelayRow[],
  extras: {
    memberships?: MembershipPinRow[];
    datacenterNetworks?: DatacenterNetworkRow[];
  } = {},
): Db {
  const memberships = extras.memberships ?? [];
  const datacenterNetworks = extras.datacenterNetworks ?? [];
  return {
    select(fields: Record<string, unknown>) {
      const keys = Object.keys(fields).sort((a, b) => a.localeCompare(b));
      const keySet = new Set(keys);

      if (keySet.has("advertisedCidrs") && keySet.has("prefix")) {
        return {
          from() {
            return {
              where() {
                return thenable(relays);
              },
            };
          },
        };
      }

      if (keySet.has("ipId") && keySet.has("datacenterId")) {
        return {
          from() {
            return {
              where() {
                return thenable(memberships);
              },
            };
          },
        };
      }

      if (
        keySet.has("datacenterId") && keySet.has("cidr") && keySet.has("name")
      ) {
        return {
          from() {
            return {
              where() {
                return thenable(datacenterNetworks);
              },
            };
          },
        };
      }

      if (keySet.has("scope") && keySet.has("createdAt")) {
        return {
          from() {
            return {
              where() {
                return {
                  orderBy() {
                    return thenable([]);
                  },
                };
              },
            };
          },
        };
      }

      if (keys.length === 2 && keySet.has("id") && keySet.has("metadata")) {
        return {
          from() {
            return {
              where() {
                return thenable(
                  relays.map((row) => ({
                    id: row.serverId,
                    metadata: null,
                  })),
                );
              },
            };
          },
        };
      }

      if (keySet.has("presharedKey")) {
        return {
          from() {
            return {
              where() {
                return thenable(
                  relays.map((row) => ({ id: row.id, presharedKey: null })),
                );
              },
            };
          },
        };
      }

      if (keySet.has("networkId") && keySet.has("cidr")) {
        return {
          from() {
            return {
              where() {
                return thenable([]);
              },
            };
          },
        };
      }

      throw new TypeError(`unexpected select keys: ${keys.join(",")}`);
    },
  } as unknown as Db;
}

function throwingQueue(): CommandQueue {
  return {
    enqueue() {
      return Promise.reject(
        new Error("should not enqueue when a peer has no endpoint"),
      );
    },
  } as unknown as CommandQueue;
}

const FABRIC = {
  id: "fab-1",
  organizationId: "org-1",
  cidr: "10.250.0.0/16",
  options: null,
};

const ENDPOINTLESS_RELAYS: RelayRow[] = [
  {
    id: "r1",
    fabricId: "fab-1",
    serverId: "srv-1",
    address: "10.250.0.1",
    role: "member",
    keepalive: null,
    endpointAddress: null,
    publicKey: "pk1",
    prefix: "10.192.0.0/16",
    advertisedCidrs: [],
    metadata: {},
  },
  {
    id: "r2",
    fabricId: "fab-1",
    serverId: "srv-2",
    address: "10.250.0.2",
    role: "member",
    keepalive: null,
    endpointAddress: null,
    publicKey: "pk2",
    prefix: "10.193.0.0/16",
    advertisedCidrs: [],
    metadata: {},
  },
];

test("fabricEnqueueTypedError surfaces relay_endpoint_unavailable", () => {
  assertEquals(fabricEnqueueTypedError([]), null);
  assertEquals(
    fabricEnqueueTypedError([
      { serverId: "s1", status: "queued" },
      { serverId: "s2", status: "skipped" },
    ]),
    null,
  );
  assertEquals(
    fabricEnqueueTypedError([
      { serverId: "s1", status: "queued" },
      { serverId: "s2", status: "failed", error: "relay_endpoint_unavailable" },
    ]),
    "relay_endpoint_unavailable",
  );
});

test("isFabricEnqueueTypedError recognizes allocation codes only", () => {
  assertEquals(isFabricEnqueueTypedError("relay_endpoint_unavailable"), true);
  assertEquals(isFabricEnqueueTypedError("fabric_segment_pool_exhausted"), true);
  assertEquals(isFabricEnqueueTypedError("relay_missing"), true);
  assertEquals(isFabricEnqueueTypedError("enqueue_failed"), false);
  assertEquals(isFabricEnqueueTypedError("Command queue unavailable"), false);
});

test("enqueueFabricReconcileForServers skips when enabled without fabric snapshot", async () => {
  const results = await enqueueFabricReconcileForServers({
    db: createEndpointlessFabricDb([]),
    commandQueue: throwingQueue(),
    actorType: "user",
    actorId: "user-1",
    fabric: null,
    serverIds: ["srv-1", "srv-2"],
    enabled: true,
  });
  assertEquals(results, [
    { serverId: "srv-1", status: "skipped" },
    { serverId: "srv-2", status: "skipped" },
  ]);
});

test("enqueueFabricReconcileForServers returns typed relay_endpoint_unavailable without throwing", async () => {
  const results = await enqueueFabricReconcileForServers({
    db: createEndpointlessFabricDb(ENDPOINTLESS_RELAYS),
    commandQueue: throwingQueue(),
    actorType: "user",
    actorId: "user-1",
    fabric: FABRIC,
    serverIds: ["srv-1", "srv-2", "srv-missing"],
    enabled: true,
  });
  assertEquals(results, [
    {
      serverId: "srv-1",
      status: "failed",
      error: "relay_endpoint_unavailable",
    },
    {
      serverId: "srv-2",
      status: "failed",
      error: "relay_endpoint_unavailable",
    },
    { serverId: "srv-missing", status: "skipped" },
  ]);
});

test("enqueueFabricReconcileForServers still throws non-allocation errors", async () => {
  const db = {
    select() {
      throw new Error("db exploded");
    },
  } as unknown as Db;
  await assertRejects(
    () =>
      enqueueFabricReconcileForServers({
        db,
        commandQueue: throwingQueue(),
        actorType: "user",
        actorId: "user-1",
        fabric: FABRIC,
        serverIds: ["srv-1"],
        enabled: true,
      }),
    Error,
    "db exploded",
  );
});

const WG_KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const WG_KEY_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";

function createMembershipFabricDb(
  relays: RelayRow[],
  extras: {
    memberships?: MembershipPinRow[];
    datacenterNetworks?: DatacenterNetworkRow[];
  } = {},
): Db {
  let commandSeq = 0;
  const base = createEndpointlessFabricDb(relays, extras);
  return {
    select(fields: Record<string, unknown>) {
      const keys = Object.keys(fields).sort((a, b) => a.localeCompare(b));
      const keySet = new Set(keys);

      if (
        keySet.has("organizationId") && keySet.has("cidr") &&
        keySet.has("options")
      ) {
        return {
          from() {
            return {
              where() {
                return {
                  limit() {
                    return thenable([FABRIC]);
                  },
                };
              },
            };
          },
        };
      }

      if (keys.length === 1 && keys[0] === "id") {
        return {
          from() {
            return {
              where() {
                return thenable(relays.map((row) => ({ id: row.serverId })));
              },
            };
          },
        };
      }

      return (base as unknown as {
        select: (f: Record<string, unknown>) => unknown;
      }).select(fields);
    },
    insert() {
      return {
        values(
          values: {
            serverId: string;
            actorType: string;
            actorId: string;
            name: string;
            payload: unknown;
            metadata: unknown;
          },
        ) {
          return {
            returning() {
              commandSeq += 1;
              const now = "2020-01-01T00:00:00.000Z";
              return thenable([
                {
                  id: `cmd-${String(commandSeq)}`,
                  serverId: values.serverId,
                  actorType: values.actorType,
                  actorId: values.actorId,
                  name: values.name,
                  status: "queued",
                  attempts: 0,
                  payload: values.payload,
                  metadata: values.metadata,
                  result: null,
                  createdAt: now,
                  updatedAt: now,
                },
              ]);
            },
          };
        },
      };
    },
  } as unknown as Db;
}

function recordingQueue(enqueued: string[]): CommandQueue {
  return {
    enqueue(envelope: { serverId: string }) {
      enqueued.push(envelope.serverId);
      return Promise.resolve();
    },
  } as unknown as CommandQueue;
}

test("enqueueFabricReconcileForServers enqueues disable payloads when fabric is off", async () => {
  const enqueued: string[] = [];
  const results = await enqueueFabricReconcileForServers({
    db: createMembershipFabricDb([]),
    commandQueue: recordingQueue(enqueued),
    actorType: "user",
    actorId: "user-1",
    fabric: FABRIC,
    serverIds: ["srv-1"],
    enabled: false,
  });
  assertEquals(enqueued, ["srv-1"]);
  assertEquals(results, [
    { serverId: "srv-1", commandId: "cmd-1", status: "queued" },
  ]);
});

test("enqueueFabricReconcileForServers reports queue unavailable after create", async () => {
  const base = createMembershipFabricDb(hashGateRelays());
  const db = {
    select: (base as unknown as { select: (f: Record<string, unknown>) => unknown })
      .select.bind(base),
    insert: (base as unknown as { insert: () => unknown }).insert.bind(base),
    update() {
      return {
        set() {
          return {
            where() {
              return {
                returning() {
                  return thenable([
                    {
                      id: "cmd-1",
                      serverId: "srv-1",
                      actorType: "user",
                      actorId: "user-1",
                      name: "server.fabric.reconcile",
                      status: "failed",
                      attempts: 0,
                      payload: { enabled: true },
                      metadata: { error: "Command queue unavailable" },
                      result: null,
                      createdAt: "2020-01-01T00:00:00.000Z",
                      updatedAt: "2020-01-01T00:00:00.000Z",
                    },
                  ]);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Db;
  const results = await enqueueFabricReconcileForServers({
    db,
    commandQueue: {
      enqueue() {
        return Promise.reject(new Error("amqp down"));
      },
    } as unknown as CommandQueue,
    actorType: "user",
    actorId: "user-1",
    fabric: FABRIC,
    serverIds: ["srv-1"],
    enabled: true,
  });
  assertEquals(results, [
    {
      serverId: "srv-1",
      commandId: "cmd-1",
      status: "failed",
      error: "Command queue unavailable",
    },
  ]);
});

test("enqueueFabricReconcileForServers reports enqueue_failed when create throws", async () => {
  const base = createMembershipFabricDb(hashGateRelays());
  const db = {
    select: (base as unknown as { select: (f: Record<string, unknown>) => unknown })
      .select.bind(base),
    insert() {
      throw new Error("insert exploded");
    },
    update() {
      return {
        set() {
          return {
            where() {
              return thenable([]);
            },
          };
        },
      };
    },
  } as unknown as Db;
  const results = await enqueueFabricReconcileForServers({
    db,
    commandQueue: recordingQueue([]),
    actorType: "user",
    actorId: "user-1",
    fabric: FABRIC,
    serverIds: ["srv-1"],
    enabled: true,
  });
  assertEquals(results, [
    { serverId: "srv-1", status: "failed", error: "enqueue_failed" },
  ]);
});

function hashGateRelays(): RelayRow[] {
  return [
    {
      id: "r1",
      fabricId: "fab-1",
      serverId: "srv-1",
      address: "10.250.0.1",
      role: "member",
      keepalive: null,
      endpointAddress: "203.0.113.10",
      publicKey: WG_KEY_A,
      prefix: "10.192.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    },
    {
      id: "r2",
      fabricId: "fab-1",
      serverId: "srv-2",
      address: "10.250.0.2",
      role: "member",
      keepalive: null,
      endpointAddress: "203.0.113.11",
      publicKey: WG_KEY_B,
      prefix: "10.193.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    },
  ];
}

test("fabricEnqueueTypedError surfaces segment and relay allocation codes", () => {
  assertEquals(
    fabricEnqueueTypedError([
      {
        serverId: "s1",
        status: "failed",
        error: "fabric_segment_pool_exhausted",
      },
    ]),
    "fabric_segment_pool_exhausted",
  );
  assertEquals(
    fabricEnqueueTypedError([{
      serverId: "s1",
      status: "failed",
      error: "relay_missing",
    }]),
    "relay_missing",
  );
});

test("relayNeedsFabricEnqueue is gated on the applied payload hash", () => {
  assertEquals(relayNeedsFabricEnqueue("abc", "abc"), false);
  assertEquals(relayNeedsFabricEnqueue("abc", "def"), true);
  assertEquals(relayNeedsFabricEnqueue(undefined, "abc"), true);
  assertEquals(relayNeedsFabricEnqueue("abc", "abc", true), true);
});

test("reconcileFabricMembership no-ops when the org has no fabric", async () => {
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return thenable([]);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Db;
  const results = await reconcileFabricMembership({
    db,
    commandQueue: throwingQueue(),
    actorType: "user",
    actorId: "user-1",
    organizationId: "org-1",
  });
  assertEquals(results, []);
});

test("reconcileFabricMembership hash gate skips unchanged payloads", async () => {
  const relays = hashGateRelays();
  const db = createMembershipFabricDb(relays);
  const built1 = await buildFabricReconcilePayload(db, {
    fabric: FABRIC,
    serverId: "srv-1",
  });
  const built2 = await buildFabricReconcilePayload(db, {
    fabric: FABRIC,
    serverId: "srv-2",
  });
  if (!built1 || !built2) {
    throw new TypeError("expected fabric reconcile payloads");
  }
  relays[0]!.metadata = { appliedPayloadHash: built1.desiredHash };
  relays[1]!.metadata = { appliedPayloadHash: built2.desiredHash };

  const enqueued: string[] = [];
  const unchanged = await reconcileFabricMembership({
    db,
    commandQueue: recordingQueue(enqueued),
    actorType: "user",
    actorId: "user-1",
    organizationId: "org-1",
  });
  assertEquals(enqueued, []);
  assertEquals(
    unchanged.map((row) => row.status),
    ["skipped", "skipped"],
  );

  relays[0]!.metadata = {};
  const changed = await reconcileFabricMembership({
    db,
    commandQueue: recordingQueue(enqueued),
    actorType: "user",
    actorId: "user-1",
    organizationId: "org-1",
  });
  assertEquals(enqueued, ["srv-1"]);
  assertEquals(
    changed.find((row) => row.serverId === "srv-1")?.status,
    "queued",
  );
  assertEquals(
    changed.find((row) => row.serverId === "srv-2")?.status,
    "skipped",
  );

  enqueued.length = 0;
  const forced = await reconcileFabricMembership({
    db,
    commandQueue: recordingQueue(enqueued),
    actorType: "user",
    actorId: "user-1",
    organizationId: "org-1",
    force: true,
  });
  assertEquals(enqueued.sort((a, b) => a.localeCompare(b)), ["srv-1", "srv-2"]);
  assertEquals(forced.every((row) => row.status === "queued"), true);
});

test("enqueueFabricReconcileForServers skipConverged reports converged instead of enqueueing", async () => {
  const relays = hashGateRelays();
  const db = createMembershipFabricDb(relays);
  const built1 = await buildFabricReconcilePayload(db, {
    fabric: FABRIC,
    serverId: "srv-1",
  });
  const built2 = await buildFabricReconcilePayload(db, {
    fabric: FABRIC,
    serverId: "srv-2",
  });
  if (!built1 || !built2) {
    throw new TypeError("expected fabric reconcile payloads");
  }
  relays[0]!.metadata = { appliedPayloadHash: built1.desiredHash };
  relays[1]!.metadata = { appliedPayloadHash: built2.desiredHash };

  const enqueued: string[] = [];
  const skipped = await enqueueFabricReconcileForServers({
    db,
    commandQueue: recordingQueue(enqueued),
    actorType: "user",
    actorId: "user-1",
    fabric: FABRIC,
    serverIds: ["srv-1", "srv-2"],
    enabled: true,
    skipConverged: true,
  });
  assertEquals(enqueued, []);
  assertEquals(
    skipped.map((row) => row.status),
    ["converged", "converged"],
  );

  relays[0]!.metadata = {};
  const mixed = await enqueueFabricReconcileForServers({
    db,
    commandQueue: recordingQueue(enqueued),
    actorType: "user",
    actorId: "user-1",
    fabric: FABRIC,
    serverIds: ["srv-1", "srv-2"],
    enabled: true,
    skipConverged: true,
  });
  assertEquals(enqueued, ["srv-1"]);
  assertEquals(mixed.find((row) => row.serverId === "srv-1")?.status, "queued");
  assertEquals(
    mixed.find((row) => row.serverId === "srv-2")?.status,
    "converged",
  );
});

function derivedAdvertisedRelays(
  advertisedCidrs: string[] = [],
): RelayRow[] {
  return [
    {
      id: "r1",
      fabricId: "fab-1",
      serverId: "srv-1",
      address: "10.250.0.1",
      role: "member",
      keepalive: null,
      endpointAddress: "203.0.113.10",
      publicKey: WG_KEY_A,
      prefix: "10.192.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    },
    {
      id: "r2",
      fabricId: "fab-1",
      serverId: "srv-2",
      address: "10.250.0.2",
      role: "gateway",
      keepalive: null,
      endpointAddress: "203.0.113.11",
      publicKey: WG_KEY_B,
      prefix: "10.193.0.0/16",
      advertisedCidrs,
      metadata: {},
    },
  ];
}

function derivedAdvertisedExtras(networks: DatacenterNetworkRow[]) {
  return {
    memberships: [{
      ipId: "ip-gw",
      serverId: "srv-2",
      datacenterId: "dc-a",
      networkId: "net-a",
      address: "203.0.113.11",
    }],
    datacenterNetworks: networks,
  };
}

test("enqueueFabricReconcileForServers re-enqueues when a newly derived subnet changes allowedIPs", async () => {
  const relays = derivedAdvertisedRelays();
  const networks: DatacenterNetworkRow[] = [{
    id: "net-a",
    datacenterId: "dc-a",
    cidr: "203.0.113.0/24",
    name: "site-a",
  }];
  const db = createMembershipFabricDb(relays, derivedAdvertisedExtras(networks));
  const built1 = await buildFabricReconcilePayload(db, {
    fabric: FABRIC,
    serverId: "srv-1",
  });
  const built2 = await buildFabricReconcilePayload(db, {
    fabric: FABRIC,
    serverId: "srv-2",
  });
  if (!built1 || !built2) {
    throw new TypeError("expected fabric reconcile payloads");
  }
  relays[0]!.metadata = { appliedPayloadHash: built1.desiredHash };
  relays[1]!.metadata = { appliedPayloadHash: built2.desiredHash };

  networks.push({
    id: "net-b",
    datacenterId: "dc-a",
    cidr: "198.51.100.0/24",
    name: "site-b",
  });
  const enqueued: string[] = [];
  const results = await enqueueFabricReconcileForServers({
    db,
    commandQueue: recordingQueue(enqueued),
    actorType: "user",
    actorId: "user-1",
    fabric: FABRIC,
    serverIds: ["srv-1", "srv-2"],
    enabled: true,
    skipConverged: true,
  });
  assertEquals(enqueued, ["srv-1"]);
  assertEquals(results.find((row) => row.serverId === "srv-1")?.status, "queued");
  assertEquals(
    results.find((row) => row.serverId === "srv-2")?.status,
    "converged",
  );
});

test("enqueueFabricReconcileForServers keeps payload stable under operator advertisedCidrs override", async () => {
  const relays = derivedAdvertisedRelays(["203.0.113.0/24"]);
  const networks: DatacenterNetworkRow[] = [{
    id: "net-a",
    datacenterId: "dc-a",
    cidr: "203.0.113.0/24",
    name: "site-a",
  }];
  const db = createMembershipFabricDb(relays, derivedAdvertisedExtras(networks));
  const built1 = await buildFabricReconcilePayload(db, {
    fabric: FABRIC,
    serverId: "srv-1",
  });
  const built2 = await buildFabricReconcilePayload(db, {
    fabric: FABRIC,
    serverId: "srv-2",
  });
  if (!built1 || !built2) {
    throw new TypeError("expected fabric reconcile payloads");
  }
  relays[0]!.metadata = { appliedPayloadHash: built1.desiredHash };
  relays[1]!.metadata = { appliedPayloadHash: built2.desiredHash };

  networks.push({
    id: "net-b",
    datacenterId: "dc-a",
    cidr: "198.51.100.0/24",
    name: "site-b",
  });
  const enqueued: string[] = [];
  const results = await enqueueFabricReconcileForServers({
    db,
    commandQueue: recordingQueue(enqueued),
    actorType: "user",
    actorId: "user-1",
    fabric: FABRIC,
    serverIds: ["srv-1", "srv-2"],
    enabled: true,
    skipConverged: true,
  });
  assertEquals(enqueued, []);
  assertEquals(
    results.map((row) => row.status),
    ["converged", "converged"],
  );
});

test("enqueueFabricReconcileForServers loads one snapshot not per-relay full-state queries", async () => {
  const relays = hashGateRelays();
  const counts = { relays: 0, psk: 0, segments: 0, ips: 0, servers: 0 };
  const inner = createMembershipFabricDb(relays);
  const db = {
    select(fields: Record<string, unknown>) {
      const keys = Object.keys(fields).sort((a, b) => a.localeCompare(b));
      const keySet = new Set(keys);
      if (keySet.has("advertisedCidrs") && keySet.has("prefix")) {
        counts.relays += 1;
      }
      if (keySet.has("presharedKey")) counts.psk += 1;
      if (keySet.has("networkId") && keySet.has("cidr")) counts.segments += 1;
      if (keySet.has("scope") && keySet.has("createdAt")) counts.ips += 1;
      if (keys.length === 2 && keySet.has("id") && keySet.has("metadata")) {
        counts.servers += 1;
      }
      return (inner as unknown as {
        select: (f: Record<string, unknown>) => unknown;
      }).select(
        fields,
      );
    },
    insert: (inner as unknown as { insert: () => unknown }).insert.bind(inner),
  } as unknown as Db;

  await enqueueFabricReconcileForServers({
    db,
    commandQueue: recordingQueue([]),
    actorType: "user",
    actorId: "user-1",
    fabric: FABRIC,
    serverIds: ["srv-1", "srv-2"],
    enabled: true,
  });
  assertEquals(counts.relays, 1);
  assertEquals(counts.psk, 1);
  assertEquals(counts.segments, 1);
  assertEquals(counts.ips, 1);
  assertEquals(counts.servers, 1);
});

function nullKeyRelays(): RelayRow[] {
  return [
    {
      id: "r1",
      fabricId: "fab-1",
      serverId: "srv-1",
      address: "10.250.0.1",
      role: "member",
      keepalive: null,
      endpointAddress: "203.0.113.10",
      publicKey: null,
      prefix: "10.192.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    },
    {
      id: "r2",
      fabricId: "fab-1",
      serverId: "srv-2",
      address: "10.250.0.2",
      role: "member",
      keepalive: null,
      endpointAddress: "203.0.113.11",
      publicKey: null,
      prefix: "10.193.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    },
  ];
}

function createConvergenceFabricDb(
  relays: RelayRow[],
  fabricPayloads: Array<{ peers?: unknown[] }>,
): Db {
  const commands: Array<Record<string, unknown>> = [];
  const base = createEndpointlessFabricDb(relays);
  return {
    select(fields?: Record<string, unknown>) {
      if (fields === undefined || Object.keys(fields).length === 0) {
        return {
          from() {
            return {
              where() {
                return thenable(
                  commands.map((row) => ({ ...row, status: "succeeded" })),
                );
              },
            };
          },
        };
      }
      const keys = Object.keys(fields).sort((a, b) => a.localeCompare(b));
      const keySet = new Set(keys);
      if (
        keySet.has("organizationId") && keySet.has("cidr") &&
        keySet.has("options")
      ) {
        return {
          from() {
            return {
              where() {
                return {
                  limit() {
                    return thenable([FABRIC]);
                  },
                };
              },
            };
          },
        };
      }
      if (keys.length === 1 && keys[0] === "id") {
        return {
          from() {
            return {
              where() {
                return thenable(relays.map((row) => ({ id: row.serverId })));
              },
            };
          },
        };
      }
      return (base as unknown as {
        select: (f: Record<string, unknown>) => unknown;
      }).select(
        fields,
      );
    },
    insert() {
      return {
        values(values: {
          serverId: string;
          actorType: string;
          actorId: string;
          name: string;
          payload: { peers?: unknown[] };
          metadata: { desiredHash?: string } | null;
        }) {
          return {
            returning() {
              fabricPayloads.push(values.payload);
              const relay = relays.find((row) =>
                row.serverId === values.serverId
              );
              if (relay) {
                if (!relay.publicKey) {
                  relay.publicKey = relay.serverId === "srv-1"
                    ? WG_KEY_A
                    : WG_KEY_B;
                }
                if (values.metadata?.desiredHash) {
                  relay.metadata = {
                    appliedPayloadHash: values.metadata.desiredHash,
                  };
                }
              }
              const now = "2020-01-01T00:00:00.000Z";
              const row = {
                id: `cmd-${String(commands.length + 1)}`,
                serverId: values.serverId,
                actorType: values.actorType,
                actorId: values.actorId,
                name: values.name,
                status: "queued",
                attempts: 0,
                payload: values.payload,
                metadata: values.metadata,
                result: null,
                createdAt: now,
                updatedAt: now,
              };
              commands.push(row);
              return thenable([row]);
            },
          };
        },
      };
    },
  } as unknown as Db;
}

test("awaitParticipatingFabricConvergence waits for second-wave peer payloads before deploy", async () => {
  const relays = nullKeyRelays();
  const fabricPayloads: Array<{ peers?: unknown[] }> = [];
  const db = createConvergenceFabricDb(relays, fabricPayloads);
  const deployEnqueued: string[] = [];

  assertEquals(
    isFabricMembershipConverged({
      participatingServerIds: ["srv-1", "srv-2"],
      relays,
      desiredHashByServer: new Map(),
    }),
    false,
  );

  const outcome = await awaitParticipatingFabricConvergence({
    db,
    commandQueue: recordingQueue([]),
    actorType: "user",
    actorId: "user-1",
    fabric: FABRIC,
    serverIds: ["srv-1", "srv-2"],
    sleep: () => Promise.resolve(),
  });
  if (outcome.kind === "ready") {
    deployEnqueued.push("environment.deploy");
  }

  assertEquals(outcome.kind, "ready");
  assertEquals(deployEnqueued, ["environment.deploy"]);
  const peerless = fabricPayloads.filter((payload) =>
    (payload.peers?.length ?? 0) === 0
  );
  const withPeers = fabricPayloads.filter((payload) =>
    (payload.peers?.length ?? 0) > 0
  );
  assertEquals(peerless.length, 2);
  assertEquals(withPeers.length, 2);
  assertEquals(
    withPeers.every((payload) => (payload.peers?.length ?? 0) === 1),
    true,
  );
});
