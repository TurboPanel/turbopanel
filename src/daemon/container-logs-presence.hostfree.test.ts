import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { Db } from "../db.ts";
import {
  buildPresenceAck,
  loadServerContainerLogsEnabled,
  resetContainerLogBackendAvailabilityForTests,
  resetContainerLogsFlagCacheForTests,
  resolveDaemonContainerLogsFlag,
  setContainerLogBackendAvailable,
} from "./container-logs-presence.ts";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";

/** Drizzle-shaped stub whose single select resolves to `rows`. */
function fakeDb(rows: unknown[] | Error): Db {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit:
      () => (rows instanceof Error
        ? Promise.reject(rows)
        : Promise.resolve(rows)),
  };
  return { select: () => chain } as unknown as Db;
}

describe("buildPresenceAck", () => {
  it("carries the switch and a timestamp", () => {
    const ack = buildPresenceAck(true, "2026-08-21T10:00:00.000Z");
    assertEquals(ack, {
      type: "presence-ack",
      at: "2026-08-21T10:00:00.000Z",
      containerLogsEnabled: true,
    });
  });

  it("defaults the timestamp to now", () => {
    const ack = buildPresenceAck(false);
    assertEquals(ack.containerLogsEnabled, false);
    assert(!Number.isNaN(Date.parse(ack.at)));
  });
});

describe("loadServerContainerLogsEnabled", () => {
  it("reports the owning organization's switch", async () => {
    const db = fakeDb([{ options: { containerLogsEnabled: true } }]);
    assertEquals(await loadServerContainerLogsEnabled(db, SERVER_ID), true);
  });

  it("is off when the organization never opted in", async () => {
    const db = fakeDb([{ options: {} }]);
    assertEquals(await loadServerContainerLogsEnabled(db, SERVER_ID), false);
  });

  it("is off for an unowned or unknown server", async () => {
    assertEquals(
      await loadServerContainerLogsEnabled(fakeDb([]), SERVER_ID),
      false,
    );
  });

  it("fails to off rather than throwing into the presence path", async () => {
    const db = fakeDb(new Error("projection db unavailable"));
    assertEquals(await loadServerContainerLogsEnabled(db, SERVER_ID), false);
  });
});

describe("resolveDaemonContainerLogsFlag", () => {
  it("is on only when the org switch and the backend agree", async () => {
    resetContainerLogsFlagCacheForTests();
    resetContainerLogBackendAvailabilityForTests();
    const enabledOrg = fakeDb([{ options: { containerLogsEnabled: true } }]);
    assertEquals(
      await resolveDaemonContainerLogsFlag(enabledOrg, SERVER_ID),
      true,
    );

    // Platform kill switch: a daemon must not stream into a control plane
    // whose only option is to drop what it sends.
    resetContainerLogsFlagCacheForTests();
    setContainerLogBackendAvailable(false);
    assertEquals(
      await resolveDaemonContainerLogsFlag(enabledOrg, SERVER_ID),
      false,
    );

    resetContainerLogsFlagCacheForTests();
    resetContainerLogBackendAvailabilityForTests();
    const disabledOrg = fakeDb([{ options: {} }]);
    assertEquals(
      await resolveDaemonContainerLogsFlag(disabledOrg, SERVER_ID),
      false,
    );
    resetContainerLogsFlagCacheForTests();
  });

  it("skips the projection read entirely when no backend is bound", async () => {
    resetContainerLogsFlagCacheForTests();
    setContainerLogBackendAvailable(false);
    try {
      const exploding = {
        select: () => {
          throw new Error("must not query");
        },
      } as unknown as Db;
      assertEquals(
        await resolveDaemonContainerLogsFlag(exploding, SERVER_ID),
        false,
      );
    } finally {
      resetContainerLogBackendAvailabilityForTests();
      resetContainerLogsFlagCacheForTests();
    }
  });
});
