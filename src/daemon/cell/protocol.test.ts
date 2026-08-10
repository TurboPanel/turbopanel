import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert";
import { it } from "@std/testing/bdd";
import {
  type DaemonMessage,
  DAEMON_CELL_PING,
  DAEMON_CELL_PONG,
  DAEMON_INBOUND_ALLOWED,
  DAEMON_OFFLINE_SWEEP_MS,
  DAEMON_STALE_MS,
  generateDeliveryId,
  generateRequestId,
  MAX_DAEMON_WS_ERROR_CHARS,
  MAX_DAEMON_WS_FRAME_BYTES,
  MAX_DAEMON_WS_HOST_FIELD_CHARS,
  MAX_DAEMON_WS_ID_CHARS,
  MAX_DAEMON_WS_LOGS_CHARS,
  MAX_DAEMON_WS_RESULT_JSON_BYTES,
  outboundEnvelopeToWireMessage,
  parseDaemonBuildInfo,
  parseDaemonMessage,
  validateDaemonInboundEnvelope,
  validateDaemonInboundFrame,
  wireMessageToInboundEnvelope,
} from "./protocol.ts";


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

it("validateDaemonInboundFrame accepts a valid heartbeat", () => {
  const raw = JSON.stringify({
    type: "heartbeat",
    at: "2020-01-01T00:00:00.000Z",
  });
  const result = validateDaemonInboundFrame(raw);
  assertEquals(result.ok, true);
});

it("validateDaemonInboundFrame rejects oversized frames", () => {
  const padding = "x".repeat(MAX_DAEMON_WS_FRAME_BYTES);
  const raw = `{"type":"heartbeat","at":"2020-01-01T00:00:00.000Z","pad":"${padding}"}`;
  const result = validateDaemonInboundFrame(raw);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.reason, "frame exceeds max size");
  }
});

it("validateDaemonInboundFrame rejects disallowed types", () => {
  const result = validateDaemonInboundFrame(
    JSON.stringify({ type: "echo", at: "2020-01-01T00:00:00.000Z", payload: 1 }),
  );
  assertEquals(result.ok, false);
});

it("validateDaemonInboundFrame rejects oversized managed logs", () => {
  const result = validateDaemonInboundFrame(
    JSON.stringify({
      type: "managed-logs-result",
      id: "req-1",
      at: "2020-01-01T00:00:00.000Z",
      logs: "x".repeat(MAX_DAEMON_WS_LOGS_CHARS + 1),
    }),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.reason, "logs exceed max length");
  }
});

it("validateDaemonInboundEnvelope rejects oversized command results", () => {
  const result = validateDaemonInboundEnvelope({
    kind: "command-outcome",
    requestId: "req-1",
    at: "2020-01-01T00:00:00.000Z",
    ok: true,
    result: { blob: "x".repeat(70 * 1024) },
  });
  assertEquals(result.ok, false);
});

it("validateDaemonInboundEnvelope accepts a valid addresses result", () => {
  const result = validateDaemonInboundEnvelope({
    kind: "addresses-result",
    requestId: "req-1",
    at: "2020-01-01T00:00:00.000Z",
    addresses: {
      privateIpv4: [],
      privateIpv6: [],
      publicIpv4: [TEST_PUBLIC_IPV4],
      publicIpv6: [],
    },
  });
  assertEquals(result, { ok: true });
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
      type: "managed-logs-result",
      id: "r3",
      at,
      logs: "line1\n",
    }),
    {
      kind: "managed-logs-result",
      requestId: "r3",
      at,
      logs: "line1\n",
      error: undefined,
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

it("metrics messages are not accepted on the daemon WebSocket", () => {
  assertEquals(
    (DAEMON_INBOUND_ALLOWED as ReadonlySet<string>).has("metrics"),
    false,
  );
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
      kind: "managed-logs-request",
      managedId: "00000000-0000-4000-8000-000000000001",
      tail: 200,
    }),
    {
      type: "managed-logs-request",
      id: "req-1",
      managedId: "00000000-0000-4000-8000-000000000001",
      tail: 200,
      at: base.at,
    },
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

const VALID_AT = "2020-01-01T00:00:00.000Z";
const VALID_DAEMON_BUILD = { commit: "abc123def456", buildId: "build-1" };

it("parseDaemonBuildInfo accepts optional builtAt and channel", () => {
  assertEquals(
    parseDaemonBuildInfo({
      commit: "c1",
      buildId: "b1",
      builtAt: "2020-01-01T00:00:00.000Z",
      channel: "trunk",
    }),
    {
      commit: "c1",
      buildId: "b1",
      builtAt: "2020-01-01T00:00:00.000Z",
      channel: "trunk",
    },
  );
});

it("parseDaemonBuildInfo rejects missing or empty commit/buildId", () => {
  assertEquals(parseDaemonBuildInfo(null), undefined);
  assertEquals(parseDaemonBuildInfo({ commit: "", buildId: "b" }), undefined);
  assertEquals(parseDaemonBuildInfo({ commit: "c", buildId: "" }), undefined);
  assertEquals(parseDaemonBuildInfo({ commit: 1, buildId: "b" }), undefined);
});

it("validateDaemonInboundFrame rejects invalid json and message shape", () => {
  assertEquals(validateDaemonInboundFrame("not-json").ok, false);
  assertEquals(validateDaemonInboundFrame("{}").ok, false);
  assertEquals(validateDaemonInboundFrame('{"at":"' + VALID_AT + '"}').ok, false);
});

it("validateDaemonInboundFrame accepts hello with optional fields", () => {
  const result = validateDaemonInboundFrame(
    JSON.stringify({
      type: "hello",
      at: VALID_AT,
      daemonBuild: VALID_DAEMON_BUILD,
      hostname: "host-1",
      machineKey: "a".repeat(64),
    }),
  );
  assertEquals(result.ok, true);
});

it("validateDaemonInboundFrame rejects hello with invalid daemonBuild or hostname", () => {
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({ type: "hello", at: VALID_AT, daemonBuild: { commit: "" } }),
    ).ok,
    false,
  );
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: "hello",
        at: VALID_AT,
        daemonBuild: VALID_DAEMON_BUILD,
        hostname: "x".repeat(MAX_DAEMON_WS_HOST_FIELD_CHARS + 1),
      }),
    ).ok,
    false,
  );
});

it("validateDaemonInboundFrame rejects heartbeat with invalid timestamp or daemonBuild", () => {
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({ type: "heartbeat", at: "not-a-timestamp" }),
    ).ok,
    false,
  );
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: "heartbeat",
        at: VALID_AT,
        daemonBuild: { buildId: "only-build" },
      }),
    ).ok,
    false,
  );
});

it("validateDaemonInboundFrame validates addresses-result envelope fields", () => {
  const ok = validateDaemonInboundFrame(
    JSON.stringify({
      type: "addresses-result",
      id: "req-1",
      at: VALID_AT,
      addresses: { privateIpv4: [], privateIpv6: [], publicIpv4: [], publicIpv6: [] },
    }),
  );
  assertEquals(ok.ok, true);

  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: "addresses-result",
        id: "",
        at: VALID_AT,
        addresses: {},
      }),
    ).ok,
    false,
  );
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: "addresses-result",
        id: "req-1",
        at: VALID_AT,
        addresses: "not-an-object",
      }),
    ).ok,
    false,
  );
});

it("validateDaemonInboundFrame validates ok-result and command messages", () => {
  for (const type of [
    "dev-sync-result",
    "tunnel-token-result",
    "public-urls-update-result",
    "update-result",
  ] as const) {
    assertEquals(
      validateDaemonInboundFrame(
        JSON.stringify({ type, id: "req-1", at: VALID_AT, ok: true }),
      ).ok,
      true,
    );
    assertEquals(
      validateDaemonInboundFrame(
        JSON.stringify({
          type,
          id: "req-1",
          at: VALID_AT,
          ok: "yes",
          error: "x".repeat(MAX_DAEMON_WS_ERROR_CHARS + 1),
        }),
      ).ok,
      false,
    );
  }

  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: "command-ack",
        id: "req-1",
        at: VALID_AT,
        daemonReceivedAt: VALID_AT,
      }),
    ).ok,
    true,
  );
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: "command-ack",
        id: "req-1",
        at: VALID_AT,
        daemonReceivedAt: "bad",
      }),
    ).ok,
    false,
  );

  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: "command-outcome",
        id: "req-1",
        at: VALID_AT,
        ok: true,
        result: { pong: true },
        daemonReceivedAt: VALID_AT,
        daemonRespondedAt: VALID_AT,
      }),
    ).ok,
    true,
  );
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: "command-outcome",
        id: "x".repeat(MAX_DAEMON_WS_ID_CHARS + 1),
        at: VALID_AT,
        ok: true,
      }),
    ).ok,
    false,
  );
  assertEquals(
    validateDaemonInboundFrame(
      JSON.stringify({
        type: "command-outcome",
        id: "req-1",
        at: VALID_AT,
        ok: true,
        result: { blob: "x".repeat(MAX_DAEMON_WS_RESULT_JSON_BYTES) },
      }),
    ).ok,
    false,
  );
});

it("validateDaemonInboundEnvelope rejects invalid requestId and timestamps", () => {
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: "addresses-result",
      requestId: "",
      at: VALID_AT,
      addresses: {
        privateIpv4: [],
        privateIpv6: [],
        publicIpv4: [],
        publicIpv6: [],
      },
    }),
    { ok: false, reason: "invalid requestId" },
  );
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: "dev-sync-result",
      requestId: "req-1",
      at: "bad",
      ok: true,
    }),
    { ok: false, reason: "invalid at timestamp" },
  );
});

it("validateDaemonInboundEnvelope validates managed-logs and command-outcome caps", () => {
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: "managed-logs-result",
      requestId: "req-1",
      at: VALID_AT,
      logs: "x".repeat(MAX_DAEMON_WS_LOGS_CHARS + 1),
    }),
    { ok: false, reason: "logs exceed max length" },
  );
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: "managed-logs-result",
      requestId: "req-1",
      at: VALID_AT,
      logs: "ok",
      error: "x".repeat(MAX_DAEMON_WS_ERROR_CHARS + 1),
    }),
    { ok: false, reason: "error exceeds max length" },
  );
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: "command-outcome",
      requestId: "req-1",
      at: VALID_AT,
      ok: false,
      error: "failed",
    }),
    { ok: true },
  );
  assertEquals(
    validateDaemonInboundEnvelope({
      kind: "command-ack",
      requestId: "req-1",
      at: VALID_AT,
      daemonReceivedAt: "bad",
    }),
    { ok: false, reason: "invalid daemonReceivedAt" },
  );
});

it("wireMessageToInboundEnvelope returns null for hello and heartbeat", () => {
  assertEquals(
    wireMessageToInboundEnvelope({
      type: "hello",
      at: VALID_AT,
      daemonBuild: VALID_DAEMON_BUILD,
    }),
    null,
  );
  assertEquals(
    wireMessageToInboundEnvelope({ type: "heartbeat", at: VALID_AT }),
    null,
  );
});

it("cell ping/pong constants and timing exports are stable", () => {
  assertEquals(DAEMON_CELL_PING, '{"type":"ping"}');
  assertEquals(DAEMON_CELL_PONG, '{"type":"pong"}');
  assertEquals(DAEMON_STALE_MS, 60_000);
  assertEquals(DAEMON_OFFLINE_SWEEP_MS, 150_000);
  assertEquals(
    (DAEMON_INBOUND_ALLOWED as ReadonlySet<string>).has("hello"),
    true,
  );
});
