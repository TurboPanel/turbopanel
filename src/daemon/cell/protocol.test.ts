import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert";
import {
  type DaemonMessage,
  generateDeliveryId,
  generateRequestId,
  outboundEnvelopeToWireMessage,
  parseDaemonMessage,
  wireMessageToInboundEnvelope,
} from "./protocol.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.test("parseDaemonMessage round-trips valid JSON", () => {
  const msg: DaemonMessage = {
    type: "pong",
    id: "req-1",
    at: "2020-01-01T00:00:00.000Z",
  };
  const parsed = parseDaemonMessage(JSON.stringify(msg));
  assertEquals(parsed, msg);
});

Deno.test("parseDaemonMessage returns null for invalid JSON", () => {
  assertEquals(parseDaemonMessage("not-json"), null);
});

Deno.test("wireMessageToInboundEnvelope maps inbound wire types", () => {
  const at = "2020-01-01T00:00:00.000Z";

  assertEquals(
    wireMessageToInboundEnvelope({ type: "pong", id: "r1", at }),
    { kind: "pong", requestId: "r1", at },
  );

  assertEquals(
    wireMessageToInboundEnvelope({
      type: "addresses-result",
      id: "r2",
      at,
      addresses: {
        privateIpv4: [],
        privateIpv6: [],
        publicIpv4: ["1.2.3.4"],
        publicIpv6: [],
      },
    }),
    {
      kind: "addresses-result",
      requestId: "r2",
      at,
      addresses: {
        privateIpv4: [],
        privateIpv6: [],
        publicIpv4: ["1.2.3.4"],
        publicIpv6: [],
      },
    },
  );

  assertEquals(
    wireMessageToInboundEnvelope({
      type: "command-result",
      id: "r3",
      at,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    }),
    {
      kind: "command-result",
      requestId: "r3",
      at,
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    },
  );

  assertEquals(
    wireMessageToInboundEnvelope({
      type: "dev-sync-result",
      id: "r4",
      at,
      ok: true,
    }),
    {
      kind: "dev-sync-result",
      requestId: "r4",
      at,
      ok: true,
      error: undefined,
    },
  );

  assertEquals(
    wireMessageToInboundEnvelope({
      type: "tunnel-token-result",
      id: "r5",
      at,
      ok: false,
      error: "nope",
    }),
    {
      kind: "tunnel-token-result",
      requestId: "r5",
      at,
      ok: false,
      error: "nope",
    },
  );

  assertEquals(
    wireMessageToInboundEnvelope({
      type: "update-result",
      id: "r6",
      at,
      ok: true,
    }),
    { kind: "update-result", requestId: "r6", at, ok: true, error: undefined },
  );

  assertEquals(
    wireMessageToInboundEnvelope({
      type: "public-urls-update-result",
      id: "r7",
      at,
      ok: true,
    }),
    {
      kind: "public-urls-update-result",
      requestId: "r7",
      at,
      ok: true,
      error: undefined,
    },
  );

  assertEquals(
    wireMessageToInboundEnvelope({
      type: "public-urls-update-result",
      id: "r8",
      at,
      ok: false,
      error: "cert regen failed",
    }),
    {
      kind: "public-urls-update-result",
      requestId: "r8",
      at,
      ok: false,
      error: "cert regen failed",
    },
  );
});

Deno.test("wireMessageToInboundEnvelope returns null for non-inbound types", () => {
  assertEquals(
    wireMessageToInboundEnvelope({
      type: "command",
      id: "r7",
      command: "echo hi",
      at: "2020-01-01T00:00:00.000Z",
    }),
    null,
  );
});

Deno.test("wireMessageToInboundEnvelope validates monitor.sync shape", () => {
  const at = "2020-01-01T00:00:00.000Z";
  assertEquals(
    wireMessageToInboundEnvelope({
      type: "monitor.sync",
      from: "daemon",
      serverId: "srv-1",
      at,
      sequence: 1,
      instance: {},
      resources: [{
        resourceKey: "container:abc",
        kind: "container",
        status: "healthy",
      }],
      protocolVersion: 1,
    }),
    {
      kind: "monitor-sync",
      serverId: "srv-1",
      sequence: 1,
      at,
      protocolVersion: 1,
      instance: {},
      resources: [{
        resourceKey: "container:abc",
        kind: "container",
        status: "healthy",
      }],
      events: undefined,
    },
  );
  assertEquals(
    wireMessageToInboundEnvelope({
      type: "monitor.sync",
      from: "daemon",
      serverId: "srv-1",
      at,
      sequence: 1,
      instance: {},
      resources: "not-an-array",
      protocolVersion: 1,
    } as unknown as DaemonMessage),
    null,
  );
});

Deno.test("wireMessageToInboundEnvelope validates monitor.transition shape", () => {
  const at = "2020-01-01T00:00:00.000Z";
  assertEquals(
    wireMessageToInboundEnvelope({
      type: "monitor.transition",
      from: "daemon",
      serverId: "srv-1",
      at,
      sequence: 2,
      events: [{
        resourceKey: "container:abc",
        kind: "container",
        toStatus: "unhealthy",
        at,
      }],
    }),
    {
      kind: "monitor-transition",
      serverId: "srv-1",
      sequence: 2,
      at,
      events: [{
        resourceKey: "container:abc",
        kind: "container",
        toStatus: "unhealthy",
        at,
      }],
      resources: undefined,
    },
  );
  assertEquals(
    wireMessageToInboundEnvelope({
      type: "monitor.transition",
      from: "daemon",
      serverId: "srv-1",
      at,
      sequence: 2,
    } as unknown as DaemonMessage),
    null,
  );
});

Deno.test("wireMessageToInboundEnvelope validates monitor.heartbeat shape", () => {
  const at = "2020-01-01T00:00:00.000Z";
  assertEquals(
    wireMessageToInboundEnvelope({
      type: "monitor.heartbeat",
      from: "daemon",
      serverId: "srv-1",
      at,
      sequence: 3,
      instance: {},
    }),
    {
      kind: "monitor-heartbeat",
      serverId: "srv-1",
      sequence: 3,
      at,
      instance: {},
      resources: undefined,
      events: undefined,
    },
  );
  assertEquals(
    wireMessageToInboundEnvelope({
      type: "monitor.heartbeat",
      from: "daemon",
      serverId: "srv-1",
      at,
      sequence: 3,
      instance: {},
      resources: "bad",
    } as unknown as DaemonMessage),
    null,
  );
});

Deno.test("outboundEnvelopeToWireMessage maps outbound kinds", () => {
  const base = {
    deliveryId: crypto.randomUUID(),
    requestId: "req-1",
    at: "2020-01-01T00:00:00.000Z",
  };

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: "command",
      command: "uptime",
    }),
    { type: "command", id: "req-1", command: "uptime", at: base.at },
  );

  assertEquals(
    outboundEnvelopeToWireMessage({ ...base, kind: "addresses-request" }),
    { type: "addresses-request", id: "req-1", at: base.at },
  );

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: "dev-sync",
      phase: "begin",
      totalChunks: 2,
      totalBytes: 100,
    }),
    {
      type: "dev-sync-begin",
      id: "req-1",
      totalChunks: 2,
      totalBytes: 100,
      at: base.at,
    },
  );

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: "dev-sync",
      phase: "chunk",
      index: 0,
      data: "abc",
    }),
    {
      type: "dev-sync-chunk",
      id: "req-1",
      index: 0,
      data: "abc",
      at: base.at,
    },
  );

  assertEquals(
    outboundEnvelopeToWireMessage({ ...base, kind: "dev-sync", phase: "end" }),
    { type: "dev-sync-end", id: "req-1", at: base.at },
  );

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: "tunnel-token",
      token: "tok",
    }),
    { type: "tunnel-token", id: "req-1", token: "tok", at: base.at },
  );

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: "public-urls-update",
      urls: ["https://panel.example.com", "huey.lan:8443"],
    }),
    {
      type: "public-urls-update",
      id: "req-1",
      urls: ["https://panel.example.com", "huey.lan:8443"],
      at: base.at,
    },
  );

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: "update",
      updateUrl: "https://example.com/update",
      updateSha256: "a".repeat(64),
    }),
    {
      type: "update",
      id: "req-1",
      updateUrl: "https://example.com/update",
      updateSha256: "a".repeat(64),
      at: base.at,
    },
  );

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: "update",
      channel: "trunk",
    }),
    {
      type: "update",
      id: "req-1",
      channel: "trunk",
      at: base.at,
    },
  );
});

Deno.test("outboundEnvelopeToWireMessage maps monitor-ack", () => {
  const at = "2020-01-01T00:00:00.000Z";
  assertEquals(
    outboundEnvelopeToWireMessage({
      kind: "monitor-ack",
      deliveryId: crypto.randomUUID(),
      requestId: "req-ack",
      at,
      serverId: "srv-1",
      acceptedSequence: 7,
    }),
    {
      type: "monitor.ack",
      from: "instance",
      serverId: "srv-1",
      at,
      acceptedSequence: 7,
      resyncNeeded: undefined,
    },
  );
  assertEquals(
    outboundEnvelopeToWireMessage({
      kind: "monitor-ack",
      deliveryId: crypto.randomUUID(),
      requestId: "req-ack-2",
      at,
      serverId: "srv-1",
      acceptedSequence: 7,
      resyncNeeded: true,
    }),
    {
      type: "monitor.ack",
      from: "instance",
      serverId: "srv-1",
      at,
      acceptedSequence: 7,
      resyncNeeded: true,
    },
  );
});

Deno.test("wireMessageToInboundEnvelope rejects monitor.ack from daemon", () => {
  assertEquals(
    wireMessageToInboundEnvelope({
      type: "monitor.ack",
      from: "daemon",
      serverId: "srv-1",
      at: "2020-01-01T00:00:00.000Z",
      acceptedSequence: 1,
    } as unknown as DaemonMessage),
    null,
  );
});

Deno.test("generateRequestId and generateDeliveryId are UUIDs", () => {
  const requestId = generateRequestId();
  const deliveryId = generateDeliveryId();
  assert(UUID_RE.test(requestId));
  assert(UUID_RE.test(deliveryId));
});

Deno.test("generateRequestId and generateDeliveryId are unique across calls", () => {
  assertNotEquals(generateRequestId(), generateRequestId());
  assertNotEquals(generateDeliveryId(), generateDeliveryId());
});

Deno.test("deliveryId and requestId are independent UUIDs", () => {
  const requestId = generateRequestId();
  const deliveryId = generateDeliveryId();
  assertNotEquals(requestId, deliveryId);
});
