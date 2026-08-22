/**
 * Host-free coverage for container-log flag convergence on an *idle* daemon
 * connection (no Postgres).
 *
 * The daemon only learns that `organization.options.containerLogsEnabled`
 * flipped from a `presence-ack`, and the control plane only sends one in answer
 * to a frame it received. An idle daemon sends the raw cell ping and — on the
 * refresh floor — a bare `heartbeat`; both have to converge the flag, or
 * collection stays stuck on (or off) until something unrelated changes. The
 * daemon half of this is `turbopaneld/src/instance/idle-presence.ts`.
 */

import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { Db } from "../db.ts";
import type { DaemonCellRegistry } from "./cell/contracts.ts";
import { handleDaemonCellPing } from "./deno-ws.ts";
import {
  CONTAINER_LOGS_FLAG_TTL_MS,
  loadServerContainerLogsEnabledCached,
  resetContainerLogsFlagCacheForTests,
} from "./container-logs-presence.ts";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";

/**
 * Drizzle-shaped double.
 *
 * The org-flag lookup joins `server` to `organization`; the daemon-state
 * lookup does not. `innerJoin` is therefore all this needs to tell them apart —
 * and the un-joined read answers empty, which parses to "no daemon state" and
 * ends the ping handler without any further work.
 */
function fakeDb(readOptions: () => unknown): Db {
  const makeChain = (joined: boolean) => {
    const chain = {
      from: () => chain,
      innerJoin: () => makeChain(true),
      where: () => chain,
      limit: () => Promise.resolve(joined ? [{ options: readOptions() }] : []),
    };
    return chain;
  };
  return { select: () => makeChain(false) } as unknown as Db;
}

type Cell = ReturnType<DaemonCellRegistry["getCell"]>;

function fakeCell(): Cell {
  return {
    getSnapshot: () =>
      Promise.resolve({
        serverId: SERVER_ID,
        version: 1,
        updatedAt: "2026-08-21T10:00:00.000Z",
        connected: true,
        lastSeenAt: "2026-08-21T10:00:00.000Z",
        lastInboundAt: "2026-08-21T10:00:00.000Z",
      }),
    recordInbound: () => Promise.resolve(),
  } as unknown as Cell;
}

function fakeSocket(): { frames: string[]; ws: never } {
  const frames: string[] = [];
  return {
    frames,
    ws: { send: (data: string) => frames.push(data) } as unknown as never,
  };
}

function acks(frames: readonly string[]): Record<string, unknown>[] {
  return frames
    .map((frame) => JSON.parse(frame) as Record<string, unknown>)
    .filter((frame) => frame.type === "presence-ack");
}

describe("cell ping presence ack", () => {
  it("answers an idle ping with the organization's switch", async () => {
    resetContainerLogsFlagCacheForTests();
    const socket = fakeSocket();
    await handleDaemonCellPing({
      cell: fakeCell(),
      db: fakeDb(() => ({ containerLogsEnabled: true })),
      serverId: SERVER_ID,
      connectionId: "conn-1",
      ws: socket.ws,
    });

    assert(socket.frames.includes('{"type":"pong"}'));
    const sent = acks(socket.frames);
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.containerLogsEnabled, true);
    assert(!Number.isNaN(Date.parse(String(sent[0]?.at))));
    resetContainerLogsFlagCacheForTests();
  });

  it("carries a mid-session toggle to an otherwise-silent daemon", async () => {
    resetContainerLogsFlagCacheForTests();
    let enabled = false;
    const db = fakeDb(() => ({ containerLogsEnabled: enabled }));
    const cell = fakeCell();

    const first = fakeSocket();
    await handleDaemonCellPing({
      cell,
      db,
      serverId: SERVER_ID,
      connectionId: "conn-1",
      ws: first.ws,
    });
    assertEquals(acks(first.frames)[0]?.containerLogsEnabled, false);

    // An operator turns retention on. The daemon has sent nothing but pings —
    // no hello, no changed presence fact — so this ping is the only chance the
    // flag has to reach it.
    enabled = true;
    resetContainerLogsFlagCacheForTests(); // stands in for the TTL elapsing

    const second = fakeSocket();
    await handleDaemonCellPing({
      cell,
      db,
      serverId: SERVER_ID,
      connectionId: "conn-1",
      ws: second.ws,
    });
    assertEquals(acks(second.frames)[0]?.containerLogsEnabled, true);
    resetContainerLogsFlagCacheForTests();
  });

  it("never lets an ack failure fail the ping", async () => {
    resetContainerLogsFlagCacheForTests();
    const socket = fakeSocket();
    const exploding = {
      send: (data: string) => {
        if (data !== '{"type":"pong"}') throw new Error("socket went away");
        socket.frames.push(data);
      },
    } as unknown as never;

    await handleDaemonCellPing({
      cell: fakeCell(),
      db: fakeDb(() => ({ containerLogsEnabled: true })),
      serverId: SERVER_ID,
      connectionId: "conn-1",
      ws: exploding,
    });
    assert(socket.frames.includes('{"type":"pong"}'));
    resetContainerLogsFlagCacheForTests();
  });
});

describe("loadServerContainerLogsEnabledCached", () => {
  it("re-reads once the TTL elapses so a toggle converges", async () => {
    resetContainerLogsFlagCacheForTests();
    let enabled = false;
    let reads = 0;
    const db = fakeDb(() => {
      reads += 1;
      return { containerLogsEnabled: enabled };
    });

    assertEquals(
      await loadServerContainerLogsEnabledCached(db, SERVER_ID, 0),
      false,
    );
    enabled = true;
    // Inside the window the cached answer stands — this is what keeps the
    // per-minute ping path off the projection database.
    assertEquals(
      await loadServerContainerLogsEnabledCached(db, SERVER_ID, 1_000),
      false,
    );
    assertEquals(reads, 1);

    assertEquals(
      await loadServerContainerLogsEnabledCached(
        db,
        SERVER_ID,
        CONTAINER_LOGS_FLAG_TTL_MS + 1,
      ),
      true,
    );
    assertEquals(reads, 2);
    resetContainerLogsFlagCacheForTests();
  });
});
