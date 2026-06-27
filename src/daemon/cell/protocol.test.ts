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
    type: "heartbeat",
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

  assertEquals(
    outboundEnvelopeToWireMessage({
      ...base,
      kind: "echo",
      payload: { ok: true },
    }),
    { type: "echo", payload: { ok: true }, at: base.at },
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
