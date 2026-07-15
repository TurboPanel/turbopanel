import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
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

it("resolveServerUpdateStatus marks manifest resolution failure as unknown target", async () => {
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

it("resolveServerUpdateStatus returns updating for in-flight update request", async () => {
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current: { commit: "aaa", buildId: "b1" },
    listUpdateRequests: async () => [request({ status: "sent" })],
  });

  assertEquals(resolved.status, "updating");
});

it("resolveServerUpdateStatus returns updating after successful ack until commit matches", async () => {
  const finishedAt = new Date().toISOString();
  const current = { commit: "aaa", buildId: "b1" };
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current,
    targetManifest: {
      commit: "bbb",
      buildId: "b2",
      builtAt: "2020-01-01T00:00:00.000Z",
      channel: "trunk",
      manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
    },
    listUpdateRequests: async () => [
      request({ status: "done", finishedAt }),
    ],
  });

  assertEquals(resolved.status, "updating");
});

it("resolveServerUpdateStatus uses shared target manifest without refetching", async () => {
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current: { commit: "aaa", buildId: "b1" },
    targetManifest: {
      commit: "bbb",
      buildId: "b2",
      builtAt: "2020-01-01T00:00:00.000Z",
      channel: "trunk",
      manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
    },
    listUpdateRequests: async () => [],
  });

  assertEquals(resolved.targetStatus, "ok");
  assertEquals(resolved.target?.commit, "bbb");
  assertEquals(resolved.updateAvailable, true);
});

it("resolveServerUpdateStatus returns idle after pending window expires", async () => {
  const finishedAt = new Date(Date.now() - 121_000).toISOString();
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current: { commit: "aaa", buildId: "b1" },
    targetManifest: {
      commit: "bbb",
      buildId: "b2",
      builtAt: "2020-01-01T00:00:00.000Z",
      channel: "trunk",
      manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
    },
    listUpdateRequests: async () => [
      request({ status: "done", finishedAt }),
    ],
  });

  assertEquals(resolved.status, "idle");
  assertEquals(resolved.updateAvailable, true);
});

it("resolveServerUpdateStatus surfaces last error but stays idle when update still available", async () => {
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current: { commit: "51e32ad", buildId: "b1" },
    targetManifest: {
      commit: "203fcb3",
      buildId: "b2",
      builtAt: "2020-01-01T00:00:00.000Z",
      channel: "trunk",
      manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
    },
    listUpdateRequests: async () => [
      request({ status: "failed", error: "reconcile failed" }),
    ],
  });

  assertEquals(resolved.status, "idle");
  assertEquals(resolved.updateAvailable, true);
  assertEquals(resolved.lastUpdateError, "reconcile failed");
});

it("resolveServerUpdateStatus returns error for failed update when already on trunk", async () => {
  const commit = "51e32ad";
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current: { commit, buildId: "b1" },
    targetManifest: {
      commit,
      buildId: "b2",
      builtAt: "2020-01-01T00:00:00.000Z",
      channel: "trunk",
      manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
    },
    listUpdateRequests: async () => [
      request({ status: "failed", error: "checksum mismatch" }),
    ],
  });

  assertEquals(resolved.status, "error");
  assertEquals(resolved.updateAvailable, false);
  assertEquals(resolved.lastUpdateError, "checksum mismatch");
});

it("resolveServerUpdateStatus ignores stale failed request when daemon matches trunk", async () => {
  const commit = "51e32ad";
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current: { commit, buildId: "b1" },
    targetManifest: {
      commit,
      buildId: "b2",
      builtAt: "2020-01-01T00:00:00.000Z",
      channel: "trunk",
      manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
    },
    listUpdateRequests: async () => [
      request({
        status: "failed",
        error: "reconcile failed",
        createdAt: "2020-01-01T00:00:00.000Z",
      }),
      request({
        status: "done",
        createdAt: "2020-01-02T00:00:00.000Z",
        finishedAt: "2020-01-02T00:00:01.000Z",
      }),
    ],
  });

  assertEquals(resolved.status, "idle");
  assertEquals(resolved.updateAvailable, false);
});

it("resolveServerUpdateStatus blocks remote updates for co-located daemons", async () => {
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current: { commit: "aaa", buildId: "b1" },
    colocatedWithInstance: true,
    targetManifest: {
      commit: "bbb",
      buildId: "b2",
      builtAt: "2020-01-01T00:00:00.000Z",
      channel: "trunk",
      manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
    },
    listUpdateRequests: async () => [],
  });

  assertEquals(resolved.updateAvailable, false);
  assertEquals(resolved.updateBlocked, true);
  assertEquals(
    resolved.updateBlockedReason,
    "The co-located development daemon cannot be updated from the control plane",
  );
});

it("resolveServerUpdateStatus does not offer update when running commit is unknown", async () => {
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current: null,
    targetManifest: {
      commit: "bbb",
      buildId: "b2",
      builtAt: "2020-01-01T00:00:00.000Z",
      channel: "trunk",
      manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
    },
    listUpdateRequests: async () => [],
  });

  assertEquals(resolved.targetStatus, "ok");
  assertEquals(resolved.updateAvailable, false);
});

it("resolveServerUpdateStatus computes updateAvailable only with known target", async () => {
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

it("resolveServerUpdateStatus returns updating from projected update summary", async () => {
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current: { commit: "aaa", buildId: "b1" },
    projectedUpdate: { status: "updating" },
  });

  assertEquals(resolved.status, "updating");
});

it("resolveServerUpdateStatus returns updating from projected done with commit drift", async () => {
  const finishedAt = new Date().toISOString();
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current: { commit: "aaa", buildId: "b1" },
    targetManifest: {
      commit: "bbb",
      buildId: "b2",
      builtAt: "2020-01-01T00:00:00.000Z",
      channel: "trunk",
      manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
    },
    projectedUpdate: { status: "done", finishedAt },
  });

  assertEquals(resolved.status, "updating");
});

it("resolveServerUpdateStatus surfaces last error from projected failed update", async () => {
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current: { commit: "51e32ad", buildId: "b1" },
    targetManifest: {
      commit: "203fcb3",
      buildId: "b2",
      builtAt: "2020-01-01T00:00:00.000Z",
      channel: "trunk",
      manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
    },
    projectedUpdate: { status: "failed", error: "reconcile failed" },
  });

  assertEquals(resolved.status, "idle");
  assertEquals(resolved.lastUpdateError, "reconcile failed");
});

it("resolveServerUpdateStatus returns idle from projected idle summary", async () => {
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current: { commit: "aaa", buildId: "b1" },
    projectedUpdate: { status: "idle" },
  });

  assertEquals(resolved.status, "idle");
});

it("resolveServerUpdateStatus ignores stale projected updating when daemon matches trunk", async () => {
  const commit = "51e32ad";
  const resolved = await resolveServerUpdateStatus({
    serverId: "srv-1",
    current: { commit, buildId: "b1" },
    targetManifest: {
      commit,
      buildId: "b2",
      builtAt: "2020-01-01T00:00:00.000Z",
      channel: "trunk",
      manifestUrl: "https://dl.trbp.nl/channels/trunk/manifest.json",
    },
    projectedUpdate: {
      status: "updating",
      requestId: "req-stale",
      queuedAt: "2020-01-01T00:00:00.000Z",
    },
  });

  assertEquals(resolved.status, "idle");
  assertEquals(resolved.updateAvailable, false);
  assertEquals(resolved.canResetUpdateStatus, true);
});
