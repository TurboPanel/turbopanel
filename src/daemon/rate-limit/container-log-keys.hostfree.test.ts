import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  daemonContainerLogsRateLimitKey,
  daemonMetricsRateLimitKey,
  daemonRestRateLimitKey,
} from "./keys.ts";
import {
  DEFAULT_DAEMON_CONTAINER_LOGS_RATE_LIMIT,
  DEFAULT_DAEMON_CONTAINER_LOGS_RATE_PERIOD_SECONDS,
  resolveDaemonContainerLogsRateLimit,
} from "./redis-rate-limiter.ts";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";

describe("daemonContainerLogsRateLimitKey", () => {
  it("is scoped per server", () => {
    assertEquals(
      daemonContainerLogsRateLimitKey(SERVER_ID),
      `daemon:container-logs:${SERVER_ID}`,
    );
  });

  it("shares no bucket with the metrics or REST limiters", () => {
    const key = daemonContainerLogsRateLimitKey(SERVER_ID);
    assert(key !== daemonMetricsRateLimitKey(SERVER_ID));
    assert(key !== daemonRestRateLimitKey(SERVER_ID, "commands-log"));
  });
});

describe("resolveDaemonContainerLogsRateLimit", () => {
  it("falls back to the Wrangler-matching defaults", () => {
    assertEquals(
      resolveDaemonContainerLogsRateLimit({ get: () => undefined }),
      {
        limit: DEFAULT_DAEMON_CONTAINER_LOGS_RATE_LIMIT,
        periodSeconds: DEFAULT_DAEMON_CONTAINER_LOGS_RATE_PERIOD_SECONDS,
      },
    );
  });

  it("honours positive-integer env overrides", () => {
    const env = {
      get: (key: string) =>
        ({
          TURBOPANEL_DAEMON_CONTAINER_LOGS_RATE_LIMIT: "120",
          TURBOPANEL_DAEMON_CONTAINER_LOGS_RATE_PERIOD: "30",
        })[key],
    };
    assertEquals(resolveDaemonContainerLogsRateLimit(env), {
      limit: 120,
      periodSeconds: 30,
    });
  });

  it("ignores a zero, negative, or non-numeric override", () => {
    for (const raw of ["0", "-5", "many", ""]) {
      const env = {
        get: (key: string) =>
          key === "TURBOPANEL_DAEMON_CONTAINER_LOGS_RATE_LIMIT"
            ? raw
            : undefined,
      };
      assertEquals(
        resolveDaemonContainerLogsRateLimit(env).limit,
        DEFAULT_DAEMON_CONTAINER_LOGS_RATE_LIMIT,
      );
    }
  });
});
