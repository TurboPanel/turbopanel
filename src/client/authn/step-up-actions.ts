/**
 * Registry of the permanent (or hard-to-undo) actions that ask for step-up
 * re-authentication when the organization has turned on
 * `requireReauthForDestructive`.
 *
 * One list on purpose: a route names its action here, calls
 * `requireStepUpIfConfigured(c, organizationId, action)` (see `step-up.ts`)
 * after its normal permission check and before it changes anything, and the
 * 403 `reauth_required` answer echoes the action key back so the UI can say
 * what it is asking about. To put another action behind the gate, add it here
 * and add that one call to the route; nothing else needs to know.
 *
 * Deliberately not on the list: sign-out, creating things, and anything an
 * undo (or a re-deploy) fully reverses. There is no "delete organization"
 * route in this build; when one lands it belongs here as `organization.delete`.
 * "Revoke a key" here means a license key (`DELETE /licenses/:id`) and a
 * server's daemon key (`POST /servers/:id/daemon-key/revoke`); there are no
 * other API keys yet.
 *
 * Keys are `<subject>.<verb>` and match the audit action where one exists.
 */
export const STEP_UP_ACTIONS = {
  'project.delete': 'Delete a project and everything in it',
  'environment.delete': 'Delete an environment',
  'server.delete': 'Delete a server',
  'server.daemon_key.revoke': "Revoke a server's key",
  'license.revoke': 'Revoke a license key',
  'managed.delete': 'Delete a managed database',
  'managed.database.delete': 'Delete a database inside a managed database',
  'member.remove': 'Remove a member from the organization',
  'storage.delete': 'Delete a storage volume',
  'storage.copy.delete': 'Delete a copy of a storage volume',
  'storage.backup.delete': 'Delete a storage backup',
  'storage.restore': 'Restore a storage backup over its volume',
  'managed.backup.delete': 'Delete a managed database backup',
  'managed.restore': 'Restore a managed database backup over its data',
  'hosting.delete': 'Delete a hosting',
  'organization.reauth_settings.update': 'Change the re-authentication setting',
} as const

export type StepUpAction = keyof typeof STEP_UP_ACTIONS
