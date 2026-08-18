import { assertEquals } from "@std/assert";
import type { Db } from "../../db.ts";
import type { DaemonCellRegistry } from "../../daemon/cell/contracts.ts";
import {
  type EndpointAddressCaches,
  fabricPairCacheKey,
  planRelayPath,
  type RelayPathKind,
  type RelayRecord,
} from "../db/fabric-records.ts";
import {
  FABRIC_PATH_DEMOTE_STRIKES,
  FABRIC_PATH_PROMOTE_STRIKES,
  initialFabricPathState,
} from "./path-state.ts";
import {
  buildNatCandidateExchange,
  classifyNatMapping,
  fabricNeedsRendezvous,
  hydrateFabricPathStates,
  type ObservedPeerPath,
  rememberFabricPathStates,
  resetFabricPathStateCacheForTests,
  runFabricRendezvousRound,
  setCollectFabricPathObservationsForTests,
} from "./rendezvous.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const KEY_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
const KEY_GW = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=";
const FABRIC_ID = "fab-rendezvous";

function paths(
  publicKey: string,
  endpoint: string,
  health: ObservedPeerPath["health"] = "healthy",
): ObservedPeerPath[] {
  return [{ publicKey, endpoint, health }];
}

test("classifyNatMapping is easy when the mapped port matches at two observers", () => {
  const observations = new Map([
    ["gw-1", paths(KEY_A, "203.0.113.50:48172")],
    ["gw-2", paths(KEY_A, "203.0.113.50:48172")],
  ]);
  assertEquals(classifyNatMapping(observations, KEY_A), "easy");
});

test("classifyNatMapping is hard when observers see different ports", () => {
  const observations = new Map([
    ["gw-1", paths(KEY_A, "203.0.113.50:48172")],
    ["gw-2", paths(KEY_A, "203.0.113.50:51200")],
  ]);
  assertEquals(classifyNatMapping(observations, KEY_A), "hard");
});

test("classifyNatMapping is unknown with a single observation point", () => {
  const observations = new Map([
    ["gw-1", paths(KEY_A, "203.0.113.50:48172")],
  ]);
  assertEquals(classifyNatMapping(observations, KEY_A), "unknown");
});

test("buildNatCandidateExchange hands each side the peer endpoint observers saw", () => {
  const observations = new Map([
    ["gw-1", [
      ...paths(KEY_A, "203.0.113.50:48172"),
      ...paths(KEY_B, "198.51.100.20:51820"),
    ]],
  ]);
  const exchange = buildNatCandidateExchange({
    relays: [
      { serverId: "srv-a", publicKey: KEY_A },
      { serverId: "srv-b", publicKey: KEY_B },
      { serverId: "gw-1", publicKey: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=" },
    ],
    observations,
    natClass: new Map([
      ["srv-a", "easy"],
      ["srv-b", "easy"],
    ]),
    pathStates: new Map(),
  });
  assertEquals(exchange.get("srv-a"), [
    { publicKey: KEY_B, endpoints: ["198.51.100.20:51820"] },
  ]);
  assertEquals(exchange.get("srv-b"), [
    { publicKey: KEY_A, endpoints: ["203.0.113.50:48172"] },
  ]);
});

test("buildNatCandidateExchange skips both-hard pairs", () => {
  const observations = new Map([
    ["gw-1", [
      ...paths(KEY_A, "203.0.113.50:48172"),
      ...paths(KEY_B, "198.51.100.20:51820"),
    ]],
  ]);
  const exchange = buildNatCandidateExchange({
    relays: [
      { serverId: "srv-a", publicKey: KEY_A },
      { serverId: "srv-b", publicKey: KEY_B },
    ],
    observations,
    natClass: new Map([
      ["srv-a", "hard"],
      ["srv-b", "hard"],
    ]),
    pathStates: new Map(),
  });
  assertEquals(exchange.size, 0);
});

test("buildNatCandidateExchange skips pairs already on a healthy direct path", () => {
  const observations = new Map([
    ["gw-1", [
      ...paths(KEY_A, "203.0.113.50:48172"),
      ...paths(KEY_B, "198.51.100.20:51820"),
    ]],
  ]);
  const ab = initialFabricPathState("srv-b");
  ab.selected = "direct_lan";
  const ba = initialFabricPathState("srv-a");
  ba.selected = "direct_public";
  const exchange = buildNatCandidateExchange({
    relays: [
      { serverId: "srv-a", publicKey: KEY_A },
      { serverId: "srv-b", publicKey: KEY_B },
    ],
    observations,
    natClass: new Map([
      ["srv-a", "easy"],
      ["srv-b", "easy"],
    ]),
    pathStates: new Map([
      ["srv-a>srv-b", ab],
      ["srv-b>srv-a", ba],
    ]),
  });
  assertEquals(exchange.size, 0);
});

test("fabricNeedsRendezvous is false for a single keyed relay", () => {
  assertEquals(
    fabricNeedsRendezvous([
      {
        id: "r1",
        fabricId: "fab",
        serverId: "srv-a",
        address: "10.250.0.1",
        role: "member",
        keepalive: null,
        endpointAddress: null,
        publicKey: KEY_A,
        prefix: "10.192.0.0/16",
        advertisedCidrs: [],
        metadata: {},
        allowRelay: null,
        preferredGatewayIds: [],
      },
    ]),
    false,
  );
});

function stampDb(): Db {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit: () => Promise.resolve([]),
              };
            },
          };
        },
      };
    },
  } as unknown as Db;
}

function emptyPathCaches(): EndpointAddressCaches {
  return {
    publicAddressByServer: new Map(),
    reportedByServer: new Map(),
    datacenterMembershipsByServer: new Map(),
    addressPreferenceByDatacenter: new Map(),
    natEndpointByPair: new Map(),
    failedPathKindsByPair: new Map(),
  };
}

function keyedRelay(params: {
  serverId: string;
  publicKey: string;
  role?: RelayRecord["role"];
  peer?: { serverId: string; selected: RelayPathKind };
}): RelayRecord {
  return {
    id: `r-${params.serverId}`,
    fabricId: FABRIC_ID,
    serverId: params.serverId,
    address: "10.250.0.1",
    role: params.role ?? "member",
    keepalive: null,
    endpointAddress: null,
    publicKey: params.publicKey,
    prefix: "10.192.0.0/16",
    advertisedCidrs: [],
    metadata: params.peer
      ? {
        paths: {
          at: "2026-01-01T00:00:00.000Z",
          entries: [{
            peerServerId: params.peer.serverId,
            selected: params.peer.selected,
            degraded: false,
          }],
        },
      }
      : {},
    allowRelay: null,
    preferredGatewayIds: [],
  };
}

function applySummaries(
  relays: RelayRecord[],
  summariesByServerId: Map<string, { peerServerId: string; selected: RelayPathKind; degraded: boolean }[]>,
): void {
  for (const relay of relays) {
    const entries = summariesByServerId.get(relay.serverId);
    if (!entries) continue;
    relay.metadata = {
      ...relay.metadata,
      paths: { at: "2026-08-18T00:00:00.000Z", entries },
    };
  }
}

test("runFabricRendezvousRound does not promote observer-only endpoints to direct_nat", async () => {
  const relays = [
    keyedRelay({ serverId: "srv-a", publicKey: KEY_A }),
    keyedRelay({ serverId: "srv-b", publicKey: KEY_B }),
    keyedRelay({ serverId: "gw-1", publicKey: KEY_GW }),
  ];
  setCollectFabricPathObservationsForTests((params) => {
    const out = new Map<string, ObservedPeerPath[]>();
    const isProbe = Boolean(params.candidatesByServerId?.size);
    if (!isProbe) {
      out.set("gw-1", [
        { publicKey: KEY_A, endpoint: "203.0.113.50:48172", health: "healthy" },
        { publicKey: KEY_B, endpoint: "198.51.100.20:51820", health: "healthy" },
      ]);
    }
    for (const relay of params.relays) {
      if (out.has(relay.serverId) || !relay.publicKey) continue;
      const paths: ObservedPeerPath[] = [];
      for (const other of params.relays) {
        if (other.serverId === relay.serverId || !other.publicKey) continue;
        paths.push({ publicKey: other.publicKey, health: "never" });
      }
      out.set(relay.serverId, paths);
    }
    return Promise.resolve(out);
  });
  resetFabricPathStateCacheForTests();
  try {
    const round = await runFabricRendezvousRound({
      db: stampDb(),
      registry: {} as DaemonCellRegistry,
      fabricId: FABRIC_ID,
      relays,
      orgAllowRelay: false,
    });
    if (!round) throw new TypeError("expected a rendezvous round");
    assertEquals(round.natEndpointByPair.size, 0);
    const caches = emptyPathCaches();
    caches.natEndpointByPair = round.natEndpointByPair;
    caches.failedPathKindsByPair = round.failedPathKindsByPair;
    const plan = planRelayPath({
      self: relays[0]!,
      other: relays[1]!,
      caches,
    });
    assertEquals(plan.selected.kind, "unreachable");
    assertEquals(
      round.pathStates.get(fabricPairCacheKey("srv-a", "srv-b"))?.selected,
      "unreachable",
    );
  } finally {
    setCollectFabricPathObservationsForTests(null);
    resetFabricPathStateCacheForTests();
  }
});

test("hydrateFabricPathStates preserves demote strikes across separate rendezvous rounds", async () => {
  const relays = [
    keyedRelay({
      serverId: "srv-a",
      publicKey: KEY_A,
      peer: { serverId: "srv-b", selected: "direct_public" },
    }),
    keyedRelay({
      serverId: "srv-b",
      publicKey: KEY_B,
      peer: { serverId: "srv-a", selected: "direct_public" },
    }),
  ];
  setCollectFabricPathObservationsForTests((params) => {
    const out = new Map<string, ObservedPeerPath[]>();
    for (const relay of params.relays) {
      if (!relay.publicKey) continue;
      const paths: ObservedPeerPath[] = [];
      for (const other of params.relays) {
        if (other.serverId === relay.serverId || !other.publicKey) continue;
        paths.push({ publicKey: other.publicKey, health: "never" });
      }
      out.set(relay.serverId, paths);
    }
    return Promise.resolve(out);
  });
  resetFabricPathStateCacheForTests();
  try {
    let selected = "direct_public";
    for (let roundIndex = 0; roundIndex < FABRIC_PATH_DEMOTE_STRIKES; roundIndex += 1) {
      const round = await runFabricRendezvousRound({
        db: stampDb(),
        registry: {} as DaemonCellRegistry,
        fabricId: FABRIC_ID,
        relays,
        pathStates: hydrateFabricPathStates(FABRIC_ID, relays),
        orgAllowRelay: false,
      });
      if (!round) throw new TypeError("expected a rendezvous round");
      applySummaries(relays, round.summariesByServerId);
      selected = round.pathStates.get(fabricPairCacheKey("srv-a", "srv-b"))
        ?.selected ?? selected;
    }
    assertEquals(selected, "unreachable");
  } finally {
    setCollectFabricPathObservationsForTests(null);
    resetFabricPathStateCacheForTests();
  }
});

test("hydrateFabricPathStates preserves promote strikes across separate rendezvous rounds", async () => {
  const relays = [
    keyedRelay({
      serverId: "srv-a",
      publicKey: KEY_A,
      peer: { serverId: "srv-b", selected: "gateway" },
    }),
    keyedRelay({
      serverId: "srv-b",
      publicKey: KEY_B,
      peer: { serverId: "srv-a", selected: "gateway" },
    }),
    keyedRelay({ serverId: "gw-1", publicKey: KEY_GW, role: "gateway" }),
  ];
  setCollectFabricPathObservationsForTests((params) => {
    const out = new Map<string, ObservedPeerPath[]>();
    const isProbe = Boolean(params.candidatesByServerId?.size);
    out.set("gw-1", [
      { publicKey: KEY_A, endpoint: "203.0.113.10:51820", health: "healthy" },
      { publicKey: KEY_B, endpoint: "203.0.113.50:48172", health: "healthy" },
    ]);
    if (isProbe) {
      out.set("srv-a", [{
        publicKey: KEY_B,
        endpoint: "203.0.113.50:48172",
        health: "healthy",
      }]);
      out.set("srv-b", [{
        publicKey: KEY_A,
        endpoint: "203.0.113.10:51820",
        health: "healthy",
      }]);
    } else {
      out.set("srv-a", []);
      out.set("srv-b", []);
    }
    return Promise.resolve(out);
  });
  resetFabricPathStateCacheForTests();
  try {
    let selected: RelayPathKind = "gateway";
    for (let roundIndex = 0; roundIndex < FABRIC_PATH_PROMOTE_STRIKES; roundIndex += 1) {
      const round = await runFabricRendezvousRound({
        db: stampDb(),
        registry: {} as DaemonCellRegistry,
        fabricId: FABRIC_ID,
        relays,
        pathStates: hydrateFabricPathStates(FABRIC_ID, relays),
        orgAllowRelay: false,
      });
      if (!round) throw new TypeError("expected a rendezvous round");
      applySummaries(relays, round.summariesByServerId);
      selected = round.pathStates.get(fabricPairCacheKey("srv-a", "srv-b"))
        ?.selected ?? selected;
    }
    assertEquals(selected, "direct_nat");
  } finally {
    setCollectFabricPathObservationsForTests(null);
    resetFabricPathStateCacheForTests();
  }
});

test("hydrateFabricPathStates prunes pairs for removed relays", () => {
  resetFabricPathStateCacheForTests();
  try {
    rememberFabricPathStates(
      FABRIC_ID,
      new Map([
        [fabricPairCacheKey("srv-a", "srv-b"), {
          ...initialFabricPathState("srv-b"),
          selected: "direct_public",
          demoteStrikes: 1,
        }],
        [fabricPairCacheKey("srv-a", "srv-c"), {
          ...initialFabricPathState("srv-c"),
          selected: "direct_public",
          demoteStrikes: 2,
        }],
      ]),
    );
    const hydrated = hydrateFabricPathStates(FABRIC_ID, [
      keyedRelay({ serverId: "srv-a", publicKey: KEY_A }),
      keyedRelay({ serverId: "srv-b", publicKey: KEY_B }),
    ]);
    assertEquals(hydrated.has(fabricPairCacheKey("srv-a", "srv-c")), false);
    assertEquals(
      hydrated.get(fabricPairCacheKey("srv-a", "srv-b"))?.demoteStrikes,
      1,
    );
  } finally {
    resetFabricPathStateCacheForTests();
  }
});
