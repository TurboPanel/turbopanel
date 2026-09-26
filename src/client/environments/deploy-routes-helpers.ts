import { attachWebMetadataToSites } from '../../features/hostings/hosting-web-env.ts'
import { assignSiteListenPorts } from '../../features/compose/site.ts'
import { assignNativeAppListenPorts } from '../../features/compose/native-app.ts'
import type {
  EnvironmentDeployComposeFile,
  EnvironmentDeployHosting,
  EnvironmentDeployIngressService,
  EnvironmentDeployNativeAppService,
  EnvironmentDeployStorageMaterial,
  EnvironmentDeploySite,
  EnvironmentLifecycleAction,
} from '../../contracts/commands/schemas.ts'
import type { DeployPrepareError, PreparedNativeAppService } from './deploy-prepare.ts'
import {
  validateDeployHostings,
  validateDeployStorageMaterialList,
} from '../../contracts/commands/deploy-validation.ts'
import type { FabricGateOutcome } from '../../features/fabric/gate.ts'
import type { ScheduleErrorCode } from '../../features/schedule/index.ts'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readHostnames(options: unknown): string[] {
  if (!isPlainObject(options)) return []
  const hostnames = options.hostnames
  if (!Array.isArray(hostnames)) return []
  return hostnames.filter((h): h is string => typeof h === 'string' && h.length > 0)
}

export function readPathPrefix(options: unknown): string | undefined {
  if (!isPlainObject(options)) return undefined
  return typeof options.pathPrefix === 'string' ? options.pathPrefix : undefined
}

export function readTargetPort(options: unknown): number | undefined {
  if (!isPlainObject(options)) return undefined
  return typeof options.targetPort === 'number' && Number.isFinite(options.targetPort)
    ? options.targetPort
    : undefined
}

export function readHostingProtocol(options: unknown): 'http' | 'tcp' | 'udp' {
  if (!isPlainObject(options)) return 'http'
  return options.protocol === 'tcp' || options.protocol === 'udp' ? options.protocol : 'http'
}

function isValidHostingPortValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

export function readHostingPorts(options: unknown): { published: number; target: number }[] {
  if (!isPlainObject(options) || !Array.isArray(options.ports)) return []
  const ports: { published: number; target: number }[] = []
  for (const entry of options.ports) {
    if (
      isPlainObject(entry) &&
      isValidHostingPortValue(entry.published) &&
      isValidHostingPortValue(entry.target)
    ) {
      ports.push({ published: entry.published, target: entry.target })
    }
  }
  return ports
}

/**
 * Docker Compose `-p` project name for an environment deploy.
 *
 * Uses the TurboPanel **project** UUID — never the operator display name.
 * Container names are separately obfuscated via service-UUID allocation
 * (`containerNaming: uuid`).
 */
export function composeProjectName(projectId: string): string {
  return projectId
}

export function tlsPinErrorCode(
  error: 'pin_not_found' | 'pin_mismatch' | 'pin_not_ready',
): string {
  switch (error) {
    case 'pin_mismatch':
      return 'tls_pin_mismatch'
    case 'pin_not_ready':
      return 'tls_pin_not_ready'
    case 'pin_not_found':
      return 'tls_pin_not_found'
  }
}

export type PrepareErrorResponse = {
  status: number
  body: Record<string, unknown>
}

export function fabricGateErrorResponse(
  outcome: Exclude<FabricGateOutcome, { kind: 'ready' }>,
): PrepareErrorResponse {
  if (outcome.kind === 'failed') {
    return {
      status: 422,
      body: {
        error: 'fabric_reconcile_failed',
        serverId: outcome.serverId,
        commandId: outcome.commandId,
        ...(outcome.error ? { message: outcome.error } : {}),
      },
    }
  }
  return {
    status: 409,
    body: {
      error: 'fabric_reconcile_pending',
      pending: outcome.pending,
    },
  }
}

/**
 * Map a `SchedulePlan` refusal onto an HTTP answer.
 *
 * `no_eligible_server` is the one that is not the document's fault — no host
 * the request could have used is available — so it answers `409` with the
 * route's own `server_placement_required`, telling the caller to pick a server.
 * Every other code (`turbofabric_required`, `host_port_conflict`,
 * `constraint_unsatisfiable`, `colocation_conflict`,
 * `max_replicas_per_node_exceeded`) means the plan the *document* asks for
 * cannot be built from the fleet as it stands, which is a `422` carrying the
 * scheduler's own code and message verbatim — the message is the diagnosis, and
 * paraphrasing it here would put a second, vaguer sentence between the operator
 * and the reason.
 */
export function scheduleErrorResponse(
  error: ScheduleErrorCode,
  message: string,
): PrepareErrorResponse {
  if (error === 'no_eligible_server') {
    return { status: 409, body: { error: 'server_placement_required' } }
  }
  return { status: 422, body: { error, message } }
}

export type QueuedCommandRef = {
  commandId: string
  serverId: string
  status: 'queued'
}

export function queuedCommandsResponseBody(
  commands: readonly QueuedCommandRef[],
): Record<string, unknown> {
  const first = commands[0]
  return {
    ok: true as const,
    commandId: first?.commandId ?? '',
    status: 'queued' as const,
    ...(first ? { serverId: first.serverId } : {}),
    commands: commands.map((row) => ({
      commandId: row.commandId,
      serverId: row.serverId,
      status: row.status,
    })),
  }
}

export function deployMaterialsErrorResponse(
  hostings: EnvironmentDeployHosting[],
  storageMaterial: EnvironmentDeployStorageMaterial[],
): Response | null {
  const validationError = validateDeployMaterials(hostings, storageMaterial)
  if (!validationError) return null
  return Response.json(
    { error: validationError.error, message: validationError.message },
    { status: 400 },
  )
}

type VariablePrepareError = Extract<
  DeployPrepareError,
  {
    kind:
      | 'variable_unresolved'
      | 'variable_ref_invalid'
      | 'variable_secret_interpolation'
  }
>

type StorageLocationUnavailableError = Extract<
  DeployPrepareError,
  { kind: 'storage_location_unavailable' }
>

function variablePrepareErrorResponse(prepared: VariablePrepareError): PrepareErrorResponse {
  const body: Record<string, unknown> = {
    error: prepared.kind,
    message: prepared.message,
  }
  if (prepared.composeServiceName) {
    body.composeServiceName = prepared.composeServiceName
  }
  if ('ref' in prepared && prepared.ref) {
    body.ref = prepared.ref
  }
  if (prepared.envKey) {
    body.envKey = prepared.envKey
  }
  return { status: 422, body }
}

function storageLocationUnavailableMessage(prepared: StorageLocationUnavailableError): string {
  const prefix =
    `Storage "${prepared.storageName}" (${prepared.accessMode}) has no usable location on this server`
  if (!prepared.primaryServerId) {
    return prefix
  }
  return `${prefix}; primary copy is on ${prepared.primaryServerId}`
}

function storageLocationUnavailableResponse(
  prepared: StorageLocationUnavailableError,
): PrepareErrorResponse {
  return {
    status: 422,
    body: {
      error: 'storage_location_unavailable',
      storageId: prepared.storageId,
      storageName: prepared.storageName,
      accessMode: prepared.accessMode,
      primaryServerId: prepared.primaryServerId,
      scheduledServerId: prepared.scheduledServerId,
      serviceId: prepared.serviceId,
      message: storageLocationUnavailableMessage(prepared),
    },
  }
}

function composeIssuePaths(issues: ReadonlyArray<{ path: string; message: string }>): string {
  return issues.map((issue) => issue.path).join(', ')
}

function composeIssueDetails(issues: ReadonlyArray<{ path: string; message: string }>): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
}

function fieldNoun(count: number): string {
  return count === 1 ? 'a field' : 'fields'
}

function pronounWord(count: number): string {
  return count === 1 ? 'it' : 'them'
}

function mapComposeMergeError(
  prepared: Extract<DeployPrepareError, { kind: 'compose_merged_invalid' }>,
): PrepareErrorResponse {
  return {
    status: 422,
    body: {
      error: 'compose_merged_invalid',
      issues: prepared.issues,
      message:
        `The project and environment compose layers merge into a document TurboPanel cannot run: ${composeIssueDetails(prepared.issues)}. Each layer is valid on its own, so the fix is in how the overlay changes the base.`,
    },
  }
}

function mapComposeUnsupportedError(
  prepared: Extract<DeployPrepareError, { kind: 'compose_field_unsupported' }>,
): PrepareErrorResponse {
  const count = prepared.issues.length
  return {
    status: 422,
    body: {
      error: 'compose_field_unsupported',
      issues: prepared.issues,
      message:
        `This compose document sets ${fieldNoun(count)} TurboPanel does not support: ${composeIssuePaths(prepared.issues)}. Remove ${pronounWord(count)} and deploy again — leaving ${pronounWord(count)} in place would deploy something different from what the document says.`,
    },
  }
}

function mapComposeOptInError(
  prepared: Extract<DeployPrepareError, { kind: 'compose_field_requires_org_opt_in' }>,
): PrepareErrorResponse {
  return {
    status: 403,
    body: {
      error: 'compose_field_requires_org_opt_in',
      issues: prepared.issues,
      message:
        `This compose document reaches the host through ${composeIssuePaths(prepared.issues)}. Host-level Compose features are off for this organization. An organization owner can turn them on under Manage Organization → Compose, and then only an organization manager or owner can deploy them.`,
    },
  }
}

function mapComposeHostAccessActorError(
  prepared: Extract<
    DeployPrepareError,
    {
      kind:
        | 'compose_host_access_requires_manager'
        | 'compose_host_access_requires_approval'
    }
  >,
): PrepareErrorResponse {
  const paths = composeIssuePaths(prepared.issues)
  const message = prepared.kind === 'compose_host_access_requires_manager'
    ? `This compose document reaches the host through ${paths}. Only an organization manager or owner can deploy host-level Compose features.`
    : `This compose document reaches the host through ${paths}, and no organization manager or owner has deployed it in this form yet. Deploy it once from the console to approve it; automated deploys of the same content will then run.`
  return {
    status: 403,
    body: { error: prepared.kind, issues: prepared.issues, message },
  }
}

function mapSitePrepareError(
  prepared: Extract<
    DeployPrepareError,
    {
      kind:
        | 'site_principal_ambiguous'
        | 'site_cron_unowned'
        | 'site_managed_directory_unowned'
    }
  >,
): PrepareErrorResponse {
  if (prepared.kind === 'site_principal_ambiguous') {
    return {
      status: 422,
      body: {
        error: 'site_principal_ambiguous',
        composeServiceName: prepared.composeServiceName,
        message:
          `Site "${prepared.composeServiceName}" has more than one project principal assigned. Keep a single principal for site ownership.`,
      },
    }
  }
  if (prepared.kind === 'site_cron_unowned') {
    return {
      status: 422,
      body: {
        error: 'site_cron_unowned',
        composeServiceName: prepared.composeServiceName,
        message:
          `Site "${prepared.composeServiceName}" has scheduled jobs but no project principal to run them as. Assign a principal to the service — a timer with no account would run as root, which TurboPanel will not do.`,
      },
    }
  }
  return {
    status: 422,
    body: {
      error: 'site_managed_directory_unowned',
      composeServiceName: prepared.composeServiceName,
      message:
        `Site "${prepared.composeServiceName}" serves an uploaded directory but has no project principal to own it. Assign a principal to the service — the directory is the account's, and without one there is nobody to upload as.`,
    },
  }
}

function hostingTlsRefUnresolvedMessage(
  prepared: Extract<DeployPrepareError, { kind: 'hosting_tls_ref_unresolved' }>,
): string {
  if (prepared.reason === 'ambiguous') {
    return `More than one certificate in this organization is named "${prepared.ref}", which "${prepared.composeServiceName}" pins for ${prepared.hostname}. Name it by id instead, or give the certificates distinct names.`
  }
  return `Certificate "${prepared.ref}" pinned by "${prepared.composeServiceName}" for ${prepared.hostname} was not found in this organization. Add it to the TLS library, or point tls.certificateRef at one that is already there.`
}

function hostingIpRefUnresolvedMessage(
  prepared: Extract<DeployPrepareError, { kind: 'hosting_ip_ref_unresolved' }>,
): string {
  if (prepared.reason === 'ambiguous') {
    return `More than one managed address in this organization matches "${prepared.ref}", which "${prepared.composeServiceName}" pins for ${prepared.hostname}. Name it by id instead.`
  }
  return `Managed address "${prepared.ref}" pinned by "${prepared.composeServiceName}" for ${prepared.hostname} was not found in this organization. Register it under Datacenters → IPs, or point bind.ipRef at one that is already there.`
}

function mapHostingPrepareError(
  prepared: Extract<
    DeployPrepareError,
    {
      kind:
        | 'hosting_tls_ref_unresolved'
        | 'hosting_ip_ref_unresolved'
        | 'hosting_tls_mode_unsupported'
        | 'hosting_route_conflict'
        | 'hosting_hostname_conflict'
    }
  >,
): PrepareErrorResponse {
  if (prepared.kind === 'hosting_tls_ref_unresolved') {
    return {
      status: 422,
      body: {
        error: 'hosting_tls_ref_unresolved',
        composeServiceName: prepared.composeServiceName,
        hostname: prepared.hostname,
        ref: prepared.ref,
        reason: prepared.reason,
        message: hostingTlsRefUnresolvedMessage(prepared),
      },
    }
  }
  if (prepared.kind === 'hosting_ip_ref_unresolved') {
    return {
      status: 422,
      body: {
        error: 'hosting_ip_ref_unresolved',
        composeServiceName: prepared.composeServiceName,
        hostname: prepared.hostname,
        ref: prepared.ref,
        reason: prepared.reason,
        message: hostingIpRefUnresolvedMessage(prepared),
      },
    }
  }
  if (prepared.kind === 'hosting_tls_mode_unsupported') {
    return {
      status: 422,
      body: {
        error: 'hosting_tls_mode_unsupported',
        composeServiceName: prepared.composeServiceName,
        hostname: prepared.hostname,
        mode: prepared.mode,
        message:
          `"${prepared.composeServiceName}" asks for tls.mode "${prepared.mode}" on ${prepared.hostname}, which this platform cannot issue yet. Use "internal" for a self-signed certificate, or "certificate" with tls.certificateRef to pin one from the TLS library.`,
      },
    }
  }
  if (prepared.kind === 'hosting_route_conflict') {
    return {
      status: 409,
      body: {
        error: 'hosting_route_conflict',
        composeServiceName: prepared.composeServiceName,
        hostname: prepared.hostname,
        pathPrefix: prepared.pathPrefix,
        hostingId: prepared.hostingId,
        otherHostnames: prepared.otherHostnames,
        message:
          `"${prepared.composeServiceName}" declares ${prepared.hostname}${prepared.pathPrefix}, which an existing hosting already serves alongside ${
            prepared.otherHostnames.join(', ')
          }. Compose can only take over a hosting that serves this one hostname — split the other hostnames onto their own hosting, or drop the declaration and keep editing the route in the panel.`,
      },
    }
  }
  return {
    status: 409,
    body: {
      error: 'hosting_hostname_conflict',
      composeServiceName: prepared.composeServiceName,
      hostname: prepared.hostname,
      message:
        `"${prepared.composeServiceName}" declares ${prepared.hostname}, which another hosting in this organization already serves. A hostname can only route to one hosting per organization.`,
    },
  }
}

function mapPrincipalPrepareError(
  prepared: Extract<
    DeployPrepareError,
    {
      kind:
        | 'source_principal_ambiguous'
        | 'principal_alias_unknown'
        | 'principal_required_for_service_kind'
        | 'source_ref_unresolved'
    }
  >,
): PrepareErrorResponse {
  if (prepared.kind === 'source_principal_ambiguous') {
    return {
      status: 422,
      body: {
        error: 'source_principal_ambiguous',
        composeServiceName: prepared.composeServiceName,
        message:
          `Git-backed service "${prepared.composeServiceName}" has more than one project principal assigned. Keep a single principal for release ownership.`,
      },
    }
  }
  if (prepared.kind === 'principal_alias_unknown') {
    return {
      status: 422,
      body: {
        error: 'principal_alias_unknown',
        composeServiceName: prepared.composeServiceName,
        alias: prepared.alias,
        message:
          `Service "${prepared.composeServiceName}" names principal "${prepared.alias}", which this document does not declare. Add "${prepared.alias}" under the top-level x-turbopanel.principals, or point x-turbopanel.principal at an alias that is already there.`,
      },
    }
  }
  if (prepared.kind === 'principal_required_for_service_kind') {
    const kindLabel = prepared.serviceKind === 'site' ? 'Site' : 'Node app'
    return {
      status: 422,
      body: {
        error: 'principal_required_for_service_kind',
        composeServiceName: prepared.composeServiceName,
        serviceKind: prepared.serviceKind,
        message:
          `${kindLabel} "${prepared.composeServiceName}" has no account to run as. Declare an alias under the top-level x-turbopanel.principals and name it from this service's x-turbopanel.principal.`,
      },
    }
  }
  return {
    status: 422,
    body: {
      error: 'source_ref_unresolved',
      composeServiceName: prepared.composeServiceName,
      sourceId: prepared.sourceId,
      ref: prepared.ref,
      message:
        `Could not resolve a commit for "${prepared.composeServiceName}" (ref "${prepared.ref}"): ${prepared.message}`,
    },
  }
}

function tryMapSitePrepareError(
  prepared: DeployPrepareError,
): PrepareErrorResponse | null {
  if (
    prepared.kind !== 'site_principal_ambiguous' &&
    prepared.kind !== 'site_cron_unowned' &&
    prepared.kind !== 'site_managed_directory_unowned'
  ) {
    return null
  }
  return mapSitePrepareError(prepared)
}

function tryMapHostingPrepareError(
  prepared: DeployPrepareError,
): PrepareErrorResponse | null {
  if (
    prepared.kind !== 'hosting_tls_ref_unresolved' &&
    prepared.kind !== 'hosting_ip_ref_unresolved' &&
    prepared.kind !== 'hosting_tls_mode_unsupported' &&
    prepared.kind !== 'hosting_route_conflict' &&
    prepared.kind !== 'hosting_hostname_conflict'
  ) {
    return null
  }
  return mapHostingPrepareError(prepared)
}

function tryMapPrincipalPrepareError(
  prepared: DeployPrepareError,
): PrepareErrorResponse | null {
  if (
    prepared.kind !== 'source_principal_ambiguous' &&
    prepared.kind !== 'principal_alias_unknown' &&
    prepared.kind !== 'principal_required_for_service_kind' &&
    prepared.kind !== 'source_ref_unresolved'
  ) {
    return null
  }
  return mapPrincipalPrepareError(prepared)
}

export function mapPrepareErrorResponse(prepared: DeployPrepareError): PrepareErrorResponse {
  return tryMapSitePrepareError(prepared)
    ?? tryMapPrincipalPrepareError(prepared)
    ?? tryMapHostingPrepareError(prepared)
    ?? mapCorePrepareError(prepared)
}

function mapCorePrepareError(prepared: DeployPrepareError): PrepareErrorResponse {
  switch (prepared.kind) {
    case 'health_check':
      return {
        status: 409,
        body: {
          error: 'health_check_missing',
          required: prepared.required,
          services: prepared.services,
        },
      }
    case 'empty_compose':
      return { status: 400, body: { error: 'compose_empty' } }
    // Deliberately not `compose_invalid`: the document is a valid Compose file.
    // What it names is something this platform does not implement, so the fix
    // is to drop the field (or deploy it somewhere that honours it), not to
    // hunt for a typo. Before the field registry these were deleted during
    // compile with nothing said about it.
    // The merge of layers that each saved cleanly is not itself runnable. Its
    // own code, because the fix is not in any one stored layer — it is in what
    // the overlay does to the base, most often a `!reset` that removed
    // something the base still depends on.
    case 'compose_merged_invalid':
      return mapComposeMergeError(prepared)
    case 'compose_field_unsupported':
      return mapComposeUnsupportedError(prepared)
    // TurboPanel *does* implement this field — unlike compose_field_unsupported
    // above, the fix is an org-owner opt-in
    // (PUT /organizations/:id/compose-privileged-fields), not removing the
    // field. 403, not 422: the document is valid and the field is real, this
    // organization is simply not authorized to deploy it.
    case 'compose_field_requires_org_opt_in':
      return mapComposeOptInError(prepared)
    // The organization has host-level features on, but this actor may not use
    // them — a person without organization:manage, or a webhook deploy of
    // host-level content no manager or owner has deployed in this form.
    case 'compose_host_access_requires_manager':
    case 'compose_host_access_requires_approval':
      return mapComposeHostAccessActorError(prepared)
    case 'datacenter_ip_required':
      return {
        status: 422,
        body: {
          error: 'datacenter_ip_required',
          serverId: prepared.serverId,
        },
      }
    case 'docker_external_network_unregistered':
      return {
        status: 422,
        body: {
          error: 'docker_external_network_unregistered',
          names: prepared.names,
          message:
            'Compose references external Docker network(s) that are not registered for this server. Add a Docker network under Servers → Networks with matching options.dockerNetworkName.',
        },
      }
    case 'binding_endpoint_unavailable':
      return {
        status: 422,
        body: {
          error: 'binding_endpoint_unavailable',
          message:
            'A service binding could not resolve a ProxySQL listener for its managed cluster.',
        },
      }
    case 'variable_unresolved':
    case 'variable_ref_invalid':
    case 'variable_secret_interpolation':
      return variablePrepareErrorResponse(prepared)
    case 'storage_location_unavailable':
      return storageLocationUnavailableResponse(prepared)
    case 'resource_limit':
      return {
        status: 409,
        body: {
          error: 'resource_limit_exceeded',
          violations: prepared.violations,
        },
      }
    default:
      throw new TypeError(`unhandled deploy prepare error: ${prepared.kind}`)
  }
}

/** Longest accepted `ref`; matches `SOURCE_BRANCH_MAX_LENGTH` on the source row. */
export const DEPLOY_REF_MAX_LENGTH = 255

/**
 * A branch, tag, or commit SHA to deploy.
 *
 * An **allowlist**, not a denylist of the characters git forbids (`~ ^ : ? * [
 * \\`, whitespace, control codes). The value ends up in a checkout, so the safe
 * direction is to accept only what real ref names actually use and reject
 * everything else — a denylist has to be complete to be correct, and this one
 * does not have to be.
 */
const DEPLOY_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/+-]*$/

/**
 * Rejection sentinel for {@link parseDeployRef}.
 *
 * A symbol rather than the string `'invalid'`: `invalid` is itself a legal ref (it
 * matches {@link DEPLOY_REF_RE}), so a string sentinel cannot be told apart
 * from a branch or tag actually named that.
 */
export const DEPLOY_REF_INVALID: unique symbol = Symbol('deploy_ref_invalid')

/**
 * Parse the optional `ref`. Returns `null` when absent (deploy whatever each
 * source's own branch resolves to), the trimmed value when valid, or
 * {@link DEPLOY_REF_INVALID}.
 */
export function parseDeployRef(
  value: unknown,
): string | null | typeof DEPLOY_REF_INVALID {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') return DEPLOY_REF_INVALID
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > DEPLOY_REF_MAX_LENGTH) return DEPLOY_REF_INVALID
  if (trimmed.startsWith('-') || trimmed.includes('..')) return DEPLOY_REF_INVALID
  if (!DEPLOY_REF_RE.test(trimmed)) return DEPLOY_REF_INVALID
  return trimmed
}

export function parseDeployRequestFlags(
  body: unknown,
):
  | {
    acknowledgeHealthCheckWarnings: boolean
    noCache: boolean
    ref: string | null
  }
  | 'invalid' {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'invalid'
  }
  const record = body as Record<string, unknown>
  const ref = parseDeployRef(record.ref)
  if (ref === DEPLOY_REF_INVALID) return 'invalid'
  return {
    acknowledgeHealthCheckWarnings: record.acknowledgeHealthCheckWarnings === true,
    noCache: record.noCache === true,
    ref,
  }
}

export function parseLifecycleAction(
  body: unknown,
): EnvironmentLifecycleAction | 'invalid' {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'invalid'
  }
  const action = (body as Record<string, unknown>).action
  if (action === 'start' || action === 'stop' || action === 'restart') {
    return action
  }
  return 'invalid'
}

/**
 * Expand each hosting onto multi-instance clone compose keys.
 * Keeps the same `hostingId` / `serviceId` so Traefik merges labels.
 */
export function expandHostingsForComposeInstances(
  hostings: readonly EnvironmentDeployHosting[],
  expansion: Readonly<Record<string, string[]>>,
): EnvironmentDeployHosting[] {
  const out: EnvironmentDeployHosting[] = []
  for (const entry of hostings) {
    const clones = expansion[entry.composeServiceName]
    if (!clones || clones.length === 0) {
      out.push(entry)
      continue
    }
    for (const cloneName of clones) {
      out.push({
        ...entry,
        composeServiceName: cloneName,
      })
    }
  }
  return out
}

/**
 * `targetPort` per compose service, for the lanes allowed to be steered by one.
 *
 * The **site** lane only: a site's engine vhost is stood up on a loopback port,
 * and a panel-authored `targetPort` on its hosting is the operator saying which
 * one. Native apps deliberately do not read this — see
 * {@link buildNativeAppServicesForDeploy}.
 */
export function preferredListenPortsFromHostings(
  hostings: readonly EnvironmentDeployHosting[],
): Map<string, number> {
  const preferredListenPorts = new Map<string, number>()
  for (const entry of hostings) {
    if (typeof entry.targetPort === 'number') {
      preferredListenPorts.set(entry.composeServiceName, entry.targetPort)
    }
  }
  return preferredListenPorts
}

export function buildSitesForDeploy(
  sites: EnvironmentDeploySite[],
  hostings: EnvironmentDeployHosting[],
  used: Set<number> = new Set<number>(),
): EnvironmentDeploySite[] {
  return attachWebMetadataToSites(
    assignSiteListenPorts(
      sites,
      preferredListenPortsFromHostings(hostings),
      used,
    ),
    hostings,
  )
}

/**
 * Release-tree directory segment for one compose service.
 *
 * **Must** stay identical to the daemon's `resolveReleaseServiceId`
 * (`turbopaneld/src/deploy/release/apply-source-releases.ts`): hostings first,
 * then tcp/udp ingress, then the compose key. The release engine picks the
 * directory with that rule, so a native app unit whose `WorkingDirectory` were
 * derived any other way would point at a tree nothing ever published.
 */
export function resolveDeployReleaseServiceId(
  composeServiceName: string,
  hostings: readonly EnvironmentDeployHosting[],
  ingressServices: readonly EnvironmentDeployIngressService[],
): string {
  for (const hosting of hostings) {
    if (
      hosting.composeServiceName === composeServiceName && hosting.serviceId
    ) {
      return hosting.serviceId
    }
  }
  for (const ingress of ingressServices) {
    if (
      ingress.composeServiceName === composeServiceName && ingress.serviceId
    ) {
      return ingress.serviceId
    }
  }
  return composeServiceName
}

/**
 * Finalize native app rows for the wire: allocate loopback ports out of the
 * shared ledger, and resolve each release-tree `serviceId`.
 *
 * `used` is the **same** ledger `buildSitesForDeploy` was handed,
 * so the two loopback lanes cannot be given the same port.
 *
 * **No preferred ports.** A native app's listen port is TurboPanel's to
 * allocate: the daemon reads it straight off `nativeAppServices[]` to build the
 * `127.0.0.1:<port>` upstream (`buildCaddyHostnameRoutes`) and to render the
 * systemd unit's `PORT`, and it never looks at the hosting's `targetPort`.
 * Feeding hosting `targetPort` values in here would let a route declaration
 * move the port the process is told to bind — a second source of truth for an
 * allocation that has exactly one owner. `x-turbopanel.hosting[].targetPort` is
 * refused on `serviceKind: node` for the same reason
 * (`hostingTargetPortAuthorable`).
 */
export function buildNativeAppServicesForDeploy(
  nativeAppServices: readonly PreparedNativeAppService[],
  hostings: EnvironmentDeployHosting[],
  ingressServices: readonly EnvironmentDeployIngressService[],
  used: Set<number> = new Set<number>(),
): EnvironmentDeployNativeAppService[] {
  if (nativeAppServices.length === 0) return []
  return assignNativeAppListenPorts(
    nativeAppServices,
    new Map<string, number>(),
    used,
  ).map((app) => ({
    ...app,
    serviceId: resolveDeployReleaseServiceId(
      app.composeServiceName,
      hostings,
      ingressServices,
    ),
  }))
}

export type DeployMaterialValidationError = {
  error: 'invalid_deploy_hosting' | 'invalid_deploy_storage'
  message: string
}

export function validateDeployMaterials(
  hostings: EnvironmentDeployHosting[],
  storageMaterial: EnvironmentDeployStorageMaterial[],
): DeployMaterialValidationError | null {
  const hostingValidationError = validateDeployHostings(hostings)
  if (hostingValidationError) {
    return { error: 'invalid_deploy_hosting', message: hostingValidationError }
  }

  const storageValidationError = validateDeployStorageMaterialList(storageMaterial)
  if (storageValidationError) {
    return { error: 'invalid_deploy_storage', message: storageValidationError }
  }

  return null
}

/**
 * True when any hosting routes HTTP hostnames through the shared loopback
 * Traefik. Empty hostnames and `tcp`/`udp` hostings
 * do not need that proxy.
 */
export function hostingsNeedSharedHttpIngress(
  hostings: readonly EnvironmentDeployHosting[],
): boolean {
  for (const hosting of hostings) {
    if (hosting.protocol === 'tcp' || hosting.protocol === 'udp') continue
    if (hosting.hostnames.length > 0) return true
  }
  return false
}

export type DeployPreviewContainerRow = {
  serviceId: string
  composeServiceName: string
  containerName: string
  ordinal: number
  role: 'service' | 'ingress'
}

export function buildDeployPreviewContainers(input: {
  appContainers: Array<{
    serviceId: string
    cloneComposeServiceName: string
    containerName: string
    ordinal: number
  }>
  ingressServices: Array<{
    serviceId: string
    composeServiceName: string
    containerName: string
  }>
}): DeployPreviewContainerRow[] {
  const appContainers = input.appContainers.map((row) => ({
    serviceId: row.serviceId,
    composeServiceName: row.cloneComposeServiceName,
    containerName: row.containerName,
    ordinal: row.ordinal,
    role: 'service' as const,
  }))
  const ingressContainers = input.ingressServices.map((row) => ({
    serviceId: row.serviceId,
    composeServiceName: row.composeServiceName,
    containerName: row.containerName,
    ordinal: 1,
    role: 'ingress' as const,
  }))
  return [...appContainers, ...ingressContainers]
}

export type DeployPreviewServerRow = {
  serverId: string
  name: string
  composeFiles: EnvironmentDeployComposeFile[]
  services: string[]
}

/** Display name, then hostname, then the server id. */
export function deployPreviewServerLabel(
  name: string | null | undefined,
  hostname: string | null | undefined,
  serverId: string,
): string {
  const displayName = name?.trim()
  if (displayName) return displayName
  const host = hostname?.trim()
  if (host) return host
  return serverId
}

/**
 * Per-host compiled snapshots. Omitted for a whole-environment pin /
 * single-server plan so the UI does not duplicate the top-level compose.yaml.
 */
export function buildDeployPreviewServers(
  preparedByServer: ReadonlyArray<{
    serverId: string
    prepared: {
      composeFiles: EnvironmentDeployComposeFile[]
      replicaCounts: Record<string, number>
    }
  }>,
  labelById: ReadonlyMap<string, { name: string | null; hostname: string | null }>,
): DeployPreviewServerRow[] | undefined {
  if (preparedByServer.length <= 1) return undefined
  return preparedByServer.map((row) => {
    const label = labelById.get(row.serverId)
    return {
      serverId: row.serverId,
      name: deployPreviewServerLabel(label?.name, label?.hostname, row.serverId),
      composeFiles: row.prepared.composeFiles,
      services: Object.keys(row.prepared.replicaCounts).sort((a, b) =>
        a.localeCompare(b)
      ),
    }
  })
}
