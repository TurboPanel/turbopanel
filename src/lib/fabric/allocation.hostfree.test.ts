import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  buildFabricReconcilePayloadFromSnapshot,
  buildPeerMaterial,
  type EndpointAddressCaches,
  FabricAllocationError,
  type FabricReconcileSnapshot,
  listFabricRelays,
  type RelayRecord,
  requireRelayHostAddress,
  requireRelayPrefix,
  requireSegmentSubnet,
  resolveRelayEndpointAddress,
  selectPairPresharedEnvelope,
} from "../db/fabric-records.ts";
import { DEFAULT_FABRIC_CONTAINER_POOL } from "./cidr.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function emptyCaches(): EndpointAddressCaches {
  return {
    datacenterAddressByServer: new Map(),
    publicAddressByServer: new Map(),
    reportedByServer: new Map(),
  };
}

function assertKind(err: unknown, kind: string): void {
  if (!(err instanceof FabricAllocationError)) {
    throw new TypeError(`expected FabricAllocationError, got ${String(err)}`);
  }
  assertEquals(err.kind, kind);
}

test("requireRelayHostAddress picks the lowest free host and reuses a gap", () => {
  assertEquals(requireRelayHostAddress("10.250.0.0/16", []), "10.250.0.1");
  assertEquals(
    requireRelayHostAddress("10.250.0.0/16", ["10.250.0.1", "10.250.0.3"]),
    "10.250.0.2",
  );
});

test("requireRelayHostAddress raises fabric_address_pool_exhausted", () => {
  const occupied = ["10.250.0.1", "10.250.0.2"];
  const err = assertThrows(
    () => requireRelayHostAddress("10.250.0.0/30", occupied),
    FabricAllocationError,
  );
  assertKind(err, "fabric_address_pool_exhausted");
  assertEquals(err.message.includes("address pool exhausted"), true);
});

test("requireRelayPrefix picks the lowest free /16 and reuses a gap", () => {
  assertEquals(
    requireRelayPrefix(DEFAULT_FABRIC_CONTAINER_POOL, []),
    "10.192.0.0/16",
  );
  assertEquals(
    requireRelayPrefix(DEFAULT_FABRIC_CONTAINER_POOL, [
      "10.192.0.0/16",
      "10.194.0.0/16",
    ]),
    "10.193.0.0/16",
  );
});

test("requireRelayPrefix raises fabric_prefix_pool_exhausted", () => {
  const occupied: string[] = [];
  for (let i = 0; i < 16; i++) {
    occupied.push(`10.${String(192 + i)}.0.0/16`);
  }
  const err = assertThrows(
    () => requireRelayPrefix(DEFAULT_FABRIC_CONTAINER_POOL, occupied),
    FabricAllocationError,
  );
  assertKind(err, "fabric_prefix_pool_exhausted");
});

test("requireSegmentSubnet is scoped to the owning relay prefix", () => {
  assertEquals(requireSegmentSubnet("10.192.0.0/16", []), "10.192.0.0/24");
  assertEquals(
    requireSegmentSubnet("10.192.0.0/16", [
      "10.192.0.0/24",
      "10.193.0.0/24",
      "10.192.2.0/24",
    ]),
    "10.192.1.0/24",
  );
});

test("requireSegmentSubnet raises fabric_segment_pool_exhausted", () => {
  const err = assertThrows(
    () => requireSegmentSubnet("10.192.0.0/24", ["10.192.0.0/24"]),
    FabricAllocationError,
  );
  assertKind(err, "fabric_segment_pool_exhausted");
});

test("FabricAllocationError carries each kind discriminant", () => {
  assertEquals(
    new FabricAllocationError("relay_missing").kind,
    "relay_missing",
  );
  assertEquals(
    new FabricAllocationError("relay_endpoint_unavailable").kind,
    "relay_endpoint_unavailable",
  );
});

test("resolveRelayEndpointAddress prefers operator pin then datacenter then public then reported", () => {
  const caches = emptyCaches();
  caches.datacenterAddressByServer.set("srv-1", "10.0.0.5");
  caches.publicAddressByServer.set("srv-1", "203.0.113.5");
  caches.reportedByServer.set("srv-1", {
    privateIpv4: ["10.1.0.5"],
    privateIpv6: [],
    publicIpv4: ["198.51.100.5"],
    publicIpv6: [],
  });

  assertEquals(
    resolveRelayEndpointAddress(
      { serverId: "srv-1", endpointAddress: "192.0.2.5" },
      caches,
    ),
    "192.0.2.5",
  );
  assertEquals(
    resolveRelayEndpointAddress(
      { serverId: "srv-1", endpointAddress: null },
      caches,
    ),
    "10.0.0.5",
  );

  caches.datacenterAddressByServer.delete("srv-1");
  assertEquals(
    resolveRelayEndpointAddress(
      { serverId: "srv-1", endpointAddress: null },
      caches,
    ),
    "203.0.113.5",
  );

  caches.publicAddressByServer.delete("srv-1");
  assertEquals(
    resolveRelayEndpointAddress(
      { serverId: "srv-1", endpointAddress: null },
      caches,
    ),
    "198.51.100.5",
  );

  caches.reportedByServer.set("srv-1", {
    privateIpv4: ["10.1.0.5"],
    privateIpv6: [],
    publicIpv4: [],
    publicIpv6: [],
  });
  assertEquals(
    resolveRelayEndpointAddress(
      { serverId: "srv-1", endpointAddress: null },
      caches,
    ),
    "10.1.0.5",
  );
});

test("resolveRelayEndpointAddress raises relay_endpoint_unavailable", () => {
  const err = assertThrows(
    () =>
      resolveRelayEndpointAddress(
        { serverId: "srv-missing", endpointAddress: null },
        emptyCaches(),
      ),
    FabricAllocationError,
  );
  assertKind(err, "relay_endpoint_unavailable");
});

function relayFixture(overrides: Partial<RelayRecord> = {}): RelayRecord {
  return {
    id: "relay-1",
    fabricId: "fab-1",
    serverId: "srv-1",
    address: "10.250.0.1",
    role: "member",
    keepalive: null,
    endpointAddress: "203.0.113.1",
    publicKey: "pk",
    prefix: "10.192.0.0/16",
    advertisedCidrs: [],
    metadata: {},
    ...overrides,
  };
}

function thenable<T>(value: T) {
  return {
    then(resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) {
      return Promise.resolve(value).then(resolve, reject);
    },
  };
}

test("buildPeerMaterial appends gateway advertised CIDRs to allowedIPs", async () => {
  const caches = emptyCaches();
  const material = await buildPeerMaterial({
    other: relayFixture({
      role: "gateway",
      advertisedCidrs: ["10.0.0.0/24", "10.1.0.0/24", "10.250.0.1/32"],
    }),
    listenPort: 51821,
    caches,
    sealedPresharedKey: null,
  });
  assertEquals(material.allowedIPs, [
    "10.250.0.1/32",
    "10.192.0.0/16",
    "10.0.0.0/24",
    "10.1.0.0/24",
  ]);
  assertEquals(material.endpoint, "203.0.113.1:51821");
});

test("buildPeerMaterial keeps member advertised CIDRs out of allowedIPs", async () => {
  const material = await buildPeerMaterial({
    other: relayFixture({
      role: "member",
      advertisedCidrs: ["10.0.0.0/24"],
    }),
    listenPort: 51821,
    caches: emptyCaches(),
    sealedPresharedKey: null,
  });
  assertEquals(material.allowedIPs, ["10.250.0.1/32", "10.192.0.0/16"]);
});

test("listFabricRelays serializes gateway advertised CIDRs and empties members", async () => {
  const rows = [
    {
      id: "r-gw",
      fabricId: "fab-1",
      serverId: "srv-gw",
      address: "10.250.0.1",
      role: "gateway",
      keepalive: null,
      endpointAddress: null,
      publicKey: null,
      prefix: "10.192.0.0/16",
      advertisedCidrs: ["10.0.0.0/24"],
    },
    {
      id: "r-mem",
      fabricId: "fab-1",
      serverId: "srv-mem",
      address: "10.250.0.2",
      role: "member",
      keepalive: null,
      endpointAddress: null,
      publicKey: null,
      prefix: "10.193.0.0/16",
      advertisedCidrs: ["10.9.0.0/24"],
    },
  ];
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return thenable(rows);
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof listFabricRelays>[0];

  const relays = await listFabricRelays(db, "fab-1");
  assertEquals(relays[0]?.advertisedCidrs, ["10.0.0.0/24"]);
  assertEquals(relays[1]?.advertisedCidrs, []);
  assertEquals(relays[1]?.role, "member");
});

test("selectPairPresharedEnvelope uses the lexicographically smaller relay id", () => {
  const sealed = new Map<string, string | null>([
    ["r1", "seal-a"],
    ["r2", "seal-b"],
  ]);
  assertEquals(selectPairPresharedEnvelope("r1", "r2", sealed), "seal-a");
  assertEquals(selectPairPresharedEnvelope("r2", "r1", sealed), "seal-a");
});

test("selectPairPresharedEnvelope falls back when the owner has no envelope", () => {
  const sealed = new Map<string, string | null>([
    ["r1", null],
    ["r2", "seal-b"],
  ]);
  assertEquals(selectPairPresharedEnvelope("r1", "r2", sealed), "seal-b");
});

test("both relay payloads use the same canonical pair PSK when stored envelopes differ", async () => {
  const relays: RelayRecord[] = [
    {
      id: "r1",
      fabricId: "fab-1",
      serverId: "srv-1",
      address: "10.250.0.1",
      role: "member",
      keepalive: null,
      endpointAddress: "203.0.113.10",
      publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
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
      publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=",
      prefix: "10.193.0.0/16",
      advertisedCidrs: [],
      metadata: {},
    },
  ];
  const snapshot: FabricReconcileSnapshot = {
    fabric: {
      id: "fab-1",
      organizationId: "org-1",
      cidr: "10.250.0.0/16",
      options: null,
    },
    relays,
    caches: emptyCaches(),
    sealedPresharedKeyByRelayId: new Map([
      ["r1", "seal-owner"],
      ["r2", "seal-other"],
    ]),
    segmentsByServer: new Map([
      ["srv-1", []],
      ["srv-2", []],
    ]),
  };
  const reseal = (sealed: string) => Promise.resolve(sealed);
  const built1 = await buildFabricReconcilePayloadFromSnapshot(snapshot, {
    serverId: "srv-1",
    resealPresharedKey: reseal,
  });
  const built2 = await buildFabricReconcilePayloadFromSnapshot(snapshot, {
    serverId: "srv-2",
    resealPresharedKey: reseal,
  });
  if (!built1?.payload.enabled || !built2?.payload.enabled) {
    throw new TypeError("expected enabled fabric payloads");
  }
  assertEquals(built1.payload.peers[0]?.presharedKeyEnvelope, "seal-owner");
  assertEquals(built2.payload.peers[0]?.presharedKeyEnvelope, "seal-owner");
});
