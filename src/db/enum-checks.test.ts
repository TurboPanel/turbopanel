import { assertEquals } from "@std/assert";
import {
  COMMAND_ACTOR_TYPES,
  COMMAND_STATUSES,
} from "../features/commands/types.ts";
import { CONTAINER_STATUSES } from "../features/environments/container-records.ts";
import { GRANT_ENTITY_TYPES, SUBJECT_TYPES } from "../client/authz/catalog.ts";
import { TLS_STATUS_VALUES } from "../lib/tls/metadata.ts";
import { KNOWN_SUBSCRIPTION_STATUSES } from "../features/billing/billing-records.ts";
import { ADMIN_ROLE, SUPERADMIN_ROLE } from "../client/authn/session-store.ts";
import { INVITATION_STATUSES } from "../client/access/routes-helpers.ts";
import { BILLING_PROVIDER_IDS } from "../features/billing/gateway.ts";
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_RULE_EVENTS,
  NOTIFICATION_SEVERITIES,
} from "../features/notifications/events.ts";
import {
  NOTIFICATION_CHANNEL_KINDS,
  NOTIFICATION_CHANNEL_SCOPES,
  NOTIFICATION_DELIVERY_STATUSES,
} from "../features/notifications/records.ts";
import { INSTANCE_HOSTNAME_SOURCES } from "../features/install/instance-hostnames.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * The enum CHECK constraints in `schema.ts` are literal SQL strings; the code
 * that writes those columns is typed off `as const` arrays elsewhere. Nothing
 * ties the two together at compile time, so this pins them: adding a value
 * to the array without widening the CHECK (or the reverse) fails here, not
 * as a refused INSERT in production.
 *
 * Widening a list later is `ADD CONSTRAINT … NOT VALID; VALIDATE` — the
 * allowed forward migration (decided 2026-09-11).
 */
const schemaSource = await Deno.readTextFile(
  new URL("./schema.ts", import.meta.url),
);

function checkValues(constraintName: string): string[] {
  const re = new RegExp(
    String
      .raw`check\(\s*"${constraintName}",\s*sql\x60[a-z_]+ IN \(([^)]*)\)\x60`,
  );
  const match = re.exec(schemaSource);
  if (!match) throw new TypeError(`schema.ts has no ${constraintName}`);
  return match[1]!.split(",").map((v) => v.trim().replace(/^'|'$/g, ""));
}

const CASES: Array<[constraint: string, values: readonly string[]]> = [
  ["command_status_check", COMMAND_STATUSES],
  ["command_actor_type_check", COMMAND_ACTOR_TYPES],
  ["container_status_check", CONTAINER_STATUSES],
  ["grant_actor_type_check", SUBJECT_TYPES],
  ["grant_entity_type_check", GRANT_ENTITY_TYPES],
  ["tls_status_check", TLS_STATUS_VALUES],
  ["invitation_status_check", INVITATION_STATUSES],
  ["user_role_check", ["user", ADMIN_ROLE, SUPERADMIN_ROLE]],
  ["subscription_status_check", [...KNOWN_SUBSCRIPTION_STATUSES, "unknown"]],
  ["tier_provider_check", BILLING_PROVIDER_IDS],
  ["payer_provider_check", BILLING_PROVIDER_IDS],
  ["channel_scope_check", NOTIFICATION_CHANNEL_SCOPES],
  ["channel_kind_check", NOTIFICATION_CHANNEL_KINDS],
  ["rule_event_check", NOTIFICATION_RULE_EVENTS],
  ["rule_min_severity_check", NOTIFICATION_SEVERITIES],
  ["notification_event_check", NOTIFICATION_EVENTS],
  ["notification_severity_check", NOTIFICATION_SEVERITIES],
  ["attempt_event_check", NOTIFICATION_EVENTS],
  ["attempt_severity_check", NOTIFICATION_SEVERITIES],
  ["attempt_status_check", NOTIFICATION_DELIVERY_STATUSES],
  ["origin_source_check", INSTANCE_HOSTNAME_SOURCES],
];

for (const [constraint, values] of CASES) {
  test(`schema.ts ${constraint} matches the TypeScript vocabulary that writes the column`, () => {
    assertEquals(checkValues(constraint), [...values]);
  });
}

test("every checked vocabulary is non-empty and free of duplicates", () => {
  for (const [constraint, values] of CASES) {
    assertEquals(values.length > 0, true, constraint);
    assertEquals(new Set(values).size, values.length, constraint);
  }
});
