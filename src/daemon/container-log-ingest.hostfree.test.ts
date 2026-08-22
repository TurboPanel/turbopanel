import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { parseContainerLogBatchBody } from "./container-log-ingest.ts";
import {
  MAX_CONTAINER_LOG_INGEST_BATCH,
  MAX_CONTAINER_LOG_MESSAGE_BYTES,
} from "../lib/container-logs/types.ts";

const IDENTITY = {
  serverId: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
};

function event(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-08-21T10:00:00.000Z",
    containerId: "c0ffee",
    environmentId: "33333333-3333-4333-8333-333333333333",
    serviceId: "44444444-4444-4444-8444-444444444444",
    stream: "stdout",
    message: "listening on 8080",
    ...overrides,
  };
}

describe("parseContainerLogBatchBody", () => {
  it("accepts a well-formed batch", () => {
    const parsed = parseContainerLogBatchBody({ events: [event()] }, IDENTITY);
    assert(parsed.ok);
    assertEquals(parsed.events.length, 1);
    assertEquals(parsed.events[0]?.message, "listening on 8080");
    assertEquals(parsed.events[0]?.stream, "stdout");
  });

  it("accepts an empty batch", () => {
    const parsed = parseContainerLogBatchBody({ events: [] }, IDENTITY);
    assert(parsed.ok);
    assertEquals(parsed.events, []);
  });

  it("stamps the authenticated identity and ignores the body's own", () => {
    const parsed = parseContainerLogBatchBody(
      {
        events: [
          event({
            serverId: "somebody-elses-server",
            organizationId: "somebody-elses-org",
          }),
        ],
      },
      IDENTITY,
    );
    assert(parsed.ok);
    assertEquals(parsed.events[0]?.serverId, IDENTITY.serverId);
    assertEquals(parsed.events[0]?.organizationId, IDENTITY.organizationId);
  });

  it("normalizes a timestamp to ISO-8601 UTC", () => {
    const parsed = parseContainerLogBatchBody(
      { events: [event({ timestamp: "2026-08-21T12:00:00+02:00" })] },
      IDENTITY,
    );
    assert(parsed.ok);
    assertEquals(parsed.events[0]?.timestamp, "2026-08-21T10:00:00.000Z");
  });

  it("nulls a blank or missing environment / service", () => {
    const parsed = parseContainerLogBatchBody(
      { events: [event({ environmentId: "  ", serviceId: undefined })] },
      IDENTITY,
    );
    assert(parsed.ok);
    assertEquals(parsed.events[0]?.environmentId, null);
    assertEquals(parsed.events[0]?.serviceId, null);
  });

  it("truncates a message past the per-line byte cap", () => {
    const parsed = parseContainerLogBatchBody(
      {
        events: [
          event({ message: "x".repeat(MAX_CONTAINER_LOG_MESSAGE_BYTES + 100) }),
        ],
      },
      IDENTITY,
    );
    assert(parsed.ok);
    assertEquals(
      parsed.events[0]?.message.length,
      MAX_CONTAINER_LOG_MESSAGE_BYTES,
    );
  });

  it("rejects a non-object body", () => {
    for (const body of [null, undefined, "batch", 42, []]) {
      const parsed = parseContainerLogBatchBody(body, IDENTITY);
      assert(!parsed.ok);
      assertEquals(parsed.error, "invalid batch");
    }
  });

  it("rejects a body whose events are not an array", () => {
    const parsed = parseContainerLogBatchBody({ events: {} }, IDENTITY);
    assert(!parsed.ok);
    assertEquals(parsed.error, "events must be an array");
  });

  it("rejects a batch over the ingest cap", () => {
    const events = Array.from(
      { length: MAX_CONTAINER_LOG_INGEST_BATCH + 1 },
      () => event(),
    );
    const parsed = parseContainerLogBatchBody({ events }, IDENTITY);
    assert(!parsed.ok);
    assertEquals(parsed.error, "batch too large");
  });

  it("rejects an unparseable timestamp rather than guessing one", () => {
    for (const timestamp of [undefined, "", "yesterday", 1700000000000]) {
      const parsed = parseContainerLogBatchBody(
        { events: [event({ timestamp })] },
        IDENTITY,
      );
      assert(!parsed.ok);
      assertEquals(parsed.error, "invalid timestamp");
    }
  });

  it("rejects a stream that is not stdout or stderr", () => {
    const parsed = parseContainerLogBatchBody(
      { events: [event({ stream: "console" })] },
      IDENTITY,
    );
    assert(!parsed.ok);
    assertEquals(parsed.error, "stream must be stdout or stderr");
  });

  it("rejects a missing container id", () => {
    const parsed = parseContainerLogBatchBody(
      { events: [event({ containerId: "  " })] },
      IDENTITY,
    );
    assert(!parsed.ok);
    assertEquals(parsed.error, "containerId is required");
  });

  it("rejects a non-string message", () => {
    const parsed = parseContainerLogBatchBody(
      { events: [event({ message: 42 })] },
      IDENTITY,
    );
    assert(!parsed.ok);
    assertEquals(parsed.error, "message must be a string");
  });

  it("rejects the whole batch when one event is malformed", () => {
    const parsed = parseContainerLogBatchBody(
      { events: [event(), event({ stream: "nope" }), event()] },
      IDENTITY,
    );
    assert(!parsed.ok);
  });
});
