import { assertEquals } from "@std/assert";
import {
  describeEvent,
  eventScope,
  eventSeverity,
  isNotificationEvent,
  NOTIFICATION_EVENTS,
  NOTIFICATION_RULE_EVENTS,
  NOTIFICATION_SEVERITIES,
  severityAtLeast,
} from "./events.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("every event has a severity, a scope and renders a title from an empty context", () => {
  for (const event of NOTIFICATION_EVENTS) {
    assertEquals(
      NOTIFICATION_SEVERITIES.includes(eventSeverity(event)),
      true,
      event,
    );
    assertEquals(
      ["organization", "instance"].includes(eventScope(event)),
      true,
      event,
    );
    const { title } = describeEvent(event);
    assertEquals(typeof title === "string" && title.length > 0, true, event);
  }
});

test("the two sweep alerts are the seed and keep their codes", () => {
  assertEquals(isNotificationEvent("server.offline"), true);
  assertEquals(isNotificationEvent("fleet.mass_disconnect"), true);
  assertEquals(eventScope("server.offline"), "organization");
  assertEquals(eventScope("fleet.mass_disconnect"), "instance");
  assertEquals(eventSeverity("server.offline"), "critical");
  assertEquals(isNotificationEvent("deploy.succeeded"), false);
});

test("a sentence is rendered from the context, and never from anything missing", () => {
  assertEquals(
    describeEvent("server.offline", {
      serverName: "db-1",
      lastSeenAt: "2026-09-18T10:00:00Z",
    }),
    {
      title: "Server db-1 went offline",
      body:
        "The daemon on db-1 stopped answering and the server was marked offline (last seen 2026-09-18T10:00:00Z).",
    },
  );
  assertEquals(
    describeEvent("server.offline").title,
    "Server unknown went offline",
  );
  assertEquals(
    describeEvent("fleet.mass_disconnect", { count: 7 }).title,
    "7 servers went offline in one sweep",
  );
  assertEquals(
    describeEvent("access.grant_revoked", {
      actorEmail: "owner@example.com",
      permissionKey: "organization:manage",
      subjectKind: "user",
      subjectId: "u-1",
    }).body,
    "owner@example.com revoked organization:manage from user u-1.",
  );
});

test("rules may name every event, or one; the severity floor is inclusive", () => {
  assertEquals(NOTIFICATION_RULE_EVENTS[0], "*");
  assertEquals(NOTIFICATION_RULE_EVENTS.length, NOTIFICATION_EVENTS.length + 1);
  assertEquals(severityAtLeast("critical", "warning"), true);
  assertEquals(severityAtLeast("warning", "warning"), true);
  assertEquals(severityAtLeast("info", "warning"), false);
});
