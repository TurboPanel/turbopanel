import { assertEquals } from "@std/assert";
import {
  type FabricPathState,
  FABRIC_PATH_DEMOTE_STRIKES,
  FABRIC_PATH_PROMOTE_STRIKES,
  initialFabricPathState,
  nextFabricPathState,
} from "./path-state.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const POLICY = { orgAllowRelay: false, relayAllowRelay: null as boolean | null };

function healthyDirect(state: FabricPathState): FabricPathState {
  return nextFabricPathState(state, {
    health: "healthy",
    kind: "direct_public",
    endpoint: "203.0.113.10:51820",
  }, POLICY);
}

test("nextFabricPathState keeps a healthy direct path", () => {
  let state = initialFabricPathState("peer");
  state = healthyDirect(state);
  state = healthyDirect(state);
  state = healthyDirect(state);
  assertEquals(state.selected, "direct_public");
  assertEquals(state.degraded, false);
  assertEquals(state.demoteStrikes, 0);
});

test("nextFabricPathState demotes a direct path after consecutive unhealthy rounds", () => {
  let state = initialFabricPathState("peer");
  for (let i = 0; i < FABRIC_PATH_PROMOTE_STRIKES; i += 1) {
    state = healthyDirect(state);
  }
  assertEquals(state.selected, "direct_public");
  for (let i = 0; i < FABRIC_PATH_DEMOTE_STRIKES - 1; i += 1) {
    state = nextFabricPathState(state, { health: "stale" }, POLICY);
    assertEquals(state.selected, "direct_public");
    assertEquals(state.degraded, true);
  }
  state = nextFabricPathState(state, {
    health: "stale",
    natEndpoint: "203.0.113.50:48172",
  }, POLICY);
  assertEquals(state.selected, "unreachable");
});

test("nextFabricPathState does not select direct_nat from natEndpoint alone", () => {
  const state = nextFabricPathState(initialFabricPathState("peer"), {
    health: "never",
    natEndpoint: "203.0.113.50:48172",
  }, POLICY);
  assertEquals(state.selected, "unreachable");
});

test("nextFabricPathState selects direct_nat after demote only with a successful NAT probe", () => {
  let state = initialFabricPathState("peer");
  for (let i = 0; i < FABRIC_PATH_PROMOTE_STRIKES; i += 1) {
    state = healthyDirect(state);
  }
  for (let i = 0; i < FABRIC_PATH_DEMOTE_STRIKES; i += 1) {
    state = nextFabricPathState(state, { health: "stale" }, POLICY);
  }
  assertEquals(state.selected, "unreachable");
  state = nextFabricPathState(state, {
    health: "never",
    natEndpoint: "203.0.113.50:48172",
    natProbeSucceeded: true,
  }, POLICY);
  assertEquals(state.selected, "direct_nat");
  assertEquals(state.endpoint, "203.0.113.50:48172");
});

test("nextFabricPathState requires promote strikes before returning to a direct path", () => {
  let state: FabricPathState = {
    ...initialFabricPathState("peer"),
    selected: "gateway",
    viaServerId: "gw-1",
  };
  state = nextFabricPathState(state, {
    health: "healthy",
    kind: "direct_nat",
    endpoint: "203.0.113.50:48172",
  }, POLICY);
  assertEquals(state.selected, "gateway");
  assertEquals(state.degraded, true);
  assertEquals(state.promoteStrikes, 1);
  state = nextFabricPathState(state, {
    health: "healthy",
    kind: "direct_nat",
    endpoint: "203.0.113.50:48172",
  }, POLICY);
  assertEquals(state.selected, "direct_nat");
  assertEquals(state.degraded, false);
  assertEquals(state.promoteStrikes, 0);
});

test("nextFabricPathState stays unreachable when allowRelay is true but no relay exists", () => {
  const state = nextFabricPathState(initialFabricPathState("peer"), {
    health: "never",
  }, { orgAllowRelay: true, relayAllowRelay: null });
  assertEquals(state.selected, "unreachable");
});

test("nextFabricPathState prefers a healthy gateway over unreachable", () => {
  const state = nextFabricPathState(initialFabricPathState("peer"), {
    health: "never",
    gatewayAvailable: true,
    viaServerId: "gw-1",
  }, POLICY);
  assertEquals(state.selected, "gateway");
  assertEquals(state.viaServerId, "gw-1");
});
