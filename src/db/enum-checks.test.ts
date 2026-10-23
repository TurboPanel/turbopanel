import { assertEquals } from '@std/assert'
import { COMMAND_ACTOR_TYPES, COMMAND_STATUSES } from '../features/commands/types.ts'
import { CONTAINER_STATUSES } from '../features/environments/container-records.ts'
import { GRANT_ENTITY_TYPES, SUBJECT_TYPES } from '../client/authz/catalog.ts'
import { TLS_STATUS_VALUES } from '../lib/tls/metadata.ts'
import { KNOWN_SUBSCRIPTION_STATUSES } from '../features/billing/billing-records.ts'
import { ADMIN_ROLE, SUPERADMIN_ROLE } from '../client/authn/session-store.ts'
import { INVITATION_STATUSES } from '../client/access/routes-helpers.ts'
import { BILLING_PROVIDER_IDS } from '../features/billing/gateway.ts'
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_RULE_EVENTS,
  NOTIFICATION_SEVERITIES,
} from '../features/notifications/events.ts'
import {
  NOTIFICATION_CHANNEL_KINDS,
  NOTIFICATION_CHANNEL_SCOPES,
  NOTIFICATION_DELIVERY_STATUSES,
} from '../features/notifications/records.ts'
import { INSTANCE_HOSTNAME_SOURCES } from '../features/install/instance-hostnames.ts'
import {
  UPGRADE_PHASES,
  UPGRADE_SOURCES,
  UPGRADE_STATUSES,
  UPGRADE_STEP_STATUSES,
  UPGRADE_STEP_UNITS,
} from '../features/upgrades/vocabulary.ts'
import { BACKUP_RUN_STATUSES, BACKUP_TARGET_KINDS } from '../features/backups/vocabulary.ts'
import {
  DATABASE_LOGIN_ROLES,
  LOGIN_CONNECTION_ROLES,
  LOGIN_GRANT_MODES,
} from '../features/managed/logins.ts'
import { PRINCIPAL_NAME_SCHEMES } from '../lib/principal-name-scheme.ts'
import { SERVER_MACHINE_CLASS_SOURCES } from '../contracts/capability-plan.ts'
import {
  SERVER_DAEMON_UPDATE_STATUSES,
  SERVER_OFFLINE_REASONS,
} from '../features/servers/daemon-state.ts'
import {
  FIREWALL_MODES,
  FIREWALL_RULE_ACTIONS,
  FIREWALL_RULE_PROTOS,
  FIREWALL_RULE_SCOPES,
  FIREWALL_SOURCE_KINDS,
  FIREWALL_STATES,
} from '../features/firewall/vocabulary.ts'
import { PRINCIPAL_ACCESS_LEVELS } from '../features/principals/principal-access.ts'
import { PLACEMENT_SOURCES, PLACEMENT_STATES } from '../features/principals/placement-vocabulary.ts'
import { FOLDER_KINDS, FOLDER_STATES } from '../features/folders/vocabulary.ts'
import { LEAF_STALE_CAUSES, LEAF_STATES } from '../features/tls/leaf-vocabulary.ts'
import { CLIENT_ADDRESS_SCOPES } from '../features/net/client-addresses-pure.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

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
const schemaSource = await Deno.readTextFile(new URL('./schema.ts', import.meta.url))

function checkValues(constraintName: string): string[] {
  const re = new RegExp(
    String.raw`check\(\s*["']${constraintName}["'],\s*sql\x60(?:[a-z_]+ IS NULL OR )?[a-z_]+ IN \(([^)]*)\)\x60`
  )
  const match = re.exec(schemaSource)
  if (!match) throw new TypeError(`schema.ts has no ${constraintName}`)
  return match[1]!.split(',').map((v) => v.trim().replace(/^'|'$/g, ''))
}

const CASES: Array<[constraint: string, values: readonly string[]]> = [
  ['command_status_check', COMMAND_STATUSES],
  ['command_actor_type_check', COMMAND_ACTOR_TYPES],
  ['container_status_check', CONTAINER_STATUSES],
  ['permission_actor_type_check', SUBJECT_TYPES],
  ['permission_entity_type_check', GRANT_ENTITY_TYPES],
  ['tls_status_check', TLS_STATUS_VALUES],
  ['invitation_status_check', INVITATION_STATUSES],
  ['user_role_check', ['user', ADMIN_ROLE, SUPERADMIN_ROLE]],
  ['subscription_status_check', [...KNOWN_SUBSCRIPTION_STATUSES, 'unknown']],
  ['tier_provider_check', BILLING_PROVIDER_IDS],
  ['payer_provider_check', BILLING_PROVIDER_IDS],
  ['placement_state_check', PLACEMENT_STATES],
  ['placement_source_check', PLACEMENT_SOURCES],
  ['folder_kind_check', FOLDER_KINDS],
  ['folder_state_check', FOLDER_STATES],
  ['leaf_state_check', LEAF_STATES],
  ['leaf_stale_cause_check', LEAF_STALE_CAUSES],
  ['address_scope_check', CLIENT_ADDRESS_SCOPES],
  ['channel_scope_check', NOTIFICATION_CHANNEL_SCOPES],
  ['channel_kind_check', NOTIFICATION_CHANNEL_KINDS],
  ['rule_event_check', NOTIFICATION_RULE_EVENTS],
  ['rule_min_severity_check', NOTIFICATION_SEVERITIES],
  ['notification_event_check', NOTIFICATION_EVENTS],
  ['notification_severity_check', NOTIFICATION_SEVERITIES],
  ['attempt_event_check', NOTIFICATION_EVENTS],
  ['attempt_severity_check', NOTIFICATION_SEVERITIES],
  ['attempt_status_check', NOTIFICATION_DELIVERY_STATUSES],
  ['origin_source_check', INSTANCE_HOSTNAME_SOURCES],
  ['upgrade_source_check', UPGRADE_SOURCES],
  ['upgrade_status_check', UPGRADE_STATUSES],
  ['upgrade_phase_check', UPGRADE_PHASES],
  ['stage_unit_check', UPGRADE_STEP_UNITS],
  ['stage_phase_check', UPGRADE_PHASES],
  ['retention_target_kind_check', BACKUP_TARGET_KINDS],
  ['snapshot_status_check', BACKUP_RUN_STATUSES],
  ['edict_scope_check', FIREWALL_RULE_SCOPES],
  ['edict_action_check', FIREWALL_RULE_ACTIONS],
  ['edict_proto_check', FIREWALL_RULE_PROTOS],
  ['edict_source_kind_check', FIREWALL_SOURCE_KINDS],
  ['bulwark_mode_check', FIREWALL_MODES],
  ['bulwark_state_check', FIREWALL_STATES],
  ['stage_status_check', UPGRADE_STEP_STATUSES],
  ['login_role_check', DATABASE_LOGIN_ROLES],
  ['server_machine_class_source_check', SERVER_MACHINE_CLASS_SOURCES],
  ['server_offline_reason_check', SERVER_OFFLINE_REASONS],
  ['server_daemon_update_status_check', SERVER_DAEMON_UPDATE_STATUSES],
  ['login_grant_mode_check', LOGIN_GRANT_MODES],
  ['login_access_check', LOGIN_CONNECTION_ROLES],
  ['login_name_scheme_check', PRINCIPAL_NAME_SCHEMES],
  ['principal_access_check', PRINCIPAL_ACCESS_LEVELS],
]

for (const [constraint, values] of CASES) {
  test(`schema.ts ${constraint} matches the TypeScript vocabulary that writes the column`, () => {
    assertEquals(checkValues(constraint), [...values])
  })
}

test('every checked vocabulary is non-empty and free of duplicates', () => {
  for (const [constraint, values] of CASES) {
    assertEquals(values.length > 0, true, constraint)
    assertEquals(new Set(values).size, values.length, constraint)
  }
})
