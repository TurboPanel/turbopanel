import { assert, assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  containerLogSettingsGetResponse,
  containerLogSettingsPutResponse,
  DEFAULT_CONTAINER_LOG_QUERY_WINDOW_MS,
  parseContainerLogQueryParams,
  parseContainerLogSettingsPatch,
} from "./routes-helpers.ts";
import {
  DEFAULT_CONTAINER_LOG_QUERY_LIMIT,
  MAX_CONTAINER_LOG_QUERY_LIMIT,
} from "../../lib/container-logs/types.ts";
import {
  CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_RANGE_SECONDS,
  CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_UNSELECTIVE_RANGE_SECONDS,
} from "../../lib/container-logs/cloudflare/config.ts";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const NOW = () => Date.parse("2026-08-21T12:00:00.000Z");

describe("parseContainerLogSettingsPatch", () => {
  it("accepts a boolean and a null clear", () => {
    assertEquals(
      parseContainerLogSettingsPatch({ containerLogsEnabled: true }),
      {
        ok: true,
        patch: { containerLogsEnabled: true },
      },
    );
    assertEquals(
      parseContainerLogSettingsPatch({ containerLogsEnabled: null }),
      {
        ok: true,
        patch: { containerLogsEnabled: null },
      },
    );
  });

  it("rejects a non-boolean value", () => {
    const parsed = parseContainerLogSettingsPatch({
      containerLogsEnabled: "yes",
    });
    assert(!parsed.ok);
    assertEquals(parsed.error, "Invalid containerLogsEnabled");
  });

  it("rejects a body that patches nothing", () => {
    const parsed = parseContainerLogSettingsPatch({ somethingElse: true });
    assert(!parsed.ok);
    assertEquals(parsed.error, "Invalid request");
  });
});

describe("container-log settings responses", () => {
  it("defaults to off", () => {
    assertEquals(
      containerLogSettingsGetResponse({}).containerLogsEnabled,
      false,
    );
  });

  it("marks the PUT response ok", () => {
    const body = containerLogSettingsPutResponse({
      containerLogsEnabled: true,
    });
    assertEquals(body.ok, true);
    assertEquals(body.containerLogsEnabled, true);
  });
});

describe("parseContainerLogQueryParams", () => {
  it("forces the authorized organization and defaults the window", () => {
    const parsed = parseContainerLogQueryParams({}, ORG_ID, NOW);
    assert(parsed.ok);
    assertEquals(parsed.query.organizationId, ORG_ID);
    assertEquals(parsed.query.to, "2026-08-21T12:00:00.000Z");
    assertEquals(
      Date.parse(parsed.query.to) - Date.parse(parsed.query.from),
      DEFAULT_CONTAINER_LOG_QUERY_WINDOW_MS,
    );
    assertEquals(parsed.query.limit, DEFAULT_CONTAINER_LOG_QUERY_LIMIT);
  });

  it("cannot be widened by an organizationId in the query string", () => {
    const parsed = parseContainerLogQueryParams(
      { organizationId: "someone-elses-org" } as Record<string, string>,
      ORG_ID,
      NOW,
    );
    assert(parsed.ok);
    assertEquals(parsed.query.organizationId, ORG_ID);
  });

  it("carries every optional predicate through", () => {
    const parsed = parseContainerLogQueryParams(
      {
        from: "2026-08-21T10:00:00.000Z",
        to: "2026-08-21T11:00:00.000Z",
        serverId: "srv-1",
        environmentId: "env-1",
        serviceId: "svc-1",
        containerId: "c0ffee",
        stream: "stderr",
        search: "ECONNREFUSED",
        cursor: "opaque",
        limit: "50",
      },
      ORG_ID,
      NOW,
    );
    assert(parsed.ok);
    assertEquals(parsed.query.serverId, "srv-1");
    assertEquals(parsed.query.environmentId, "env-1");
    assertEquals(parsed.query.serviceId, "svc-1");
    assertEquals(parsed.query.containerId, "c0ffee");
    assertEquals(parsed.query.stream, "stderr");
    assertEquals(parsed.query.search, "ECONNREFUSED");
    assertEquals(parsed.query.cursor, "opaque");
    assertEquals(parsed.query.limit, 50);
  });

  it("clamps an oversized limit instead of rejecting it", () => {
    const parsed = parseContainerLogQueryParams(
      { limit: "999999" },
      ORG_ID,
      NOW,
    );
    assert(parsed.ok);
    assertEquals(parsed.query.limit, MAX_CONTAINER_LOG_QUERY_LIMIT);
  });

  it("rejects an unparseable bound", () => {
    for (const params of [{ from: "yesterday" }, { to: "soon" }]) {
      const parsed = parseContainerLogQueryParams(params, ORG_ID, NOW);
      assert(!parsed.ok);
    }
  });

  it("rejects an inverted or empty window", () => {
    const parsed = parseContainerLogQueryParams(
      { from: "2026-08-21T11:00:00.000Z", to: "2026-08-21T10:00:00.000Z" },
      ORG_ID,
      NOW,
    );
    assert(!parsed.ok);
    assertEquals(parsed.error, "from must be before to");
  });

  it("rejects a stream that is not stdout or stderr", () => {
    const parsed = parseContainerLogQueryParams(
      { stream: "console" },
      ORG_ID,
      NOW,
    );
    assert(!parsed.ok);
    assertEquals(parsed.error, "Invalid stream");
  });

  it("rejects a zero, negative, or fractional limit", () => {
    for (const limit of ["0", "-1", "1.5", "many"]) {
      const parsed = parseContainerLogQueryParams({ limit }, ORG_ID, NOW);
      assert(!parsed.ok);
      assertEquals(parsed.error, "Invalid limit");
    }
  });
});

describe("default read window vs the R2 SQL scan budget", () => {
  // R2 SQL exposes no scanned-bytes ceiling, so `pipeline-store.ts` fails
  // closed instead: an unfiltered read wider than
  // CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_UNSELECTIVE_RANGE_SECONDS is refused with
  // `container_logs_unavailable`. The route's own default must stay inside that
  // bound, or the very first page load on Workers would 503.
  it("keeps the default window inside the unfiltered R2 SQL bound", () => {
    assert(
      DEFAULT_CONTAINER_LOG_QUERY_WINDOW_MS / 1000 <=
        CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_UNSELECTIVE_RANGE_SECONDS,
    );
  });

  it("keeps the default window inside the filtered R2 SQL bound too", () => {
    assert(
      DEFAULT_CONTAINER_LOG_QUERY_WINDOW_MS / 1000 <=
        CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_RANGE_SECONDS,
    );
  });
});
