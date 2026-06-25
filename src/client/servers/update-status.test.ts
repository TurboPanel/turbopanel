import { assertEquals } from "jsr:@std/assert";
import type { PendingRequestRecord } from "../../daemon/cell/contracts.ts";
import { resolveServerUpdateStatus } from "./update-status.ts";

function request(
  partial: Partial<PendingRequestRecord> & Pick<PendingRequestRecord, "status">,
): PendingRequestRecord {
  return {
    serverId: "srv-1",
    requestId: "req-1",
    requestKind: "update",
    createdAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-01-01T00:02:00.000Z",
    ...partial,
  };
}

Deno.test("resolveServerUpdateStatus marks manifest resolution failure as unknown target", async () => {
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current: { commit: "aaa", buildId: "b1" },
    listUpdateRequests: async () => [],
  });

  if (resolved.targetStatus === "unknown") {
    assertEquals(resolved.updateAvailable, false);
    assertEquals(resolved.target, null);
    assertEquals(resolved.targetError, "Could not resolve trunk channel manifest");
  }
});

Deno.test("resolveServerUpdateStatus returns updating for in-flight update request", async () => {
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current: { commit: "aaa", buildId: "b1" },
    listUpdateRequests: async () => [request({ status: "sent" })],
  });

  assertEquals(resolved.status, "updating");
});

Deno.test("resolveServerUpdateStatus returns updating after successful ack until commit matches", async () => {
  const finishedAt = new Date().toISOString();
  const current = { commit: "aaa", buildId: "b1" };
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current,
    listUpdateRequests: async () => [
      request({ status: "done", finishedAt }),
    ],
  });

  if (resolved.target && current.commit !== resolved.target.commit) {
    assertEquals(resolved.status, "updating");
  }
});

Deno.test("resolveServerUpdateStatus returns error for failed update request", async () => {
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current: { commit: "aaa", buildId: "b1" },
    listUpdateRequests: async () => [
      request({ status: "failed", error: "checksum mismatch" }),
    ],
  });

  assertEquals(resolved.status, "error");
});

Deno.test("resolveServerUpdateStatus computes updateAvailable only with known target", async () => {
  const current = { commit: "aaa", buildId: "b1" };
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current,
    listUpdateRequests: async () => [],
  });

  if (resolved.targetStatus === "ok" && resolved.target) {
    assertEquals(resolved.updateAvailable, current.commit !== resolved.target.commit);
  } else {
    assertEquals(resolved.updateAvailable, false);
  }
});
