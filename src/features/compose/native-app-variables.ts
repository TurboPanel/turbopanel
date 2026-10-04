/**
 * Environment variables for a native (`serviceKind: node`) app.
 *
 * A native app is removed from the compose document the host runs, so the
 * Compose `environment:` the variables module builds for every other service
 * never reaches it. This turns the same answer — recorded by
 * `applyVariablesToComposeDocument` as {@link RuntimeEnvAssignment}s — into the
 * two things a native app needs:
 *
 * - `variables`: the wire list (`nativeAppServices[].variables`), plain values
 *   inline and secrets as `secretKey` pointers into the daemon-sealed
 *   `variableMaterial[]` the deploy already carries, so nothing secret is
 *   plaintext on the wire;
 * - `view`: one list for people (the deploy preview, the service's variables
 *   page) saying where each name came from and whether it reaches the process,
 *   with secret values left out.
 *
 * Pure: no database, no runtime APIs.
 */

import type { EnvironmentDeployNativeAppVariable } from '../../contracts/commands/schemas.ts'
import type { RuntimeEnvAssignment, UnreferencedSecret } from './apply-variables.ts'

/**
 * Names the daemon's unit sets itself. systemd applies an `EnvironmentFile=`
 * over every `Environment=` line, so a variable of one of these names would
 * replace what the platform decided (the port the proxy dials, the Node on
 * `PATH`, the writable `HOME`). The daemon drops them again on its side
 * (`turbopaneld/src/deploy/native/unit.ts`, `NATIVE_APP_PLATFORM_ENV_NAMES`);
 * filtering here as well is what lets the list say so before anything deploys.
 */
export const NATIVE_APP_PLATFORM_ENV_NAMES: ReadonlySet<string> = new Set([
  'PATH',
  'NODE_ENV',
  'PORT',
  'HOST',
  'HOME',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'COREPACK_HOME',
  'COREPACK_ENABLE_DOWNLOAD_PROMPT',
])

/** The daemon's parse limits (`parseNativeAppVariable`); kept in step with it. */
export const NATIVE_APP_VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
export const NATIVE_APP_MAX_VARIABLES = 256
export const NATIVE_APP_MAX_VARIABLE_VALUE = 65_536
const MAX_SECRET_KEY_LENGTH = 256

/** Why a name set on the service does not reach the process. */
export type NativeAppVariableReason =
  | 'platform'
  | 'invalid_name'
  | 'invalid_value'
  | 'too_many'
  /** A secret set above the app (organization, project, …) that its environment does not reference. */
  | 'not_referenced'

export type NativeAppVariableView = {
  name: string
  /** A variable scope, `binding`, `platform`, or `unknown`. */
  source: string
  isSecret: boolean
  /** `null` for a secret — its value is never shown. */
  value: string | null
  /** False when the name was set but is not passed; `reason` says why. */
  delivered: boolean
  reason?: NativeAppVariableReason
}

export type NativeAppVariables = {
  variables: EnvironmentDeployNativeAppVariable[]
  view: NativeAppVariableView[]
}

function platformView(app: {
  listenPort: number
  appMode?: 'production' | 'development'
}): NativeAppVariableView[] {
  const plain = (name: string, value: string): NativeAppVariableView => ({
    name,
    source: 'platform',
    isSecret: false,
    value,
    delivered: true,
  })
  return [
    plain('HOST', '127.0.0.1'),
    plain('NODE_ENV', app.appMode ?? 'production'),
    plain('PORT', String(app.listenPort)),
  ]
}

function rejection(assignment: RuntimeEnvAssignment): NativeAppVariableReason | null {
  if (NATIVE_APP_PLATFORM_ENV_NAMES.has(assignment.name)) return 'platform'
  if (!NATIVE_APP_VARIABLE_NAME_RE.test(assignment.name)) return 'invalid_name'
  if (assignment.value === null) {
    return assignment.key.length > MAX_SECRET_KEY_LENGTH ? 'invalid_value' : null
  }
  const { value } = assignment
  return value.length > NATIVE_APP_MAX_VARIABLE_VALUE || value.includes('\0')
    ? 'invalid_value'
    : null
}

/** Code-unit order, so the payload does not depend on the runtime's locale. */
function compareByName(a: RuntimeEnvAssignment, b: RuntimeEnvAssignment) {
  if (a.name === b.name) return 0
  return a.name < b.name ? -1 : 1
}

/**
 * The wire list and the human list for one native app.
 *
 * A name set twice resolves the way the Compose lane resolves it — the last
 * assignment wins — and the result is sorted by name so the payload (and the
 * list people read) is stable from one deploy to the next. Anything the daemon
 * would refuse or override is left off the wire and shown as not delivered,
 * so one odd variable can never fail a whole deploy at the host.
 *
 * `unreferenced` are runtime secrets in the app's resolved set that nothing
 * passes to it: they are not on the wire, but they are listed (never with a
 * value) so the owner can see why a secret they set is not there.
 */
export function buildNativeAppVariables(
  assignments: readonly RuntimeEnvAssignment[],
  app: { listenPort: number; appMode?: 'production' | 'development' },
  unreferenced: readonly UnreferencedSecret[] = []
): NativeAppVariables {
  const byName = new Map<string, RuntimeEnvAssignment>()
  for (const assignment of assignments) byName.set(assignment.name, assignment)

  const variables: EnvironmentDeployNativeAppVariable[] = []
  const view: NativeAppVariableView[] = platformView(app)
  const sorted = [...byName.values()].sort(compareByName)
  for (const assignment of sorted) {
    const base = {
      name: assignment.name,
      source: assignment.source ?? 'unknown',
      isSecret: assignment.isSecret,
      value: assignment.value,
    }
    const reason =
      rejection(assignment) ?? (variables.length >= NATIVE_APP_MAX_VARIABLES ? 'too_many' : null)
    if (reason !== null) {
      view.push({ ...base, delivered: false, reason })
      continue
    }
    variables.push(
      assignment.value === null
        ? { name: assignment.name, secretKey: assignment.key }
        : { name: assignment.name, value: assignment.value }
    )
    view.push({ ...base, delivered: true })
  }
  for (const secret of unreferenced) {
    if (byName.has(secret.key)) continue
    view.push({
      name: secret.key,
      source: secret.source ?? 'unknown',
      isSecret: true,
      value: null,
      delivered: false,
      reason: 'not_referenced',
    })
  }
  return { variables, view }
}
