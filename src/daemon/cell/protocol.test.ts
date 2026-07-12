import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert";
import { it } from "@std/testing/bdd";
import {
  type DaemonMessage,
  DAEMON_INBOUND_ALLOWED,
  generateDeliveryId,
  generateRequestId,
  outboundEnvelopeToWireMessage,
  parseDaemonMessage,
  wireMessageToInboundEnvelope,
} from "./protocol.ts";
import {
  buildHostMetricsSample,
  METRICS_SCHEMA_VERSION,
} from "../metrics/contract.ts";


const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TEST_PUBLIC_IPV4 = '203.0.113.1' // RFC 5737 TEST-NET-3

it('parseDaemonMessage round-trips valid JSON', () => {
  const msg: DaemonMessage = {
    type: "heartbeat",
    at: "2020-01-01T00:00:00.000Z",
  };
  const parsed = parseDaemonMessage(JSON.stringify(msg));
  assertEquals(parsed, msg);
});

it("parseDaemonMessage returns null for invalid JSON", () => {
  assertEquals(parseDaemonMessage("not-json"), null);
});

it("wireMessageToInboundEnvelope maps inbound wire types", () => {
  const at = "2020-01-01T00:00:00.000Z";

  assertEquals(
    wireMessageToInboundEnvelope({
      type: "addresses-result",
      id: "r2",
      at,
      addresses: {
        privateIpv4: [],
        privateIpv6: [],
        publicIpv4: [TEST_PUBLIC_IPV4],
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
        publicIpv4: [TEST_PUBLIC_IPV4],
        publicIpv6: [],
      },
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

  assertEquals(
    wireMessageToInboundEnvelope({
      type: "command-ack",
      id: "r9",
      at,
      daemonReceivedAt: "2020-01-01T00:00:01.000Z",
    }),
    {
      kind: "command-ack",
      requestId: "r9",
      at,
      daemonReceivedAt: "2020-01-01T00:00:01.000Z",
    },
  );

  assertEquals(
    wireMessageToInboundEnvelope({
      type: "command-outcome",
      id: "r10",
      at,
      ok: true,
      result: { pong: true },
      daemonReceivedAt: "2020-01-01T00:00:01.000Z",
      daemonRespondedAt: "2020-01-01T00:00:02.000Z",
    }),
    {
      kind: "command-outcome",
      requestId: "r10",
      at,
      ok: true,
      result: { pong: true },
      error: undefined,
      daemonReceivedAt: "2020-01-01T00:00:01.000Z",
      daemonRespondedAt: "2020-01-01T00:00:02.000Z",
    },
  );

  assertEquals(
    wireMessageToInboundEnvelope({
      type: "command-outcome",
      id: "r11",
      at,
      ok: false,
      error: "timeout",
      daemonRespondedAt: "2020-01-01T00:00:03.000Z",
    }),
    {
      kind: "command-outcome",
      requestId: "r11",
      at,
      ok: false,
      result: undefined,
      error: "timeout",
      daemonReceivedAt: undefined,
      daemonRespondedAt: "2020-01-01T00:00:03.000Z",
    },
  );
});

it("wireMessageToInboundEnvelope returns null for non-inbound types", () => {
  assertEquals(
    wireMessageToInboundEnvelope({
      type: "command-dispatch",
      id: "r7",
      commandId: "cmd-1",
      commandType: "daemon.ping",
      payload: {},
      at: "2020-01-01T00:00:00.000Z",
    }),
    null,
  );
});

it("metrics message is accepted without a cell envelope", () => {
  const msg: DaemonMessage = buildHostMetricsSample({
    at: "2020-01-01T00:00:00.000Z",
    intervalSeconds: 60,
    sequence: 1,
    metrics: { cpuUsagePercent: 10 },
    dimensions: {
      schemaVersion: METRICS_SCHEMA_VERSION,
      daemonVersion: "test",
      operatingSystem: "linux",
      architecture: "aarch64",
      kernelRelease: "6.12.0",
    },
  });

  const parsed = parseDaemonMessage(JSON.stringify(msg));
  assertEquals(parsed, msg);
  assert(DAEMON_INBOUND_ALLOWED.has("metrics"));
  assertEquals(wireMessageToInboundEnvelope(msg), null);
});


it("outboundEnvelopeToWireMessage maps outbound kinds", () => {
  const base = {
    deliveryId: crypto.randomUUID(),
    requestId: "req-1",
    at: "2020-01-01T00:00:00.000Z",
  };

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

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: "echo",
      payload: { ok: true },
    }),
    { type: "echo", payload: { ok: true }, at: base.at },
  );

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: "command-dispatch",
      commandId: "cmd-1",
      commandType: "ping",
      payload: { target: "host" },
    }),
    {
      type: "command-dispatch",
      id: "req-1",
      commandId: "cmd-1",
      commandType: "ping",
      payload: { target: "host" },
      at: base.at,
    },
  );
});

it("generateRequestId and generateDeliveryId are UUIDs", () => {
  const requestId = generateRequestId();
  const deliveryId = generateDeliveryId();
  assert(UUID_RE.test(requestId));
  assert(UUID_RE.test(deliveryId));
});

it("generateRequestId and generateDeliveryId are unique across calls", () => {
  assertNotEquals(generateRequestId(), generateRequestId());
  assertNotEquals(generateDeliveryId(), generateDeliveryId());
});

it("deliveryId and requestId are independent UUIDs", () => {
  const requestId = generateRequestId();
  const deliveryId = generateDeliveryId();
  assertNotEquals(requestId, deliveryId);
});
