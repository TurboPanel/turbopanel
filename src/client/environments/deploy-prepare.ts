import type { Context } from 'hono'
import { and, eq, inArray, or } from 'drizzle-orm'
import type { AppEnv } from '../../app/app.ts'
import { type HostingWwwMode, hostingCertificateNames } from '../../contracts/commands/hostname.ts'
import {
  decryptSecret,
  encryptSecretForDaemon,
  ENVELOPE_MAGIC,
  isDaemonSealedEnvelope,
  isSealedEnvelope,
  resealSecretForDaemon,
} from '../../lib/secrets/data-encryption.ts'
import {
  getServerDaemonStateByServerId,
  isDaemonKeyActive,
} from '../../features/servers/server-identity-db.ts'
import {
  applyServiceOptionsToComposeDocument,
  buildServiceOptionsMap,
  collectHealthCheckWarnings,
  type ServiceDeployHook,
  type ServiceOptionsByComposeName,
} from '../../features/compose/apply-service-options.ts'
import {
  compileRuntimeCompose,
  type CompileRuntimeOptions,
} from '../../features/compose/compile-runtime.ts'
import { sha256HexUtf8 } from '../../features/compose/desired-hash.ts'
import {
  parseOrganizationOptions,
  resolveAcmeEnabled,
  resolveComposeDefaultResourceLimits,
  resolveComposeGatedFieldsEnabled,
  resolveComposeRemoteBuildSourcesEnabled,
  resolveDeployHooksEnabled,
} from '../../features/organizations/organization-options.ts'
import {
  type ApplyVariablesError,
  type ApplyVariablesResult,
  applyVariablesToComposeDocument,
  type DeployVariableEntry,
  type DeployVariableMaterial,
  isApplyVariablesError,
  type VariableScopeEntryMap,
} from '../../features/compose/apply-variables.ts'
import type { DeploySecretPlanEntry } from '../../features/compose/secret-files.ts'
import {
  type ComposeDeployValidationError,
  type ComposeDocument,
  composeDocumentToRuntimeYaml,
  type ComposeLayer,
  emptyContainerComposeYaml,
  isNodeComposeService,
  isSiteComposeService,
  mergeComposeLayers,
  type NativeAppServiceSpec,
  type SiteSpec,
  splitNativeAppServices,
  splitSiteServices,
  validateComposeForDeploy,
} from '../../features/compose/index.ts'
import type { ComposeServiceCronJob } from '../../features/compose/service-kind.ts'
import {
  type Application,
  buildApplicationModel,
  buildResolvedApplication,
  type PreparedNativeAppService,
  type ResolvedApplication,
  type ResolvedResources,
  type ResolvedService,
  type ServerDeployment,
  serviceIdsOnServer,
} from '../../features/compose/ir.ts'
import {
  environmentComposeFilename,
  renderRuntimeComposeFiles,
} from '../../features/deploy/deploy-layers.ts'
import {
  buildNativeAppVariables,
  type NativeAppVariables,
  type NativeAppVariableView,
} from '../../features/compose/native-app-variables.ts'
import { stripReservedDeployVariableKeys } from '../../features/compose/platform-variables.ts'
import { renameComposeVolumes } from '../../features/compose/rename-volumes.ts'
import {
  collectComposeExternalDockerNetworkNames,
  pruneUnreferencedComposeNetworks,
} from '../../features/compose/docker-external-networks.ts'
import { principalHomeDir, principalVolumePath, resolveDockerVolumeName } from '../../lib/naming.ts'
import { accessGroupsFor } from '../../features/principals/principal-access.ts'
import { SHA512_CRYPT_HASH_RE } from '../../lib/sha512-crypt.ts'
import {
  CRON_JOB_NAME_RE,
  cronJobUnitName,
  cronToOnCalendar,
  MAX_CRON_JOBS_PER_SERVICE,
  parseCronCommand,
} from '../../features/deploy/cron.ts'
import { listTasksForServices, type TaskRecord } from '../../features/schedule/task-records.ts'
import { loadSshKeysByPrincipalIds } from '../principals/ssh-keys.ts'
import {
  parsePrincipalOptions,
  resolvePrincipalIdOverride,
  resolvePrincipalShell,
} from '../../features/principals/principal-options.ts'
import { renderPhpForDeploy } from '../../features/hostings/php-settings.ts'
import { type PhpModePrepareError, withSitePhpModes } from './deploy-php-modes.ts'
import {
  type NativeAppNodeVersionView,
  type NodeVersionPrepareError,
  repositoryNodeVersionReader,
  resolveSourceNodeVersions,
} from './deploy-node-version.ts'
import {
  DEFAULT_NATIVE_APP_DENO_SERIES,
  denoRuntimeSeries,
} from '../../contracts/runtime-registry.ts'
import {
  type DenoAppFeatureError,
  withDenoNativeApps,
  withRecordedRuntimes,
} from './deploy-deno-gate.ts'
import { type SiteEngineFeatureError, withSiteEngineFeature } from './deploy-site-engine-gate.ts'
import { type SiteDbBindingsWarning, withSiteDbBindings } from './deploy-site-db-bindings.ts'
import {
  deliveryByServiceId,
  hostRunDeliveryByComposeName,
  type BindingDelivery,
} from '../../features/bindings/host-run.ts'
import { PHP_SITE_MODES_FEATURE } from '../../lib/version-wire.ts'
import {
  isComposeChainError,
  resolveComposeLayerChain,
} from '../../features/compose/layer-chain.ts'
import {
  ALLOWED_PHP_EXTENSIONS,
  SUPPORTED_PHP_SERIES,
} from '../../features/compose/service-kind.ts'
import {
  parseProjectOptions,
  resolveContainerNaming,
  resolveEffectivePlacementServerId,
} from '../../features/projects/project-options.ts'
import {
  parseServiceOptions,
  resolveServiceInstances,
} from '../../features/projects/service-options.ts'
import { resolveRegisteredExternalDockerNetworks } from './validate-docker-external-networks.ts'
import { ensureOrganizationManagedNetwork } from '../../features/fabric/fabric-records.ts'
import type { DesiredSlotInput } from '../../features/servers/slot-records.ts'
import { localReplicaCounts, localServiceNames } from '../../features/schedule/planner.ts'
import type { SpanningHostsForService } from '../../features/schedule/slot-addresses.ts'
import {
  allocateEnvironmentContainers,
  authoredContainerNamesForAllocation,
  buildContainerServiceSpecs,
  type ContainerAllocation,
  type ContainerServiceSpec,
  ensureServiceIngressContainerAllocation,
} from '../../features/environments/allocate-containers.ts'
import { resolveTcpUdpIngressServices } from './tcp-udp-ingress.ts'
import {
  registerComposeVolumes,
  type RegisteredComposeVolume,
} from '../../features/deploy/register-compose-volumes.ts'
import { registerComposeMounts } from '../../features/deploy/register-compose-mounts.ts'
import type {
  EnvironmentDeployComposeFile,
  EnvironmentDeployCronJob,
  EnvironmentDeployDockerNetwork,
  EnvironmentDeployFabricNetwork,
  EnvironmentDeployHosting,
  EnvironmentDeployIngressService,
  EnvironmentDeployNativeAppService,
  EnvironmentDeployPrincipalMaterial,
  EnvironmentDeploySite,
  EnvironmentDeploySitePrincipal,
  EnvironmentDeploySource,
  EnvironmentDeployStorageMaterial,
  EnvironmentDeployStorageMount,
  EnvironmentDeployTlsMaterial,
  EnvironmentDeployVariableMaterial,
} from '../../contracts/commands/schemas.ts'
import {
  type DeployRollbackRequest,
  type DeploySourcePrepareError,
  type ReleaseIdAllocator,
  resolveDeploySourceMaterial,
} from './deploy-sources.ts'
import {
  binding,
  environment,
  hosting,
  ip,
  mount,
  organization,
  principal,
  project,
  server,
  service,
  storage,
  storageCopy,
  tls,
} from '../../db/schema.ts'
import {
  checkResourceLimits,
  parseResourceLimits,
  sumServiceResourceUsage,
} from '../../features/organizations/resource-limits.ts'
import { effectiveServiceResources } from '../../features/organizations/compose-resource-usage.ts'
import {
  type HostingBindScope,
  parseHostingOptions,
  resolveHostingBind,
  resolveHostingProxy,
} from '../../features/hostings/hosting-options.ts'
import { inetAddressToString } from '../../lib/ip-address.ts'
import { loadServerDatacenterAddress } from '../../features/net/private-endpoint.ts'
import { reconcileServicesFromCompose } from '../../features/deploy/reconcile-services.ts'
import { type ComposeHostingError, reconcileHostingsFromCompose } from './reconcile-hostings.ts'
import type { Db } from '../../db/connection.ts'
import {
  mergeHostingVariablesForService,
  type ResolvedVariableMap,
  type ResolvedVariableScopes,
  resolveInheritedVariableBundleForService,
  resolveInheritedVariablesForEnvironment,
  resolveServerScopedVariables,
  resolveVariableSource,
} from '../../features/variables/resolve-inherited.ts'
import {
  type ComposePrincipalResolution,
  loadPrincipalIdsByServiceIdForEnvironment,
  loadTenancyPrincipalIdsForEnvironment,
  pickSolePrincipalId,
  reconcilePrincipalsFromCompose,
} from '../principals/tenancies.ts'
import {
  materializeBindingsForServices,
  reapplyBindingOwnedVariables,
} from '../../features/bindings/materialize.ts'
import type { DerivedSecretsConfig, SecretsConfig } from '../../lib/secrets/secrets.ts'
import { resolveHostingDeployWeb } from '../../features/hostings/hosting-web-env.ts'
import {
  assembleTlsMetadata,
  coversAllHostnames,
  parseTlsOptions,
  resolveTlsForHosting,
  TLS_SOURCES,
  type TlsCandidate,
  type TlsSource,
  type TlsStatus,
} from '../../lib/tls/index.ts'
import {
  deployMaterialsErrorResponse,
  expandHostingsForComposeInstances,
  hostingsNeedSharedHttpIngress,
  readHostingPorts,
  readHostingProtocol,
  readHostnames,
  readPathPrefix,
  readTargetPort,
  readWwwMode,
  tlsPinErrorCode,
} from './deploy-routes-helpers.ts'
import {
  ensureSystemHierarchy,
  SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
} from '../../features/system/hierarchy.ts'
import { forEachSequential } from '../../lib/sequential.ts'
import { loadManagedIngressPorts } from '../../features/managed/load-org-defaults.ts'
import { DEFAULT_MANAGED_INGRESS_PORTS } from '../../features/managed/ingress-ports.ts'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when `serverId` belongs to `organizationId`. */
export async function verifyServerInOrg(
  db: Db,
  serverId: string,
  organizationId: string
): Promise<boolean> {
  const [row] = await db
    .select({ id: server.id })
    .from(server)
    .where(and(eq(server.id, serverId), eq(server.organizationId, organizationId)))
    .limit(1)
  return Boolean(row)
}

function extractComposeFromOptions(options: unknown): unknown {
  if (!isPlainObject(options)) return null
  return options.compose ?? null
}

export type DeployPrepareWarningCode =
  | 'empty_compose'
  | 'resource_limit_exceeded'
  | 'health_check_missing'
  | 'docker_external_network_unregistered'
  | 'site_principal_ambiguous'
  | 'site_managed_directory_unowned'
  | 'site_cron_unowned'
  | 'source_principal_ambiguous'
  | 'principal_alias_unknown'
  | 'principal_required_for_service_kind'
  | 'binding_endpoint_unavailable'
  | 'site_db_ca_unavailable'
  | 'php_series_not_installed'
  | 'compose_variable_unresolved'
  | 'php_mode_not_allowed'
  | 'node_version_unresolved'

/**
 * Gate a deploy's PHP series against what the target host actually reports.
 *
 * Two outcomes, and the distinction is the whole point:
 *
 * - **Not supported at all** → a hard error before anything is queued. The
 *   operator gets "PHP 7.4 is not supported; supported: 8.1, 8.2, 8.3, 8.4, 8.5" instead of a
 *   daemon throw halfway through an apply.
 * - **Supported but not yet on this host** → proceed with a warning. The
 *   Ansible run installs it. Refusing here would reject a deploy the host can
 *   perfectly well serve — which is exactly what the old host-wide pin did.
 *
 * A server that has reported no inventory — not connected yet, or connected and
 * found nothing — is treated as *unknown*, never as *absent*: silence is not
 * evidence.
 */
export function checkPhpSeriesAvailability(params: {
  sites: readonly { composeServiceName: string; php?: { version?: string } }[]
  reportedSeries: readonly string[] | null
}): { errors: string[]; warnings: DeployPrepareWarning[] } {
  const errors: string[] = []
  const warnings: DeployPrepareWarning[] = []
  for (const site of params.sites) {
    const version = site.php?.version?.trim()
    if (!version) continue
    if (!SUPPORTED_PHP_SERIES.includes(version)) {
      errors.push(
        `Service "${site.composeServiceName}" requests PHP ${version}, which is not supported. Supported: ${SUPPORTED_PHP_SERIES.join(
          ', '
        )}.`
      )
      continue
    }
    // No report at all means "unknown", not "missing" — do not warn on silence.
    if (params.reportedSeries === null) continue
    if (!params.reportedSeries.includes(version)) {
      warnings.push({
        code: 'php_series_not_installed',
        message: `PHP ${version} is not installed on the target server yet; the deploy will install it.`,
        details: {
          composeServiceName: site.composeServiceName,
          series: version,
          installed: [...params.reportedSeries],
        },
      })
    }
  }
  return { errors, warnings }
}

export type DeployPrepareWarning = {
  code: DeployPrepareWarningCode
  message: string
  details?: Record<string, unknown>
}

/**
 * Which commit a deploy should build, and **which source** that commit belongs
 * to.
 *
 * `ref` is what the caller asked for (a branch, tag, or SHA); `commitSha` is a
 * SHA a trigger already resolved — the GitHub webhook path knows the pushed head
 * without asking GitHub again. All three are `null` for a plain "deploy whatever
 * the environment currently holds" request.
 *
 * `sourceId` is what keeps a webhook-supplied `commitSha` from leaking across
 * repositories. One push event comes from exactly one `source` row, but an
 * environment may bind several `x-turbopanel.source` services; pinning them all
 * to that SHA would build the wrong code (or fail outright) for every unrelated
 * repository or branch in the same environment. Source resolution therefore
 * applies `commitSha` **only** to the binding whose `sourceId` matches, and
 * resolves every other binding from its own declared/default ref.
 *
 * It lives here, next to {@link prepareDeployCompose}, because prepare is where
 * source resolution will read it. Callers hand it in rather than resolving it
 * themselves so the request survives all the way to that point instead of being
 * dropped at the route boundary.
 */
export type DeploySourceSelection = {
  ref: string | null
  commitSha: string | null
  /**
   * `source.id` the trigger fired for, or `null` when the request names no
   * single source (the manual `POST /environments/:id/deploy` path). A
   * `commitSha` with no `sourceId` matches nothing and is therefore ignored.
   */
  sourceId: string | null
}

/**
 * Can this phase actually build a **requested ref**?
 *
 * Still no, and the constant says so out loud instead of leaving every call
 * site to assume it. {@link prepareDeployCompose} now does resolve
 * `x-turbopanel.source` into `sourceMaterial[]`, and it honors
 * {@link DeploySourceSelection.commitSha} — the webhook path already knows the
 * pushed head, so pinning it costs nothing. What it does **not** honor is
 * `ref`: the commit each service builds comes from the compose-declared
 * `source.branch` (else the source's default branch), never from an arbitrary
 * ref named on the request. A caller that must not silently deploy the
 * declared branch therefore checks this first and refuses — `POST
 * /environments/:id/deploy` does. This flips in one place when ref-directed
 * deploys land.
 */
export const PREPARE_HONORS_SOURCE_SELECTION = false

/**
 * Re-exported here because the rollback route builds one and hands it straight
 * to {@link prepareDeployCompose} — the same way the deploy route hands over a
 * {@link DeploySourceSelection}.
 */
export type { DeployRollbackRequest }

/**
 * Re-exported here because the deploy route creates the allocator *before* the
 * per-server prepare loop and hands the same instance to every
 * {@link prepareDeployCompose} call in that fan-out.
 */
export { createReleaseIdAllocator } from './deploy-sources.ts'
export type { ReleaseIdAllocator }

/**
 * A native app row before its release-tree `serviceId` is resolved.
 *
 * Declared with the rest of the compiler's IR in `lib/compose/ir.ts` and
 * re-exported here, where every existing caller already reaches for it.
 */
export type { PreparedNativeAppService }

/**
 * One server's slice of a prepared deploy.
 *
 * The daemon-facing half is {@link ServerDeployment} — the compiler's fourth
 * and last IR model (`lib/compose/ir.ts`), whose fields are the
 * `EnvironmentDeploy*` wire types verbatim. What this type adds on top is
 * control-plane bookkeeping that never reaches a daemon: compose-scoped hooks,
 * the container rows allocated for the deploy, the expansion map, soft
 * warnings, and the echoed source selection.
 *
 * Splitting it this way is a naming change, not a shape change: the object
 * assembled here is byte-for-byte the one assembled before, and the wire
 * contract in `lib/commands/schemas.ts` is untouched.
 */
export type PreparedDeployCompose = ServerDeployment & {
  /**
   * Compiled runtime YAML (internal prepare output for hashing/preview).
   * Wire payloads use required `composeFiles` with `role: 'runtime'`.
   */
  composeYaml: string
  hooks: ServiceDeployHook[]
  /** Pre-allocated container rows for this deploy (uuid / explicit-name paths). */
  containers: ContainerAllocation[]
  /** Original compose service key → clone keys after multi-instance expansion. */
  composeServiceExpansion: Record<string, string[]>
  /** Auto-registered compose named volumes (storage rows + resolved Docker names). */
  volumes: RegisteredComposeVolume[]
  /** Soft prepare issues (preview mode); empty for deploy. */
  warnings: DeployPrepareWarning[]
  /**
   * The {@link DeploySourceSelection} this prepare ran for, when one was given.
   *
   * Carried through rather than consumed: see
   * {@link PREPARE_HONORS_SOURCE_SELECTION}. Echoing it keeps the requested
   * commit attached to the prepared result, so the release-engine phase reads it
   * from the same object it already reads compose material from.
   */
  sourceSelection?: DeploySourceSelection
  /** Non-secret Compose project `.env` next to compose.yaml. */
  envFile?: string
  /** File-only secret mounts (no plaintext). */
  secretPlan?: DeploySecretPlanEntry[]
  /**
   * What each native app's process gets as environment variables, for people:
   * every name, where it came from, and whether it reaches the process. Secret
   * values are left out. Never sent to a daemon — the wire list is
   * `nativeAppServices[].variables`.
   */
  nativeAppVariables?: NativeAppVariablesView[]
  /**
   * The Node series each native app runs and where it came from (the compose
   * service, the repository's `package.json` / `.nvmrc` / `.node-version`, or
   * the default), for people. Never sent to a daemon — the wire value is
   * `nativeAppServices[].nodeVersion`.
   */
  nativeAppNodeVersions?: NativeAppNodeVersionView[]
  /**
   * The Deno series each Deno app (`x-turbopanel.runtime: deno`) runs and
   * whether it was pinned or defaulted, for people. Never sent to a daemon —
   * the wire value is `nativeAppServices[].denoVersion`.
   */
  nativeAppDenoVersions?: NativeAppDenoVersionView[]
}

/** One Deno app's series for the deploy preview. */
export type NativeAppDenoVersionView = {
  composeServiceName: string
  /** The Deno series the host runs it on, such as `2`. */
  denoVersion: string
  /** `compose` when `x-turbopanel.denoVersion` pinned it, else `default`. */
  source: 'compose' | 'default'
}

/** The preview's view of every Deno app: its series, pinned or defaulted. */
export function nativeAppDenoVersionViews(
  apps: readonly Pick<PreparedNativeAppService, 'composeServiceName' | 'runtime' | 'denoVersion'>[]
): NativeAppDenoVersionView[] {
  return apps
    .filter((app) => app.runtime === 'deno')
    .map((app) => {
      const pinned = app.denoVersion?.trim()
      return {
        composeServiceName: app.composeServiceName,
        denoVersion: denoRuntimeSeries(pinned || DEFAULT_NATIVE_APP_DENO_SERIES),
        source: pinned ? ('compose' as const) : ('default' as const),
      }
    })
}

/** One native app's {@link NativeAppVariableView} list. */
export type NativeAppVariablesView = {
  composeServiceName: string
  variables: NativeAppVariableView[]
}

export type DeployPrepareError =
  | { kind: 'health_check'; required: boolean; services: string[] }
  /**
   * The merged effective document failed deploy-time compose validation.
   *
   * Two kinds, because the operator's next move differs.
   * `compose_merged_invalid` means the merge of layers that each saved cleanly
   * is not a document TurboPanel can run — most often an overlay `!reset` that
   * removed something the base still depends on. `compose_field_unsupported`
   * means the document is perfectly valid Compose but names something *this
   * platform* does not do; before the field registry existed those fields were
   * deleted in `compile-runtime.ts` with no diagnostic at all — the deploy ran,
   * ignored them, and said nothing. See `lib/compose/validate-for-deploy.ts`.
   */
  | ComposeDeployValidationError
  | {
      kind: 'resource_limit'
      violations: ReturnType<typeof checkResourceLimits>
    }
  | { kind: 'empty_compose' }
  | { kind: 'datacenter_ip_required'; serverId: string }
  | { kind: 'docker_external_network_unregistered'; names: string[] }
  | { kind: 'site_principal_ambiguous'; composeServiceName: string }
  /**
   * A service names an alias the document's root never declared.
   *
   * Defense in depth — the save-time linter refuses this — so reaching it means
   * the document predates the rule or was written past the API. Silently
   * ignoring it would run the service as nobody.
   */
  | {
      kind: 'principal_alias_unknown'
      composeServiceName: string
      alias: string
    }
  /**
   * A host-native service declares no alias **and** has no steward to fall back
   * on. `site_principal_ambiguous` / `source_principal_ambiguous` stay the
   * answer for *too many* owners; this one is for none at all.
   */
  | {
      kind: 'principal_required_for_service_kind'
      composeServiceName: string
      serviceKind: 'site' | 'node'
    }
  | {
      kind: 'native_app_unresolved_service'
      composeServiceName: string
    }
  /**
   * A `x-turbopanel.hosting` entry named a certificate or a managed address
   * this organization does not have (or names two by the same label).
   *
   * A hard refusal rather than a dropped pin, for the same reason
   * `datacenter_ip_required` is: a route that quietly falls back from the
   * certificate an operator named to a self-signed one, or from a pinned
   * address to whatever the edge picks, is a silent downgrade of the thing they
   * were most explicit about. The save-time linter refuses this too when the
   * caller can hand it the resolvable sets; reaching here means it could not.
   *
   * The same union carries two siblings with the same posture:
   * `hosting_tls_mode_unsupported` (a `tls.mode` the deploy payload cannot
   * express — projecting it would answer a request for a managed certificate
   * with a self-signed one) and `hosting_route_conflict` (a declaration and a
   * panel-authored row claiming one route, where taking the row over would
   * drop the other hostnames it serves).
   */
  | ComposeHostingError
  | { kind: 'site_managed_directory_unowned'; composeServiceName: string }
  | { kind: 'site_cron_unowned'; composeServiceName: string }
  /** A PHP site asks for a mode its engine, organization or server does not offer. */
  | PhpModePrepareError
  | SiteEngineFeatureError
  /** A Deno app goes to a daemon that cannot run it, or asks for a series nothing offers. */
  | DenoAppFeatureError
  /**
   * The repository asks for a Node version no offered series satisfies, names
   * one that is not a version range, or (a deploy only) could not be read.
   */
  | NodeVersionPrepareError
  | { kind: 'source_principal_ambiguous'; composeServiceName: string }
  | {
      kind: 'source_ref_unresolved'
      composeServiceName: string
      sourceId: string
      ref: string
      message: string
    }
  | { kind: 'binding_endpoint_unavailable' }
  | { kind: 'binding_host_site_unsupported'; message: string }
  | {
      kind: 'variable_unresolved'
      message: string
      ref?: string
      composeServiceName?: string
      envKey?: string
    }
  | {
      kind: 'variable_ref_invalid'
      message: string
      composeServiceName?: string
      envKey?: string
    }
  | {
      kind: 'variable_secret_interpolation'
      message: string
      composeServiceName?: string
      envKey?: string
    }
  | {
      kind: 'storage_location_unavailable'
      storageId: string
      storageName: string
      accessMode: string
      primaryServerId: string | null
      scheduledServerId: string
      serviceId: string
    }

export type DeployPrepareMode = 'deploy' | 'preview'

/** Per-server slice of a scheduled environment deploy. */
export type DeployScheduleSlice = {
  serverId: string
  slots: readonly DesiredSlotInput[]
  serviceIdToName: ReadonlyMap<string, string>
  spanningNetworks?: ReadonlyMap<string, string>
  taskAddresses?: ReadonlyMap<string, ReadonlyMap<number, string>>
  spanningHosts?: ReadonlyMap<string, SpanningHostsForService>
  fabricNetworks?: readonly EnvironmentDeployFabricNetwork[]
  /** Per-service ProxySQL listener extra_hosts for non-co-resident consumers. */
  managedIngressHostsByService?: ReadonlyMap<
    string,
    ReadonlyArray<{ name: string; address: string }>
  >
}

async function emptyPreparedCompose(
  warnings: DeployPrepareWarning[]
): Promise<PreparedDeployCompose> {
  const emptyYaml = emptyContainerComposeYaml()
  return {
    composeYaml: emptyYaml,
    composeFiles: renderRuntimeComposeFiles(emptyYaml),
    desiredHash: await sha256HexUtf8(emptyYaml),
    replicaCounts: {},
    hooks: [],
    variableMaterial: [],
    storageMaterial: [],
    principalMaterial: [],
    sites: [],
    nativeAppServices: [],
    sourceMaterial: [],
    dockerExternalNetworks: [],
    dockerNetworkAddressing: [],
    fabricNetworks: [],
    managedNetworkServices: [],
    containers: [],
    ingressServices: [],
    // A document with no services has no routes to serve them on either. The
    // listener ports stay the platform defaults rather than an organization
    // read, because this short-circuit runs before any server is in hand.
    hostings: [],
    tlsMaterial: [],
    listenerPorts: DEFAULT_MANAGED_INGRESS_PORTS,
    composeServiceExpansion: {},
    volumes: [],
    warnings,
    nativeAppVariables: [],
    nativeAppNodeVersions: [],
    nativeAppDenoVersions: [],
  }
}

type HardDeployPrepareError =
  | { kind: 'datacenter_ip_required'; serverId: string }
  // Hard in preview too: a PHP site cannot reach this database, however it is previewed.
  | { kind: 'binding_host_site_unsupported'; message: string }
  // Hard in preview too: the site would not come up in the mode it asks for.
  | PhpModePrepareError
  | SiteEngineFeatureError
  // Hard in preview too: a Deno app sent to a daemon that cannot run it would start on Node.
  | DenoAppFeatureError
  // Hard in preview too: the build would get a Node the app says it cannot run on.
  | NodeVersionPrepareError
  // Hard in preview too: previewing a deploy that would silently ignore a field
  // — or that would be refused the moment it was run for real — is exactly the
  // reassurance an operator must not be given.
  | ComposeDeployValidationError
  | ComposeHostingError
  | {
      kind: 'source_ref_unresolved'
      composeServiceName: string
      sourceId: string
      ref: string
      message: string
    }
  | {
      kind: 'variable_unresolved'
      message: string
      ref?: string
      composeServiceName?: string
      envKey?: string
    }
  | {
      kind: 'variable_ref_invalid'
      message: string
      composeServiceName?: string
      envKey?: string
    }
  | {
      kind: 'variable_secret_interpolation'
      message: string
      composeServiceName?: string
      envKey?: string
    }
  | {
      kind: 'storage_location_unavailable'
      storageId: string
      storageName: string
      accessMode: string
      primaryServerId: string | null
      scheduledServerId: string
      serviceId: string
    }
  | {
      kind: 'native_app_unresolved_service'
      composeServiceName: string
    }

function warningFromPrepareError(
  error: Exclude<DeployPrepareError, HardDeployPrepareError>
): DeployPrepareWarning {
  switch (error.kind) {
    case 'empty_compose':
      return {
        code: 'empty_compose',
        message: 'Compose has no services to deploy.',
      }
    case 'resource_limit':
      return {
        code: 'resource_limit_exceeded',
        message: 'Requested resources exceed organization or server limits.',
        details: { violations: error.violations },
      }
    case 'health_check':
      return {
        code: 'health_check_missing',
        message: error.required
          ? 'One or more services require a health check before deploy.'
          : 'One or more services are missing a health check (warn policy).',
        details: {
          required: error.required,
          services: error.services,
        },
      }
    case 'docker_external_network_unregistered':
      return {
        code: 'docker_external_network_unregistered',
        message:
          'Compose references external Docker network(s) that are not registered for this server.',
        details: { names: error.names },
      }
    case 'site_principal_ambiguous':
      return {
        code: 'site_principal_ambiguous',
        message: `Site "${error.composeServiceName}" has more than one project principal assigned.`,
        details: { composeServiceName: error.composeServiceName },
      }
    case 'site_managed_directory_unowned':
      return {
        code: 'site_managed_directory_unowned',
        message: `Site "${error.composeServiceName}" serves an uploaded directory but has no project principal to own it.`,
        details: { composeServiceName: error.composeServiceName },
      }
    case 'site_cron_unowned':
      return {
        code: 'site_cron_unowned',
        message: `Site "${error.composeServiceName}" has scheduled jobs but no project principal to run them as.`,
        details: { composeServiceName: error.composeServiceName },
      }
    case 'source_principal_ambiguous':
      return {
        code: 'source_principal_ambiguous',
        message: `Git-backed service "${error.composeServiceName}" has more than one project principal assigned.`,
        details: { composeServiceName: error.composeServiceName },
      }
    case 'binding_endpoint_unavailable':
      return {
        code: 'binding_endpoint_unavailable',
        message: 'A service binding could not resolve a ProxySQL listener for its managed cluster.',
      }
    case 'principal_alias_unknown':
      return {
        code: 'principal_alias_unknown',
        message: `Service "${error.composeServiceName}" names principal "${error.alias}", which this document's x-turbopanel.principals does not declare.`,
        details: {
          composeServiceName: error.composeServiceName,
          alias: error.alias,
        },
      }
    case 'principal_required_for_service_kind':
      return {
        code: 'principal_required_for_service_kind',
        message: `${error.serviceKind} service "${error.composeServiceName}" has no principal — declare one under x-turbopanel.principals and name it with x-turbopanel.principal.`,
        details: {
          composeServiceName: error.composeServiceName,
          serviceKind: error.serviceKind,
        },
      }
  }
}

type DaemonSealContext = {
  secretsConfig: SecretsConfig
  dataEncryptionSecrets: DerivedSecretsConfig
  recipient: { serverId: string; keyId: string }
}

/**
 * What sealing a stored secret for one server's daemon needs, or the refusal
 * the deploy answers with (`503` no encryption key, `422` no active daemon key).
 */
async function resolveDaemonSealContext(
  c: Context<AppEnv>,
  db: Db,
  serverId: string
): Promise<DaemonSealContext | Response> {
  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  const secretsConfig = c.get('secretsConfig')
  if (!dataEncryptionSecrets || !secretsConfig) {
    return Response.json(
      {
        error: 'Encryption unavailable — no encryption key configured',
      },
      { status: 503 }
    )
  }

  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return Response.json(
      {
        error: 'No encryption-capable daemon key on target server',
      },
      { status: 422 }
    )
  }
  return {
    secretsConfig,
    dataEncryptionSecrets,
    recipient: { serverId, keyId: daemonState.key.id },
  }
}

async function sealVariableMaterialForDaemon(
  c: Context<AppEnv>,
  db: Db,
  serverId: string,
  material: DeployVariableMaterial[]
): Promise<EnvironmentDeployVariableMaterial[] | Response> {
  if (material.length === 0) return []

  const sealing = await resolveDaemonSealContext(c, db, serverId)
  if (sealing instanceof Response) return sealing
  const { secretsConfig, dataEncryptionSecrets, recipient } = sealing
  // Pure crypto per entry (no DB, no shared state): seal them concurrently.
  return await Promise.all(
    material.map(async (entry) => {
      let envelope = entry.valueEnvelope
      if (!isDaemonSealedEnvelope(envelope)) {
        if (isSealedEnvelope(envelope)) {
          envelope = await resealSecretForDaemon(
            secretsConfig,
            dataEncryptionSecrets,
            recipient,
            envelope
          )
        } else {
          envelope = await encryptSecretForDaemon(secretsConfig, recipient, envelope)
        }
      }
      return {
        key: entry.key,
        composeServiceName: entry.composeServiceName,
        forBuild: entry.forBuild,
        forRuntime: entry.forRuntime,
        isLiteral: entry.isLiteral,
        valueEnvelope: envelope,
      }
    })
  )
}

/**
 * Secret runtime variables of a site's hostings, resealed for the daemon.
 *
 * `hosting-web-env` hands them over still sealed under the control plane's own
 * key (`tpsecret`), so a plaintext never exists on this path; here each is
 * resealed for the target daemon, which decrypts it on the host. A deploy with
 * no secret site variable needs no daemon key and is returned as is.
 */
export async function sealHostingWebSecretsForDaemon(
  c: Context<AppEnv>,
  db: Db,
  serverId: string,
  hostings: DeployHostingPayload[]
): Promise<DeployHostingPayload[] | Response> {
  if (!hostings.some((entry) => entry.web?.secretEnv !== undefined)) {
    return hostings
  }

  const sealing = await resolveDaemonSealContext(c, db, serverId)
  if (sealing instanceof Response) return sealing
  const { secretsConfig, dataEncryptionSecrets, recipient } = sealing
  return await Promise.all(
    hostings.map(async (entry) => {
      const secretEnv = entry.web?.secretEnv
      if (!entry.web || secretEnv === undefined) return entry
      const names = Object.keys(secretEnv)
      const envelopes = await Promise.all(
        names.map((name) =>
          resealSecretForDaemon(secretsConfig, dataEncryptionSecrets, recipient, secretEnv[name]!)
        )
      )
      return {
        ...entry,
        web: {
          ...entry.web,
          secretEnv: Object.fromEntries(names.map((n, i) => [n, envelopes[i]!])),
        },
      }
    })
  )
}

function readPinnedDockerVolumeName(metadata: unknown): string | null {
  if (!isPlainObject(metadata)) return null
  if (typeof metadata.dockerVolumeName !== 'string') return null
  return metadata.dockerVolumeName.length > 0 ? metadata.dockerVolumeName : null
}

function readLocationFlags(options: unknown): {
  managed?: boolean
  externalName?: string
} {
  if (!isPlainObject(options)) return {}
  const flags: { managed?: boolean; externalName?: string } = {}
  if (options.managed === true || options.managed === false) {
    flags.managed = options.managed
  }
  if (typeof options.externalName === 'string' && options.externalName.length > 0) {
    flags.externalName = options.externalName
  }
  return flags
}

function locationUsableOnServer(locationServerId: string | null, serverId: string): boolean {
  return locationServerId === null || locationServerId === serverId
}

type LocationJoinRow = {
  storageId: string
  locationId: string
  kind: string
  name: string
  accessMode: string
  principalId: string | null
  principalUsername: string | null
  contentEnvelope: string | null
  locationServerId: string | null
  provider: string
  role: string
  path: string | null
  locationOptions: unknown
  metadata: unknown
}

type MountJoinRow = {
  storageId: string
  serviceId: string
  composeServiceName: string
  destinationPath: string
  subpath: string | null
  readOnly: boolean
}

function isDeployStorageKind(kind: string): kind is EnvironmentDeployStorageMaterial['kind'] {
  return kind === 'volume' || kind === 'directory' || kind === 'file'
}

function isDeployStorageProvider(
  provider: string
): provider is EnvironmentDeployStorageMaterial['provider'] {
  return provider === 'docker' || provider === 'path'
}

function resolvePathLocationSource(row: LocationJoinRow): string | undefined {
  if (row.provider !== 'path') return undefined
  if (typeof row.path === 'string' && row.path.length > 0) return row.path
  if (
    typeof row.principalId !== 'string' ||
    row.principalId.length === 0 ||
    typeof row.principalUsername !== 'string' ||
    row.principalUsername.length === 0
  ) {
    return undefined
  }
  return principalVolumePath(row.principalUsername, row.storageId)
}

function expandMountsForClones(
  mounts: MountJoinRow[],
  cloneNamesByServiceId: Map<string, string[]>
): EnvironmentDeployStorageMount[] {
  const expanded: EnvironmentDeployStorageMount[] = []
  for (const row of mounts) {
    const clones = cloneNamesByServiceId.get(row.serviceId)
    const names = clones && clones.length > 0 ? clones : [row.composeServiceName]
    for (const composeServiceName of names) {
      const mountEntry: EnvironmentDeployStorageMount = {
        serviceId: row.serviceId,
        composeServiceName,
        destinationPath: row.destinationPath,
      }
      if (typeof row.subpath === 'string' && row.subpath.length > 0) {
        mountEntry.subpath = row.subpath
      }
      if (row.readOnly) mountEntry.readOnly = true
      expanded.push(mountEntry)
    }
  }
  return expanded
}

function toStorageMaterialEntry(
  row: LocationJoinRow,
  serverId: string,
  mounts: EnvironmentDeployStorageMount[]
): EnvironmentDeployStorageMaterial | null {
  if (!isDeployStorageKind(row.kind) || !isDeployStorageProvider(row.provider)) {
    return null
  }
  const flags = readLocationFlags(row.locationOptions)
  const entry: EnvironmentDeployStorageMaterial = {
    storageId: row.storageId,
    locationId: row.locationId,
    kind: row.kind,
    name: row.name,
    provider: row.provider,
    serverId,
    mounts,
  }
  const sourcePath = resolvePathLocationSource(row)
  if (sourcePath) entry.sourcePath = sourcePath
  if (row.principalId) entry.principalId = row.principalId
  if (row.contentEnvelope) entry.contentEnvelope = row.contentEnvelope
  if (row.provider === 'docker') {
    entry.volumeName = resolveDockerVolumeName({
      storageId: row.storageId,
      pinnedName: readPinnedDockerVolumeName(row.metadata),
    })
  }
  if (flags.managed !== undefined) entry.managed = flags.managed
  if (flags.externalName) entry.externalName = flags.externalName
  return entry
}

function appendUnseenRegisteredVolumes(
  material: EnvironmentDeployStorageMaterial[],
  seenStorageIds: ReadonlySet<string>,
  registeredVolumes: readonly RegisteredComposeVolume[],
  serverId: string
): void {
  for (const registered of registeredVolumes) {
    if (seenStorageIds.has(registered.storageId)) continue
    material.push({
      storageId: registered.storageId,
      locationId: registered.locationId,
      kind: 'volume',
      name: registered.composeKey,
      provider: 'docker',
      serverId,
      volumeName: registered.volumeName,
      managed: registered.managed,
      mounts: [],
    })
  }
}

export async function loadStorageMaterial(
  db: Db,
  params: {
    environmentId: string
    projectId: string
    organizationId: string
    serverId: string
    serviceIds: string[]
    /** Origin service id → clone compose keys (for service-scoped fan-out). */
    cloneNamesByServiceId: Map<string, string[]>
    registeredVolumes: readonly RegisteredComposeVolume[]
  }
): Promise<EnvironmentDeployStorageMaterial[]> {
  const scopeConditions = [
    eq(storage.environmentId, params.environmentId),
    eq(storage.projectId, params.projectId),
  ]
  if (params.serviceIds.length > 0) {
    scopeConditions.push(inArray(storage.serviceId, params.serviceIds))
  }

  const locationRows = await db
    .select({
      storageId: storage.id,
      locationId: storageCopy.id,
      kind: storage.kind,
      name: storage.name,
      accessMode: storage.accessMode,
      principalId: storage.principalId,
      // Applied login — volume paths live under /srv/users/<applied>/volumes.
      principalUsername: principal.appliedUsername,
      contentEnvelope: storage.contentEnvelope,
      locationServerId: storageCopy.serverId,
      provider: storageCopy.provider,
      role: storageCopy.role,
      path: storageCopy.path,
      locationOptions: storageCopy.options,
      metadata: storage.metadata,
    })
    .from(storage)
    .innerJoin(storageCopy, eq(storageCopy.storageId, storage.id))
    .leftJoin(principal, eq(storage.principalId, principal.id))
    .where(or(...scopeConditions))

  const usable = locationRows.filter(
    (row) => row.role !== 'scratch' && locationUsableOnServer(row.locationServerId, params.serverId)
  )
  const usableStorageIds = [...new Set(usable.map((row) => row.storageId))]

  const mountRows: MountJoinRow[] =
    usableStorageIds.length === 0
      ? []
      : await db
          .select({
            storageId: mount.storageId,
            serviceId: mount.serviceId,
            composeServiceName: service.composeServiceName,
            destinationPath: mount.destinationPath,
            subpath: mount.subpath,
            readOnly: mount.isReadOnly,
          })
          .from(mount)
          .innerJoin(service, eq(mount.serviceId, service.id))
          .where(inArray(mount.storageId, usableStorageIds))

  const mountsByStorage = new Map<string, MountJoinRow[]>()
  for (const row of mountRows) {
    const list = mountsByStorage.get(row.storageId) ?? []
    list.push(row)
    mountsByStorage.set(row.storageId, list)
  }

  const material: EnvironmentDeployStorageMaterial[] = []
  const seenStorageIds = new Set<string>()

  for (const row of usable) {
    seenStorageIds.add(row.storageId)
    const mounts = expandMountsForClones(
      mountsByStorage.get(row.storageId) ?? [],
      params.cloneNamesByServiceId
    )
    const entry = toStorageMaterialEntry(row, params.serverId, mounts)
    if (entry) material.push(entry)
  }

  appendUnseenRegisteredVolumes(material, seenStorageIds, params.registeredVolumes, params.serverId)
  return material
}

export async function findUnavailableStorageCopy(
  db: Db,
  params: {
    environmentId: string
    scheduledServerId: string
    serviceIds: string[]
  }
): Promise<Extract<DeployPrepareError, { kind: 'storage_location_unavailable' }> | null> {
  if (params.serviceIds.length === 0) return null

  const rows = await db
    .select({
      storageId: storage.id,
      storageName: storage.name,
      accessMode: storage.accessMode,
      serviceId: mount.serviceId,
      locationServerId: storageCopy.serverId,
      locationRole: storageCopy.role,
    })
    .from(mount)
    .innerJoin(storage, eq(mount.storageId, storage.id))
    .leftJoin(storageCopy, eq(storageCopy.storageId, storage.id))
    .where(
      and(
        eq(storage.environmentId, params.environmentId),
        inArray(mount.serviceId, params.serviceIds)
      )
    )

  type Acc = {
    storageName: string
    accessMode: string
    serviceId: string
    primaryServerId: string | null
    usable: boolean
  }
  const byStorage = new Map<string, Acc>()
  for (const row of rows) {
    let acc = byStorage.get(row.storageId)
    if (!acc) {
      acc = {
        storageName: row.storageName,
        accessMode: row.accessMode,
        serviceId: row.serviceId,
        primaryServerId: null,
        usable: false,
      }
      byStorage.set(row.storageId, acc)
    }
    if (row.locationRole === 'primary' && row.locationServerId) {
      acc.primaryServerId = row.locationServerId
    }
    if (
      row.locationRole !== 'scratch' &&
      locationUsableOnServer(row.locationServerId, params.scheduledServerId)
    ) {
      acc.usable = true
    }
  }

  for (const [storageId, acc] of byStorage) {
    if (acc.usable) continue
    return {
      kind: 'storage_location_unavailable',
      storageId,
      storageName: acc.storageName,
      accessMode: acc.accessMode,
      primaryServerId: acc.primaryServerId,
      scheduledServerId: params.scheduledServerId,
      serviceId: acc.serviceId,
    }
  }
  return null
}

async function sealStorageMaterialForDaemon(
  c: Context<AppEnv>,
  db: Db,
  serverId: string,
  material: EnvironmentDeployStorageMaterial[]
): Promise<EnvironmentDeployStorageMaterial[] | Response> {
  if (material.length === 0) return []

  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  const secretsConfig = c.get('secretsConfig')
  const needsReseal = material.some((entry) =>
    entry.contentEnvelope?.startsWith(`${ENVELOPE_MAGIC}.`)
  )
  if (!needsReseal) return material

  if (!dataEncryptionSecrets || !secretsConfig) {
    return Response.json(
      {
        error: 'Encryption unavailable — no encryption key configured',
      },
      { status: 503 }
    )
  }

  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return Response.json(
      {
        error: 'No encryption-capable daemon key on target server',
      },
      { status: 422 }
    )
  }
  const keyId = daemonState.key.id

  // Pure crypto per entry (no DB, no shared state): reseal them concurrently.
  return await Promise.all(
    material.map(async (entry) => {
      let contentEnvelope = entry.contentEnvelope
      if (contentEnvelope?.startsWith(`${ENVELOPE_MAGIC}.`)) {
        contentEnvelope = await resealSecretForDaemon(
          secretsConfig,
          dataEncryptionSecrets,
          { serverId, keyId },
          contentEnvelope
        )
      }
      return {
        ...entry,
        ...(contentEnvelope ? { contentEnvelope } : {}),
      }
    })
  )
}

export async function loadPrincipalMaterial(
  db: Db,
  principalIds: string[]
): Promise<EnvironmentDeployPrincipalMaterial[]> {
  if (principalIds.length === 0) return []

  const uniqueIds = [...new Set(principalIds)]
  const rows = await db
    .select({
      id: principal.id,
      // Applied login — the Linux account name (`useradd`, home, keys, slice)
      // is the applied username; the short `username` is panel-internal.
      username: principal.appliedUsername,
      options: principal.options,
      password: principal.password,
    })
    .from(principal)
    .where(inArray(principal.id, uniqueIds))

  // Always present for every id asked about, so `[]` genuinely means "this
  // account holds no keys" rather than "we did not look".
  const sshKeys = await loadSshKeysByPrincipalIds(db, uniqueIds)

  const material: EnvironmentDeployPrincipalMaterial[] = []
  for (const row of rows) {
    const options = parsePrincipalOptions(row.options)
    const override = resolvePrincipalIdOverride(options)
    const shell = resolvePrincipalShell(options)
    const keys = sshKeys.get(row.id) ?? []
    // Password sign-in is on exactly when the row holds a crypt hash. The
    // format gate matters: for a server principal the column only ever holds
    // a sha512-crypt hash, but anything else (or a value from before this
    // gate) must not be forwarded to `chpasswd -e` on a host.
    const passwordHash =
      typeof row.password === 'string' && SHA512_CRYPT_HASH_RE.test(row.password)
        ? row.password
        : undefined
    // naming.ts is the single source of truth for home; metadata.home is a
    // mirror for display only.
    material.push({
      principalId: row.id,
      username: row.username,
      home: principalHomeDir(row.username),
      shell,
      // The effective set, decided here: an account with no credential at all
      // gets no access group whatever its shell says, because there would be
      // nothing for it to authenticate with. See `lib/principal-access.ts`.
      accessGroups: [...accessGroupsFor(shell, keys.length, passwordHash !== undefined)],
      sshKeys: keys,
      ...(passwordHash === undefined ? {} : { passwordHash }),
      ...(override ? { uid: override.uid, gid: override.gid } : {}),
    })
  }
  return material
}

/**
 * Resolve the two raw project/environment compose layers (no prepare
 * transforms). `environmentFilename` is the overlay's wire basename.
 */
export function resolveProjectEnvironmentComposeLayers(
  projectOptions: unknown,
  environmentOptions: unknown,
  environmentFilename: string
): ComposeLayer[] | Response {
  // One chain builder for every caller; this keeps only the Response mapping.
  const chain = resolveComposeLayerChain({
    projectOptions,
    environmentOptions,
    environmentFilename,
  })
  if (isComposeChainError(chain)) {
    return Response.json(
      { error: 'Invalid compose document' },
      {
        status: 400,
      }
    )
  }
  return chain
}

export function mergeProjectEnvironmentCompose(
  projectOptions: unknown,
  environmentOptions: unknown
): ComposeDocument | Response {
  // Filename is unused by mergeComposeLayers (document fold only); use a
  // placeholder that cannot collide with the project basename.
  const layers = resolveProjectEnvironmentComposeLayers(
    projectOptions,
    environmentOptions,
    'docker-compose.environment.yml'
  )
  if (layers instanceof Response) return layers
  return mergeComposeLayers(layers)
}

function evaluateHealthCheckGates(
  merged: ComposeDocument,
  optionsByComposeName: ReturnType<typeof buildServiceOptionsMap>,
  acknowledgeHealthCheckWarnings: boolean | undefined
): Extract<DeployPrepareError, { kind: 'health_check' }> | null {
  const healthWarnings = collectHealthCheckWarnings(merged, optionsByComposeName)
  const requiredMissing = healthWarnings.filter((w) => w.policy === 'required')
  if (requiredMissing.length > 0) {
    return {
      kind: 'health_check',
      required: true,
      services: requiredMissing.map((w) => w.composeServiceName),
    }
  }
  const warnMissing = healthWarnings.filter((w) => w.policy === 'warn')
  if (warnMissing.length > 0 && !acknowledgeHealthCheckWarnings) {
    return {
      kind: 'health_check',
      required: false,
      services: warnMissing.map((w) => w.composeServiceName),
    }
  }
  return null
}

async function mapResolvedVariablesToDeployEntries(
  map: ResolvedVariableMap,
  dataEncryptionSecrets: Parameters<typeof decryptSecret>[0] | undefined
): Promise<DeployVariableEntry[]> {
  // Pure crypto per entry (no DB, no shared state): decrypt concurrently;
  // Promise.all keeps the map's iteration order.
  return await Promise.all(
    [...map].map(async ([key, entry]) => {
      let value = entry.value
      if (entry.isSecret && dataEncryptionSecrets) {
        value = await decryptSecret(dataEncryptionSecrets, entry.value)
      }
      return {
        key,
        value,
        isSecret: entry.isSecret,
        isLiteral: entry.isLiteral,
        forBuild: entry.forBuild,
        forRuntime: entry.forRuntime,
        ...(entry.bindingId ? { bindingId: entry.bindingId } : {}),
      }
    })
  )
}

/** Label each effective entry with the scope that set it (see {@link resolveVariableSource}). */
function tagVariableSources(
  entries: readonly DeployVariableEntry[],
  scopes: ResolvedVariableScopes
): DeployVariableEntry[] {
  return entries.map((entry) => {
    const source = resolveVariableSource(entry.key, entry.bindingId, scopes)
    return source === undefined ? entry : { ...entry, source }
  })
}

type ServiceRow = {
  id: string
  composeServiceName: string
  options: unknown
}

async function resolveDeployVariableBuckets(
  db: Db,
  params: {
    environmentId: string
    serverId: string
    composeServiceNames: readonly string[]
    /** Clone compose key → origin service row (same row for every clone). */
    serviceRowByComposeName: Map<string, ServiceRow>
    dataEncryptionSecrets: Parameters<typeof mapResolvedVariablesToDeployEntries>[1]
  }
): Promise<{
  globalEntries: DeployVariableEntry[]
  perServiceEntries: Map<string, DeployVariableEntry[]>
  perServiceScopes: Map<string, VariableScopeEntryMap>
}> {
  const envVars = await resolveInheritedVariablesForEnvironment(db, params.environmentId)
  const serverVars = await resolveServerScopedVariables(db, params.serverId)
  const fallbackGlobal = new Map([...envVars, ...serverVars])
  const fallbackEntries = await mapResolvedVariablesToDeployEntries(
    fallbackGlobal,
    params.dataEncryptionSecrets
  )
  const serverScopeEntries = await mapResolvedVariablesToDeployEntries(
    serverVars,
    params.dataEncryptionSecrets
  )
  const serverScopeMap = new Map(
    serverScopeEntries.map((entry) => [entry.key, { ...entry, source: 'server' }])
  )

  const composeServices = params.composeServiceNames
  const globalEntries: DeployVariableEntry[] = composeServices.length === 0 ? fallbackEntries : []
  const perServiceEntries = new Map<string, DeployVariableEntry[]>()
  const perServiceScopes = new Map<string, VariableScopeEntryMap>()

  if (composeServices.length === 0) {
    return { globalEntries, perServiceEntries, perServiceScopes }
  }
  if (params.serviceRowByComposeName.size === 0) {
    globalEntries.push(...fallbackEntries)
    return { globalEntries, perServiceEntries, perServiceScopes }
  }

  const userEntriesByServiceId = new Map<string, DeployVariableEntry[]>()
  const scopesByServiceId = new Map<string, VariableScopeEntryMap>()

  await forEachSequential(composeServices, async (composeServiceName) => {
    const row = params.serviceRowByComposeName.get(composeServiceName)
    let userEntries: DeployVariableEntry[]
    let scopes: VariableScopeEntryMap
    if (row) {
      let cached = userEntriesByServiceId.get(row.id)
      let cachedScopes = scopesByServiceId.get(row.id)
      if (!cached || !cachedScopes) {
        const bundle = await resolveInheritedVariableBundleForService(db, row.id)
        const hostingMap = await mergeHostingVariablesForService(db, row.id, bundle.inherited)
        await reapplyBindingOwnedVariables(db, row.id, bundle.inherited)
        const mergedServer = new Map([...bundle.inherited, ...serverVars])
        const scopeMaps: ResolvedVariableScopes = {
          ...bundle.scopes,
          hosting: hostingMap,
          server: serverVars,
        }
        cached = tagVariableSources(
          await mapResolvedVariablesToDeployEntries(mergedServer, params.dataEncryptionSecrets),
          scopeMaps
        )
        cachedScopes = await mapResolvedScopesToDeployEntries(
          scopeMaps,
          params.dataEncryptionSecrets
        )
        cachedScopes.server = serverScopeMap
        userEntriesByServiceId.set(row.id, cached)
        scopesByServiceId.set(row.id, cachedScopes)
      }
      userEntries = cached
      scopes = cachedScopes
    } else {
      userEntries = fallbackEntries
      scopes = { server: serverScopeMap }
    }
    perServiceEntries.set(composeServiceName, userEntries)
    perServiceScopes.set(composeServiceName, scopes)
  })
  return { globalEntries, perServiceEntries, perServiceScopes }
}

async function mapResolvedScopesToDeployEntries(
  scopes: ResolvedVariableScopes,
  dataEncryptionSecrets: Parameters<typeof mapResolvedVariablesToDeployEntries>[1]
): Promise<VariableScopeEntryMap> {
  const out: VariableScopeEntryMap = {}
  // Pure crypto per scope (no DB, no shared state): decrypt scopes
  // concurrently, then fill `out` in scope order.
  const decrypted = await Promise.all(
    Object.entries(scopes).map(async ([scope, map]) => {
      if (!map) return undefined
      const entries = await mapResolvedVariablesToDeployEntries(map, dataEncryptionSecrets)
      return [scope, entries] as const
    })
  )
  for (const item of decrypted) {
    if (!item) continue
    const [scope, entries] = item
    // A `{$project.KEY}` reference reads from here, so the entry carries the
    // scope it was found in (the list people read says where a value came from).
    out[scope as keyof VariableScopeEntryMap] = new Map(
      entries.map((entry) => [entry.key, { ...entry, source: scope }])
    )
  }
  return out
}

/** `{ variables }` for the wire, or nothing when the app has none (its payload stays as it was). */
function nativeAppVariablesField(resolved: NativeAppVariables | undefined): {
  variables?: NativeAppVariables['variables']
} {
  return resolved && resolved.variables.length > 0 ? { variables: resolved.variables } : {}
}

/**
 * What each native app's process gets, from what the variables module recorded
 * for it (see {@link buildNativeAppVariables}).
 */
function resolveNativeAppVariables(
  apps: readonly NativeAppServiceSpec[],
  applied: Pick<ApplyVariablesResult, 'runtimeAssignments' | 'unreferencedSecrets'>
): Map<string, NativeAppVariables> {
  return new Map(
    apps.map((app) => [
      app.composeServiceName,
      buildNativeAppVariables(
        applied.runtimeAssignments.get(app.composeServiceName) ?? [],
        app,
        applied.unreferencedSecrets.get(app.composeServiceName) ?? []
      ),
    ])
  )
}

/** The lists people read, for the native apps that run on this server. */
function nativeAppVariableViews(
  apps: readonly { composeServiceName: string }[],
  variables: ReadonlyMap<string, NativeAppVariables>
): NativeAppVariablesView[] {
  return apps.map((app) => ({
    composeServiceName: app.composeServiceName,
    variables: variables.get(app.composeServiceName)?.view ?? [],
  }))
}

/** Compose keys of the services that run as native (`serviceKind: node`) apps. */
function nativeComposeServiceNames(document: ComposeDocument): Set<string> {
  const services = isPlainObject(document.data.services)
    ? (document.data.services as Record<string, unknown>)
    : {}
  return new Set(
    Object.entries(services)
      .filter(([, raw]) => isPlainObject(raw) && isNodeComposeService(raw))
      .map(([name]) => name)
  )
}

function listContainerComposeNames(document: ComposeDocument): Set<string> {
  const services = isPlainObject(document.data.services)
    ? (document.data.services as Record<string, unknown>)
    : {}
  const names = new Set<string>()
  for (const [name, raw] of Object.entries(services)) {
    if (!isPlainObject(raw)) {
      names.add(name)
      continue
    }
    // Host-native kinds never become containers, so they must not claim a
    // container allocation, a replica count, or a container_name.
    if (isSiteComposeService(raw) || isNodeComposeService(raw)) {
      continue
    }
    names.add(name)
  }
  return names
}

function buildExpandedServiceOptionsMap(
  serviceRows: ServiceRow[],
  expansion: Map<string, string[]>,
  deployHooks = false
): ServiceOptionsByComposeName {
  // Hook commands survive the read only when the organization enabled them.
  const originOptions = buildServiceOptionsMap(serviceRows, { deployHooks })
  const map: ServiceOptionsByComposeName = new Map()

  for (const [originName, clones] of expansion) {
    const origin = originOptions.get(originName) ?? {}
    for (const cloneName of clones) {
      map.set(cloneName, { ...origin })
    }
  }
  return map
}

/**
 * Narrow the clamped service options to the part the resolved stage carries.
 *
 * `ServiceOptions` is the whole stored record — naming, health-check
 * acknowledgement, hooks — while {@link ResolvedResources} is only the
 * *effective ceiling*, which is the one answer downstream steps ask the
 * resolved stage for. Called before compile, where `expansion` is still the
 * identity map, so these keys are the authored compose keys the `service` rows
 * carry and line up one-to-one with {@link ResolvedService.composeServiceName}.
 */
function resolvedResourcesByComposeName(
  optionsByComposeName: ServiceOptionsByComposeName
): Map<string, ResolvedResources> {
  const map = new Map<string, ResolvedResources>()
  for (const [composeServiceName, options] of optionsByComposeName) {
    if (options.resources) map.set(composeServiceName, options.resources)
  }
  return map
}

/** Build clone compose name → allocated container_name map for apply-service-options. */
function buildContainerNameByComposeName(
  allocations: readonly ContainerAllocation[],
  localCounts: ReadonlyMap<string, number> | undefined,
  localServerId: string | undefined
): Map<string, string> {
  const map = new Map<string, string>()
  for (const row of allocations) {
    const count = localCounts?.get(row.composeServiceName) ?? row.instances
    if (count > 1) continue
    if (localServerId && row.serverId !== localServerId) continue
    map.set(row.cloneComposeServiceName, row.containerName)
  }
  return map
}

/**
 * Drop reserved `TURBOPANEL_*` keys from user variables. The platform no longer
 * auto-injects identity variables into prepared compose; the keys stay reserved
 * for a future opt-in variable feature.
 */
function stripReservedKeysFromEntries(
  perServiceEntries: Map<string, DeployVariableEntry[]>
): Map<string, DeployVariableEntry[]> {
  const next = new Map<string, DeployVariableEntry[]>()
  for (const [cloneName, userEntries] of perServiceEntries) {
    next.set(cloneName, stripReservedDeployVariableKeys(userEntries))
  }
  return next
}

function expansionToRecord(expansion: Map<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [key, value] of expansion) {
    out[key] = value
  }
  return out
}

function buildCloneNamesByServiceId(
  serviceRows: ServiceRow[],
  expansion: Map<string, string[]>
): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const row of serviceRows) {
    map.set(row.id, expansion.get(row.composeServiceName) ?? [row.composeServiceName])
  }
  return map
}

/** Soft prepare errors that preview can absorb into `warnings`. */
type SoftDeployPrepareError = Exclude<DeployPrepareError, HardDeployPrepareError>

function absorbSoftPrepareError(
  mode: DeployPrepareMode,
  warnings: DeployPrepareWarning[],
  error: SoftDeployPrepareError | null | undefined
): SoftDeployPrepareError | null {
  if (!error) return null
  if (mode === 'preview') {
    warnings.push(warningFromPrepareError(error))
    return null
  }
  return error
}

/** Merged `services:` mapping, or `{}` when the document has none. */
function composeServicesRecord(document: ComposeDocument): Record<string, unknown> {
  if (!isPlainObject(document.data.services)) return {}
  return document.data.services as Record<string, unknown>
}

function listComposeServiceKeys(document: ComposeDocument): string[] {
  if (!isPlainObject(document.data.services)) return []
  return Object.keys(document.data.services as Record<string, unknown>)
}

async function emptyComposePrepareResult(
  mode: DeployPrepareMode
): Promise<PreparedDeployCompose | DeployPrepareError> {
  if (mode === 'preview') {
    return await emptyPreparedCompose([warningFromPrepareError({ kind: 'empty_compose' })])
  }
  return { kind: 'empty_compose' }
}

function buildInstancesByComposeName(
  composeServiceNames: readonly string[],
  containerServices: ReturnType<typeof buildContainerServiceSpecs>,
  serviceRows: ServiceRow[]
): Map<string, number> {
  const instancesByComposeName = new Map<string, number>()
  for (const spec of containerServices) {
    instancesByComposeName.set(spec.composeServiceName, spec.instances)
  }
  // A site keeps count 1 (expansion skips them regardless).
  for (const name of composeServiceNames) {
    if (instancesByComposeName.has(name)) continue
    const row = serviceRows.find((serviceRow) => serviceRow.composeServiceName === name)
    instancesByComposeName.set(
      name,
      resolveServiceInstances(parseServiceOptions(row?.options) ?? {})
    )
  }
  return instancesByComposeName
}

function buildServiceRowByCloneName(
  serviceRows: ServiceRow[],
  expansion: Map<string, string[]>
): Map<string, ServiceRow> {
  const serviceRowByCloneName = new Map<string, ServiceRow>()
  for (const row of serviceRows) {
    for (const cloneName of expansion.get(row.composeServiceName) ?? [row.composeServiceName]) {
      serviceRowByCloneName.set(cloneName, row)
    }
  }
  return serviceRowByCloneName
}

/**
 * Service ids (within this environment) that own at least one active binding,
 * split by whether the ProxySQL listener a binding resolves to is co-resident
 * with `serverId` (the placement rule `resolveBindingEndpoint` uses: the
 * consuming service's environment pin, else its project default).
 *
 * Co-residency is tracked per binding rather than per compose service: a
 * service holding one binding served by a remote listener and another served
 * by this host's ProxySQL needs both `extra_hosts` **and** the organization's
 * managed network.
 */
async function loadServiceIdsWithBindings(
  db: Db,
  serviceIds: readonly string[],
  serverId: string
): Promise<{ bound: Set<string>; coResident: Set<string> }> {
  const bound = new Set<string>()
  const coResident = new Set<string>()
  if (serviceIds.length === 0) return { bound, coResident }
  const rows = await db
    .select({
      serviceId: binding.serviceId,
      environmentServerId: environment.serverId,
      projectOptions: project.options,
    })
    .from(binding)
    .innerJoin(service, eq(binding.serviceId, service.id))
    .innerJoin(environment, eq(service.environmentId, environment.id))
    .innerJoin(project, eq(environment.projectId, project.id))
    .where(inArray(binding.serviceId, [...serviceIds]))
  for (const row of rows) {
    bound.add(row.serviceId)
    const listener = resolveEffectivePlacementServerId(
      row.environmentServerId,
      parseProjectOptions(row.projectOptions)
    )
    if (listener === serverId) coResident.add(row.serviceId)
  }
  return { bound, coResident }
}

/**
 * Compose service names (post multi-instance expansion) that consume a
 * managed-database binding and therefore must join the server-owner
 * organization's managed Docker network so their resolved binding endpoint
 * (a ProxySQL container name) is dial-able — see
 * `resolveBindingEndpoint` in `../bindings/resolve-endpoint.ts`.
 */
async function resolveManagedNetworkComposeServiceNames(
  db: Db,
  serviceRows: ServiceRow[],
  expansion: Map<string, string[]>,
  serverId: string
): Promise<{ bound: string[]; coResident: Set<string> }> {
  const boundServiceIds = await loadServiceIdsWithBindings(
    db,
    serviceRows.map((row) => row.id),
    serverId
  )
  if (boundServiceIds.bound.size === 0) {
    return { bound: [], coResident: new Set() }
  }

  const names = new Set<string>()
  const coResident = new Set<string>()
  for (const row of serviceRows) {
    if (!boundServiceIds.bound.has(row.id)) continue
    for (const cloneName of expansion.get(row.composeServiceName) ?? [row.composeServiceName]) {
      names.add(cloneName)
      if (boundServiceIds.coResident.has(row.id)) coResident.add(cloneName)
    }
  }
  return {
    bound: [...names].sort((a, b) => a.localeCompare(b)),
    coResident,
  }
}

/**
 * Bound compose services that should join this server's local ProxySQL
 * network. Remote extra_hosts must not drop that attachment — neither on a
 * sibling service, nor on the same service when it also holds a binding
 * served by this host's listener (`coResidentNames`), which would otherwise
 * break one of the two sets of connections.
 */
function localManagedNetworkServiceNames(
  boundLogicalNames: readonly string[],
  remoteHostsByService: ReadonlyMap<string, unknown> | undefined,
  coResidentNames?: ReadonlySet<string>
): string[] {
  if (!remoteHostsByService || remoteHostsByService.size === 0) {
    return [...boundLogicalNames]
  }
  return boundLogicalNames.filter(
    (name) => coResidentNames?.has(name) === true || !remoteHostsByService.has(name)
  )
}

/**
 * Effective (most restrictive) org ∩ server ceiling for one account.
 *
 * The per-principal systemd slice is generated from this, so a per-app
 * `CPUQuota` can never add up to more than the account is entitled to. Absent
 * fields stay absent — an unset limit means "no slice directive", not zero.
 */
function effectiveAccountLimits(
  orgOptions: unknown,
  serverOptions: unknown
): EnvironmentDeployNativeAppService['accountLimits'] | undefined {
  const orgLimits =
    parseResourceLimits(isPlainObject(orgOptions) ? orgOptions.resourceLimits : null) ?? {}
  const serverLimits =
    parseResourceLimits(isPlainObject(serverOptions) ? serverOptions.resourceLimits : null) ?? {}
  const pick = (a?: number, b?: number): number | undefined => {
    if (a === undefined) return b
    if (b === undefined) return a
    return Math.min(a, b)
  }
  const cpus = pick(orgLimits.maxCpus, serverLimits.maxCpus)
  const memoryBytes = pick(orgLimits.maxMemoryBytes, serverLimits.maxMemoryBytes)
  if (cpus === undefined && memoryBytes === undefined) return undefined
  return {
    ...(cpus === undefined ? {} : { cpus }),
    ...(memoryBytes === undefined ? {} : { memoryBytes }),
  }
}

/**
 * Attach per-app and per-account resource ceilings to the split native apps.
 *
 * Per-app values are read off {@link ResolvedApplication.services} — the stage
 * whose whole job is to carry the answers the document could not give, the
 * effective ceiling among them. Reading the loose `service.options` map here
 * instead would make the resolved stage a partial projection that later code is
 * free to disagree with; a `node` app and a container service are limited from
 * one source of truth precisely because both read the same resolved entry.
 */
function nativeAppServicesForDeploy(
  apps: readonly NativeAppServiceSpec[],
  resolvedServices: readonly ResolvedService[],
  orgOptions: unknown,
  serverOptions: unknown,
  tasksByComposeName: ReadonlyMap<string, readonly TaskRecord[]> = new Map(),
  variablesByComposeName: ReadonlyMap<string, NativeAppVariables> = new Map()
):
  | PreparedNativeAppService[]
  | Extract<DeployPrepareError, { kind: 'native_app_unresolved_service' }> {
  if (apps.length === 0) return []
  const accountLimits = effectiveAccountLimits(orgOptions, serverOptions)
  const resourcesByComposeName = new Map(
    resolvedServices.map((entry) => [entry.composeServiceName, entry.resources] as const)
  )
  const serviceIdByComposeName = new Map(
    resolvedServices.map((entry) => [entry.composeServiceName, entry.serviceId] as const)
  )
  const out: PreparedNativeAppService[] = []
  for (const app of apps) {
    const turboServiceId = serviceIdByComposeName.get(app.composeServiceName)
    if (!turboServiceId) {
      return {
        kind: 'native_app_unresolved_service',
        composeServiceName: app.composeServiceName,
      }
    }
    out.push(
      nativeAppServiceForDeploy(
        app,
        turboServiceId,
        resourcesByComposeName.get(app.composeServiceName),
        accountLimits,
        renderCronForDeploy(app.cron, tasksByComposeName.get(app.composeServiceName)),
        variablesByComposeName.get(app.composeServiceName)
      )
    )
  }
  return out
}

function resolveLocalNativeAppServicesForDeploy(
  nativeApps: readonly NativeAppServiceSpec[],
  withVariables: Pick<ApplyVariablesResult, 'runtimeAssignments' | 'unreferencedSecrets'>,
  resolvedServices: readonly ResolvedService[],
  orgOptions: unknown,
  serverOptions: unknown,
  tasksByComposeName: ReadonlyMap<string, readonly TaskRecord[]>,
  localServiceNames?: ReadonlySet<string>
):
  | {
      localNativeApps: PreparedNativeAppService[]
      nativeVariables: Map<string, NativeAppVariables>
    }
  | Extract<DeployPrepareError, { kind: 'native_app_unresolved_service' }> {
  const nativeVariables = resolveNativeAppVariables(nativeApps, withVariables)
  const nativeAppsForWire = nativeAppServicesForDeploy(
    nativeApps,
    resolvedServices,
    orgOptions,
    serverOptions,
    tasksByComposeName,
    nativeVariables
  )
  if ('kind' in nativeAppsForWire) return nativeAppsForWire
  return {
    localNativeApps: sitesOnScheduledServer(nativeAppsForWire, localServiceNames),
    nativeVariables,
  }
}

/** The per-app resource ceiling the daemon turns into unit limits, when the app set one. */
function nativeAppResourcesForWire(resources: ResolvedService['resources'] | undefined): {
  resources?: { cpus?: number; memoryBytes?: number }
} {
  const cpus = resources?.cpus
  const memoryBytes = resources?.memoryBytes
  if (cpus === undefined && memoryBytes === undefined) return {}
  return {
    resources: {
      ...(cpus === undefined ? {} : { cpus }),
      ...(memoryBytes === undefined ? {} : { memoryBytes }),
    },
  }
}

/**
 * The runtime and start fields of one app, each only when the app set it, so a
 * Node app's payload carries neither `runtime` nor `denoVersion`.
 */
function nativeAppRuntimeFieldsForWire(app: NativeAppServiceSpec) {
  return {
    ...(app.nodeVersion === undefined ? {} : { nodeVersion: app.nodeVersion }),
    ...(app.runtime === 'deno' ? { runtime: 'deno' as const } : {}),
    ...(app.denoVersion === undefined ? {} : { denoVersion: app.denoVersion }),
    ...(app.appMode === undefined ? {} : { appMode: app.appMode }),
    ...(app.enabled === undefined ? {} : { enabled: app.enabled }),
    ...(app.startupFile === undefined ? {} : { startupFile: app.startupFile }),
  }
}

function nativeAppServiceForDeploy(
  app: NativeAppServiceSpec,
  turboServiceId: string,
  resources: ResolvedService['resources'] | undefined,
  accountLimits: ReturnType<typeof effectiveAccountLimits>,
  cron: ReturnType<typeof renderCronForDeploy>,
  variables: NativeAppVariables | undefined
): PreparedNativeAppService {
  return {
    composeServiceName: app.composeServiceName,
    serviceId: turboServiceId,
    listenPort: app.listenPort,
    framework: app.framework,
    ...nativeAppRuntimeFieldsForWire(app),
    // Plain Compose keys, read off the service body by the native split
    // before the service left the compose document. They ride the payload
    // rather than stopping here: the `node` service is removed from runtime
    // compose entirely, so the generated unit is the only thing left that
    // can honour a restart policy or record service labels.
    ...(app.restartPolicy === undefined ? {} : { restartPolicy: app.restartPolicy }),
    ...(app.serviceLabels === undefined ? {} : { serviceLabels: app.serviceLabels }),
    ...nativeAppResourcesForWire(resources),
    ...(accountLimits === undefined ? {} : { accountLimits }),
    // A node app always runs as the principal that owns its release tree, so
    // unlike a site there is no unowned case to refuse here — the daemon
    // resolves the account from the same binding it builds for the app's own
    // unit. Translation still happens exactly once, in `renderCronForDeploy`.
    ...(cron.length === 0 ? {} : { cron }),
    // The `node` service left the compose document, and with it the
    // `environment:` the variables module built — this list is the only way
    // its variables reach the process.
    ...nativeAppVariablesField(variables),
  }
}

/**
 * Org / server ceiling check, summed off the resolved stage.
 *
 * `serviceCount` still arrives separately: it counts *expanded* compose keys
 * (a service with three instances is three services to a `maxServices` limit),
 * which is a different question from "what did each service ask for" and is not
 * answerable from the resolved service list.
 */
function resourceLimitPrepareError(
  resolvedServices: readonly ResolvedService[],
  serviceCount: number,
  orgOptions: unknown,
  serverOptions: unknown,
  composeServices?: unknown
): SoftDeployPrepareError | null {
  const orgLimits =
    parseResourceLimits(isPlainObject(orgOptions) ? orgOptions.resourceLimits : null) ?? {}
  const serverLimits =
    parseResourceLimits(isPlainObject(serverOptions) ? serverOptions.resourceLimits : null) ?? {}
  const effective = effectiveServiceResources(
    composeServices,
    new Map(resolvedServices.map((entry) => [entry.composeServiceName, entry.resources] as const))
  )
  const usage = sumServiceResourceUsage(
    new Map([...effective].map(([name, resources]) => [name, { resources }] as const)),
    serviceCount
  )
  const violations = checkResourceLimits(usage, orgLimits, serverLimits)
  if (violations.length === 0) return null
  return { kind: 'resource_limit', violations }
}

async function loadDeployEnvAndProject(
  db: Db,
  environmentId: string
): Promise<
  | {
      envRow: {
        id: string
        projectId: string
        options: unknown
        name: string | null
      }
      projectRow: { id: string; options: unknown }
    }
  | Response
> {
  const [envRow] = await db
    .select({
      id: environment.id,
      projectId: environment.projectId,
      options: environment.options,
      name: environment.name,
    })
    .from(environment)
    .where(eq(environment.id, environmentId))
    .limit(1)
  if (!envRow) return Response.json({ error: 'Not found' }, { status: 404 })

  const [projectRow] = await db
    .select({
      id: project.id,
      options: project.options,
    })
    .from(project)
    .where(eq(project.id, envRow.projectId))
    .limit(1)
  if (!projectRow) {
    return Response.json({ error: 'Not found' }, { status: 404 })
  }

  return { envRow, projectRow }
}

type DeployExpandPipeline = {
  containers: ContainerAllocation[]
  ingressServices: EnvironmentDeployIngressService[]
  registeredVolumes: RegisteredComposeVolume[]
  /** composeKey → Docker volume name applied by the merged pipeline. */
  volumeRenames: Map<string, string>
  expandedDocument: ComposeDocument
  expansion: Map<string, string[]>
  expandedServiceNames: string[]
  optionsByComposeName: ServiceOptionsByComposeName
  localReplicaCounts: Map<string, number>
  localServiceNames?: Set<string>
}

async function allocateExpandDeployPipeline(
  db: Db,
  params: {
    environmentId: string
    serverId: string
    organizationId: string
    projectOptions: unknown
    merged: ComposeDocument
    composeServiceNames: readonly string[]
    serviceRows: ServiceRow[]
    schedule?: DeployScheduleSlice
    deployHooks: boolean
  }
): Promise<DeployExpandPipeline> {
  const containerNaming = resolveContainerNaming(parseProjectOptions(params.projectOptions))
  const containerComposeNames = listContainerComposeNames(params.merged)
  const containerServices = applyScheduleToContainerSpecs(
    buildContainerServiceSpecs(
      params.serviceRows,
      containerComposeNames,
      authoredContainerNamesForAllocation(containerNaming, params.merged)
    ),
    params.schedule
  )

  const tcpUdpServices = await resolveTcpUdpIngressServices(db, params.environmentId)
  const ingressServices: EnvironmentDeployIngressService[] = []
  const ingressKeepIds = new Set<string>()
  await forEachSequential(tcpUdpServices, async (svc) => {
    if (!ownsIngressForService(params.schedule, svc.serviceId, params.serverId)) {
      return
    }
    const alloc = await ensureServiceIngressContainerAllocation(db, {
      serviceId: svc.serviceId,
      serverId: params.serverId,
      composeServiceName: svc.composeServiceName,
    })
    ingressKeepIds.add(alloc.containerRowId)
    ingressServices.push({
      serviceId: alloc.serviceId,
      composeServiceName: alloc.composeServiceName,
      containerName: alloc.containerName,
    })
  })

  const containers = await allocateEnvironmentContainers(db, {
    environmentId: params.environmentId,
    serverId: params.serverId,
    containerServices,
    containerNaming,
    environmentServiceIds: params.serviceRows.map((row) => row.id),
    extraKeepIds: ingressKeepIds,
  })

  const registeredVolumes = await registerComposeVolumes(db, {
    document: params.merged,
    organizationId: params.organizationId,
    environmentId: params.environmentId,
    serverId: params.serverId,
  })
  await registerComposeMounts(db, {
    document: params.merged,
    environmentId: params.environmentId,
  })
  const volumeRenames = new Map(registeredVolumes.map((row) => [row.composeKey, row.volumeName]))
  const withRenamedVolumes = renameComposeVolumes(params.merged, volumeRenames)
  const expansion = identityComposeExpansion(params.composeServiceNames)
  const localCounts = params.schedule
    ? localReplicaCounts(params.schedule.slots, params.schedule.serviceIdToName, params.serverId)
    : new Map(containerServices.map((spec) => [spec.composeServiceName, spec.instances]))
  const localNames = params.schedule
    ? localServiceNames(params.schedule.slots, params.schedule.serviceIdToName, params.serverId)
    : undefined

  return {
    containers,
    ingressServices,
    registeredVolumes,
    volumeRenames,
    expandedDocument: withRenamedVolumes,
    expansion,
    expandedServiceNames: listComposeServiceKeys(withRenamedVolumes),
    optionsByComposeName: buildExpandedServiceOptionsMap(
      params.serviceRows,
      expansion,
      params.deployHooks
    ),
    localReplicaCounts: localCounts,
    ...(localNames ? { localServiceNames: localNames } : {}),
  }
}

function documentForServiceOptions(
  _mode: DeployPrepareMode,
  withVariables: { document: ComposeDocument }
): ComposeDocument {
  return withVariables.document
}

async function maybeSealDeployMaterials(
  mode: DeployPrepareMode,
  c: Context<AppEnv>,
  db: Db,
  serverId: string,
  secretMaterial: DeployVariableMaterial[],
  storageMaterialRaw: EnvironmentDeployStorageMaterial[]
): Promise<
  | {
      variableMaterial: EnvironmentDeployVariableMaterial[]
      storageMaterial: EnvironmentDeployStorageMaterial[]
    }
  | Response
> {
  // Preview must not require an online daemon — skip sealing / daemon-key steps.
  if (mode === 'preview') {
    return { variableMaterial: [], storageMaterial: storageMaterialRaw }
  }
  const variableMaterial = await sealVariableMaterialForDaemon(c, db, serverId, secretMaterial)
  if (variableMaterial instanceof Response) return variableMaterial
  const storageMaterial = await sealStorageMaterialForDaemon(c, db, serverId, storageMaterialRaw)
  if (storageMaterial instanceof Response) return storageMaterial
  return { variableMaterial, storageMaterial }
}

type BindingMaterializationOutcome =
  | { kind: 'ok' }
  | { kind: 'warn'; warning: DeployPrepareWarning }
  | { kind: 'error'; error: DeployPrepareError }

/**
 * Apply a classified binding outcome: warnings are collected, an error is
 * handed back for the caller to return. `null` means nothing to report.
 */
function absorbBindingOutcome(
  warnings: DeployPrepareWarning[],
  outcome: BindingMaterializationOutcome
): DeployPrepareError | null {
  if (outcome.kind === 'error') return outcome.error
  if (outcome.kind === 'warn') warnings.push(outcome.warning)
  return null
}

/**
 * Re-materialize service bindings and classify the outcome so the caller
 * stays a flat sequence of early returns / warning pushes.
 */
async function resolveBindingMaterializationOutcome(
  db: Db,
  dataEncryptionSecrets: Parameters<typeof decryptSecret>[0] | undefined,
  serviceIds: string[],
  mode: DeployPrepareMode,
  deliveries?: ReadonlyMap<string, BindingDelivery>
): Promise<BindingMaterializationOutcome> {
  if (!dataEncryptionSecrets) return { kind: 'ok' }

  const bindResult = await materializeBindingsForServices(
    db,
    dataEncryptionSecrets,
    serviceIds,
    deliveries
  )
  if ('ok' in bindResult) return { kind: 'ok' }
  if (bindResult.kind === 'binding_host_site_unsupported') {
    return {
      kind: 'error',
      error: { kind: 'binding_host_site_unsupported', message: bindResult.message },
    }
  }

  const isSoftBindingError =
    bindResult.kind === 'binding_endpoint_unavailable' ||
    bindResult.kind === 'datacenter_ip_required' ||
    bindResult.kind === 'private_path_unavailable' ||
    // `client-backend` never raises this; listed so the mapping over
    // `PrivateEndpointError` stays total.
    bindResult.kind === 'failover_requires_trusted_datacenter'

  const error: DeployPrepareError = { kind: 'binding_endpoint_unavailable' }
  if (isSoftBindingError) {
    return mode === 'preview'
      ? { kind: 'warn', warning: warningFromPrepareError(error) }
      : { kind: 'error', error }
  }

  if (mode !== 'preview') return { kind: 'error', error }

  return {
    kind: 'warn',
    warning: {
      code: 'binding_endpoint_unavailable',
      message: `Binding materialization failed: ${bindResult.kind}`,
    },
  }
}

function resolveSitesForMode(
  mode: DeployPrepareMode,
  warnings: DeployPrepareWarning[],
  sitesOrError: EnvironmentDeploySite[] | SitePrincipalError,
  fallbackSites: readonly SiteSpec[]
): EnvironmentDeploySite[] | SoftDeployPrepareError {
  if (!('kind' in sitesOrError)) return sitesOrError
  if (mode === 'preview') {
    warnings.push(warningFromPrepareError(sitesOrError))
    // Preview drops the ambiguous principal pin but must still render the same
    // validated php and cron the real deploy would carry. Cron is *dropped*
    // rather than rendered without an owner: the preview should show what would
    // actually run, and without a principal these jobs would not.
    return fallbackSites.map(({ php, cron: _unowned, ...rest }) => {
      const rendered = renderPhpForDeploy(php, ALLOWED_PHP_EXTENSIONS)
      return { ...rest, ...(rendered ? { php: rendered } : {}) }
    })
  }
  return sitesOrError
}

/**
 * Fold the source-material stage's outcome into the mode's error policy.
 *
 * `source_principal_ambiguous` is soft (preview warns and drops the pin, the
 * same way ambiguous site ownership does). `source_ref_unresolved`
 * is hard in both modes: a release the control plane cannot pin to a commit is
 * not something to preview around.
 */
function resolveSourceMaterialForMode(
  mode: DeployPrepareMode,
  warnings: DeployPrepareWarning[],
  resolved: EnvironmentDeploySource[] | DeploySourcePrepareError
): EnvironmentDeploySource[] | DeployPrepareError {
  if (Array.isArray(resolved)) return resolved
  if (resolved.kind === 'source_principal_ambiguous' && mode === 'preview') {
    warnings.push(warningFromPrepareError(resolved))
    return []
  }
  return resolved
}

/**
 * Git-backed releases for one prepare: resolve every `x-turbopanel.source`
 * binding on the *merged* document (a source may sit on a container or on a
 * site service) into clone material + a pinned commit + an allocated
 * release id, then keep only the entries scheduled onto this server.
 */
async function prepareLocalSourceMaterial(
  c: Context<AppEnv>,
  db: Db,
  args: {
    mode: DeployPrepareMode
    warnings: DeployPrepareWarning[]
    params: Parameters<typeof prepareDeployCompose>[2]
    merged: ComposeDocument
    serviceRows: ReadonlyArray<{ id: string; composeServiceName: string }>
    principalMaterial: readonly EnvironmentDeployPrincipalMaterial[]
    principalResolution: ComposePrincipalResolution
    localServiceNames?: ReadonlySet<string>
  }
): Promise<EnvironmentDeploySource[] | DeployPrepareError | Response> {
  const { params } = args
  const resolved = await resolveDeploySourceMaterial(c, db, {
    mode: args.mode,
    organizationId: params.organizationId,
    environmentId: params.environmentId,
    serverId: params.serverId,
    services: composeServicesRecord(args.merged),
    serviceRows: args.serviceRows,
    principalMaterial: args.principalMaterial,
    principalResolution: args.principalResolution,
    ...(params.sourceSelection === undefined ? {} : { sourceSelection: params.sourceSelection }),
    ...(params.rollback === undefined ? {} : { rollback: params.rollback }),
    ...(params.releaseIds === undefined ? {} : { releaseIds: params.releaseIds }),
  })
  if (resolved instanceof Response) return resolved
  const forMode = resolveSourceMaterialForMode(args.mode, args.warnings, resolved)
  if (!Array.isArray(forMode)) return forMode
  return sitesOnScheduledServer(forMode, args.localServiceNames)
}

/**
 * {@link prepareLocalSourceMaterial}, then the Node series of every native app
 * that names none, read from its repository at the commit just resolved (see
 * `deploy-node-version.ts`).
 */
async function prepareLocalSourcesWithNodeVersions(
  c: Context<AppEnv>,
  db: Db,
  args: Parameters<typeof prepareLocalSourceMaterial>[2] & {
    nativeApps: readonly PreparedNativeAppService[]
  }
): Promise<
  | {
      sourceMaterial: EnvironmentDeploySource[]
      nodeVersions: { apps: PreparedNativeAppService[]; views: NativeAppNodeVersionView[] }
    }
  | DeployPrepareError
  | Response
> {
  const sourceMaterial = await prepareLocalSourceMaterial(c, db, args)
  if (!Array.isArray(sourceMaterial)) return sourceMaterial
  return await resolveSourceNodeVersions(args.nativeApps, sourceMaterial, {
    mode: args.mode,
    warnings: args.warnings,
    read: repositoryNodeVersionReader(c, db, {
      organizationId: args.params.organizationId,
      serverId: args.params.serverId,
    }),
    ...(args.params.rollback === undefined
      ? {}
      : { rollbackPins: args.params.rollback.releaseByService }),
  })
}

/**
 * Registration check for the compose document's external Docker networks,
 * plus the addressing the registered rows declare (one query serves both).
 * The error is soft — `absorbSoftPrepareError` decides whether a preview
 * records it as a warning or a deploy refuses.
 */
async function resolveExternalNetworks(
  db: Db,
  organizationId: string,
  serverId: string,
  dockerExternalNetworks: string[]
): Promise<{
  error: SoftDeployPrepareError | null
  addressing: EnvironmentDeployDockerNetwork[]
}> {
  const resolved = await resolveRegisteredExternalDockerNetworks(
    db,
    organizationId,
    serverId,
    dockerExternalNetworks
  )
  return {
    error: resolved.missing
      ? {
          kind: 'docker_external_network_unregistered',
          names: resolved.missing,
        }
      : null,
    addressing: resolved.addressing,
  }
}

function replicaCountsFromMap(counts: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])))
}

function identityComposeExpansion(names: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const name of names) map.set(name, [name])
  return map
}

function overlayCompiledExpansion(
  identity: ReadonlyMap<string, string[]>,
  compiled: ReadonlyMap<string, string[]>
): Map<string, string[]> {
  const next = new Map(identity)
  for (const [name, clones] of compiled) next.set(name, clones)
  return next
}

function applyExpansionToNames(
  names: readonly string[],
  expansion: ReadonlyMap<string, readonly string[]>
): string[] {
  const out = new Set<string>()
  for (const name of names) {
    const clones = expansion.get(name)
    if (!clones || clones.length === 0) {
      out.add(name)
      continue
    }
    for (const clone of clones) out.add(clone)
  }
  return [...out].sort((a, b) => a.localeCompare(b))
}

function applyScheduleToContainerSpecs(
  specs: ContainerServiceSpec[],
  schedule: DeployScheduleSlice | undefined
): ContainerServiceSpec[] {
  if (!schedule) return specs
  const tasksByService = new Map<string, DesiredSlotInput[]>()
  for (const task of schedule.slots) {
    const list = tasksByService.get(task.serviceId) ?? []
    list.push(task)
    tasksByService.set(task.serviceId, list)
  }
  const next: ContainerServiceSpec[] = []
  for (const spec of specs) {
    const slots = tasksByService.get(spec.serviceId)
    if (!slots || slots.length === 0) continue
    const serverIdByOrdinal = new Map<number, string>()
    for (const task of slots) {
      serverIdByOrdinal.set(task.slot + 1, task.serverId)
    }
    next.push({
      ...spec,
      instances: slots.length,
      serverIdByOrdinal,
    })
  }
  return next
}

function ownsIngressForService(
  schedule: DeployScheduleSlice | undefined,
  serviceId: string,
  serverId: string
): boolean {
  if (!schedule) return true
  const slots = schedule.slots.filter((task) => task.serviceId === serviceId)
  if (slots.length === 0) return false
  let minSlot = slots[0]!.slot
  for (const task of slots) {
    if (task.slot < minSlot) minSlot = task.slot
  }
  return slots.some((task) => task.slot === minSlot && task.serverId === serverId)
}

/**
 * Deploy identity = compiled runtime YAML **plus** the commit each Git-backed
 * service will build, in stable `composeServiceName` order.
 *
 * Without the commits a redeploy whose compose is unchanged but whose source
 * moved forward would hash identically to the last deploy and be skipped as a
 * no-op; with them, an unchanged commit stays a genuine no-op. Deploys with no
 * `sourceMaterial[]` hash exactly as before, so upgrading the instance does not
 * invalidate every already-applied `desiredHash`.
 */
async function deployDesiredHash(
  composeYaml: string,
  sourceMaterial: readonly EnvironmentDeploySource[],
  nativeAppServices: readonly PreparedNativeAppService[] = []
): Promise<string> {
  const parts: string[] = []
  if (sourceMaterial.length > 0) {
    parts.push(
      [...sourceMaterial]
        .sort((a, b) => a.composeServiceName.localeCompare(b.composeServiceName))
        // A rollback re-promotes an *existing* release of a commit this
        // environment may already have deployed, so the commit alone would hash
        // identically to that earlier deploy and could be taken for a no-op.
        // The release id is what actually differs, so it participates.
        .map(
          (entry) =>
            `${entry.composeServiceName}=${entry.commitSha}` +
            (entry.rollbackToReleaseId ? `@${entry.rollbackToReleaseId}` : '')
        )
        .join('\n')
    )
  }
  // The resolved loopback port participates for the same reason the commit
  // does: a native app whose port moved is a different desired state even
  // though its compose body and commit are byte-identical, and the generated
  // systemd unit would otherwise never be re-rendered.
  if (nativeAppServices.length > 0) {
    parts.push(
      [...nativeAppServices]
        .sort((a, b) => a.composeServiceName.localeCompare(b.composeServiceName))
        .map((app) => `${app.composeServiceName}=${app.framework}:${app.listenPort}`)
        .join('\n')
    )
  }
  if (parts.length === 0) return await sha256HexUtf8(composeYaml)
  return await sha256HexUtf8([composeYaml, ...parts].join('\n'))
}

async function toPreparedDeployResult(
  mode: DeployPrepareMode,
  parts: {
    /**
     * The server this slice compiles for — {@link ServerDeployment.serverId}.
     *
     * Optional here (and only here) because the host-free coverage of this
     * assembler builds parts without one; every real prepare passes it.
     */
    serverId?: string
    composeYaml: string
    composeFiles: EnvironmentDeployComposeFile[]
    hooks: ServiceDeployHook[]
    variableMaterial: EnvironmentDeployVariableMaterial[]
    storageMaterial: EnvironmentDeployStorageMaterial[]
    principalMaterial: EnvironmentDeployPrincipalMaterial[]
    sites: EnvironmentDeploySite[]
    nativeAppServices: PreparedNativeAppService[]
    nativeAppVariables?: NativeAppVariablesView[]
    nativeAppNodeVersions?: NativeAppNodeVersionView[]
    nativeAppDenoVersions?: NativeAppDenoVersionView[]
    sourceMaterial: EnvironmentDeploySource[]
    dockerExternalNetworks: string[]
    dockerNetworkAddressing?: readonly EnvironmentDeployDockerNetwork[]
    fabricNetworks?: readonly EnvironmentDeployFabricNetwork[]
    managedNetworkServices: string[]
    managedNetwork?: string
    containers: ContainerAllocation[]
    ingressServices: EnvironmentDeployIngressService[]
    /**
     * The edge half of the deployment. Optional only for the assemblers that
     * genuinely have none — the empty-compose short-circuit and the host-free
     * coverage of this function — never as a licence for a caller with routes
     * to leave them behind.
     */
    edge?: ServerEdgeDeployment
    expansion: Map<string, string[]>
    registeredVolumes: RegisteredComposeVolume[]
    warnings: DeployPrepareWarning[]
    replicaCounts: Record<string, number>
    envFile?: string
    secretPlan?: DeploySecretPlanEntry[]
    sourceSelection?: DeploySourceSelection
  }
): Promise<PreparedDeployCompose> {
  const omitSecrets = mode === 'preview'
  return {
    ...(parts.serverId === undefined ? {} : { serverId: parts.serverId }),
    composeYaml: parts.composeYaml,
    composeFiles: parts.composeFiles,
    desiredHash: await deployDesiredHash(
      parts.composeYaml,
      parts.sourceMaterial,
      parts.nativeAppServices
    ),
    replicaCounts: parts.replicaCounts,
    hooks: parts.hooks,
    variableMaterial: omitSecrets ? [] : parts.variableMaterial,
    storageMaterial: omitSecrets ? [] : parts.storageMaterial,
    principalMaterial: parts.principalMaterial,
    sites: parts.sites,
    nativeAppServices: parts.nativeAppServices,
    nativeAppVariables: parts.nativeAppVariables ?? [],
    nativeAppNodeVersions: parts.nativeAppNodeVersions ?? [],
    nativeAppDenoVersions: parts.nativeAppDenoVersions ?? [],
    sourceMaterial: parts.sourceMaterial,
    dockerExternalNetworks: parts.dockerExternalNetworks,
    dockerNetworkAddressing: parts.dockerNetworkAddressing
      ? [...parts.dockerNetworkAddressing]
      : [],
    fabricNetworks: parts.fabricNetworks ? [...parts.fabricNetworks] : [],
    managedNetworkServices: parts.managedNetworkServices,
    ...(parts.managedNetwork === undefined ? {} : { managedNetwork: parts.managedNetwork }),
    containers: parts.containers,
    ingressServices: parts.ingressServices,
    hostings: parts.edge?.hostings ?? [],
    tlsMaterial: parts.edge?.tlsMaterial ?? [],
    listenerPorts: parts.edge?.listenerPorts ?? DEFAULT_MANAGED_INGRESS_PORTS,
    ...(parts.edge?.hostingIngress === undefined
      ? {}
      : { hostingIngress: parts.edge.hostingIngress }),
    ...(parts.edge?.hostingIngressNetwork === undefined
      ? {}
      : { hostingIngressNetwork: parts.edge.hostingIngressNetwork }),
    composeServiceExpansion: expansionToRecord(parts.expansion),
    volumes: parts.registeredVolumes,
    warnings: parts.warnings,
    ...(parts.envFile !== undefined ? { envFile: parts.envFile } : {}),
    ...(parts.secretPlan !== undefined ? { secretPlan: parts.secretPlan } : {}),
    ...(parts.sourceSelection === undefined ? {} : { sourceSelection: parts.sourceSelection }),
  }
}

function toApplyVariablesPrepareError(error: ApplyVariablesError): DeployPrepareError {
  const { kind, message, ref, composeServiceName, envKey } = error
  if (kind === 'variable_unresolved') {
    return {
      kind,
      message,
      ...(ref === undefined ? {} : { ref }),
      ...(composeServiceName === undefined ? {} : { composeServiceName }),
      ...(envKey === undefined ? {} : { envKey }),
    }
  }
  return {
    kind,
    message,
    ...(composeServiceName === undefined ? {} : { composeServiceName }),
    ...(envKey === undefined ? {} : { envKey }),
  }
}

function compileRuntimeOptionsForServer(
  environmentId: string,
  pipeline: Pick<DeployExpandPipeline, 'localReplicaCounts' | 'localServiceNames'>,
  schedule?: DeployScheduleSlice
): CompileRuntimeOptions {
  const options: CompileRuntimeOptions = {
    environmentId,
    localReplicaCounts: pipeline.localReplicaCounts,
  }
  if (pipeline.localServiceNames) {
    options.localServiceNames = pipeline.localServiceNames
  }
  if (!schedule) return options
  if (schedule.spanningNetworks) {
    options.spanningNetworks = schedule.spanningNetworks
  }
  if (schedule.taskAddresses) {
    options.taskAddressesByService = schedule.taskAddresses
  }
  if (schedule.spanningHosts) {
    options.spanningHostsByService = schedule.spanningHosts
  }
  if (schedule.managedIngressHostsByService && schedule.managedIngressHostsByService.size > 0) {
    options.managedIngressHostsByService = schedule.managedIngressHostsByService
  }
  return options
}

/** Runtime YAML for the container document — the empty stanza when it has no services. */
function runtimeComposeYamlOrEmpty(document: ComposeDocument): string {
  return composeDocumentToRuntimeYaml(document) || emptyContainerComposeYaml()
}

function sitesOnScheduledServer<T extends { composeServiceName: string }>(
  sites: readonly T[],
  localNames?: ReadonlySet<string>
): T[] {
  if (!localNames) return [...sites]
  return sites.filter((site) => localNames.has(site.composeServiceName))
}

function healthCheckAcknowledge(
  mode: DeployPrepareMode,
  acknowledge?: boolean
): boolean | undefined {
  if (mode === 'preview') return false
  return acknowledge
}

function fabricNetworksFromSchedule(
  schedule?: DeployScheduleSlice
): readonly EnvironmentDeployFabricNetwork[] {
  return schedule?.fabricNetworks ?? []
}

/**
 * The rows and merged document every prepare starts from, gated by
 * deploy-time compose validation.
 */
async function loadDeployComposeContext(
  db: Db,
  params: {
    environmentId: string
    serverId: string
    organizationId: string
    composeValidated?: boolean
  }
): Promise<
  | {
      ok: true
      envRow: {
        id: string
        projectId: string
        options: unknown
        name: string | null
      }
      projectRow: { id: string; options: unknown }
      orgRow: { options: unknown } | undefined
      serverRow: { options: unknown; organizationId: string | null } | undefined
      merged: ComposeDocument
    }
  | { ok: false; failure: DeployPrepareError | Response }
> {
  const loaded = await loadDeployEnvAndProject(db, params.environmentId)
  if (loaded instanceof Response) return { ok: false, failure: loaded }
  const { envRow, projectRow } = loaded

  const [orgRow] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, params.organizationId))
    .limit(1)

  const [serverRow] = await db
    .select({
      options: server.options,
      organizationId: server.organizationId,
    })
    .from(server)
    .where(eq(server.id, params.serverId))
    .limit(1)

  const environmentFilename = environmentComposeFilename({
    id: envRow.id,
    name: envRow.name,
  })
  const rawComposeLayers = resolveProjectEnvironmentComposeLayers(
    projectRow.options,
    envRow.options,
    environmentFilename
  )
  if (rawComposeLayers instanceof Response) {
    return { ok: false, failure: rawComposeLayers }
  }
  const merged = mergeComposeLayers(rawComposeLayers)

  // Validation pipeline, in order (see `lib/compose/validate-for-deploy.ts`):
  // upstream Compose schema -> `x-turbopanel` extension schema -> semantic
  // linter -> **policy** -> compiler. Stages 1-3 ran at the write boundary on
  // each stored *layer*, but a deploy runs the *merge* of several, which no
  // save ever saw; stage 4 can only run now, because a field TurboPanel cannot
  // honour is advice while editing and a refusal here.
  //
  // Skipped only when the scheduler already ran the identical merge through it
  // for this request (`PlannedDeploy.composeValidated`) — never merely because
  // the layers saved cleanly. It gates before `compileRuntimeComposeDocument`,
  // which is entitled to assume every `deploy:` key it still sees is one the
  // registry says we handle, and before the reconciles below write rows.
  if (!params.composeValidated) {
    const orgOptions = parseOrganizationOptions(orgRow?.options)
    const rejected = validateComposeForDeploy(merged, {
      composeGatedFieldsEnabled: resolveComposeGatedFieldsEnabled(orgOptions),
      composeRemoteBuildSourcesEnabled: resolveComposeRemoteBuildSourcesEnabled(orgOptions),
    })
    if (rejected) return { ok: false, failure: rejected }
  }

  return { ok: true, envRow, projectRow, orgRow, serverRow, merged }
}

/**
 * Materialize everything the merged document declares into control-plane rows
 * — services, principals, hostings, bindings — before the ownership lanes and
 * the hosting fan-out read them back.
 */
async function reconcileComposeDeclaredRows(
  c: Context<AppEnv>,
  db: Db,
  args: {
    environmentId: string
    organizationId: string
    projectId: string
    merged: ComposeDocument
    mode: DeployPrepareMode
    warnings: DeployPrepareWarning[]
  }
): Promise<
  | {
      ok: true
      serviceRows: ServiceRow[]
      principalResolution: ComposePrincipalResolution
    }
  | { ok: false; failure: DeployPrepareError }
> {
  await reconcileServicesFromCompose(db, args.environmentId, args.merged)

  const serviceRows = await db
    .select({
      id: service.id,
      composeServiceName: service.composeServiceName,
      options: service.options,
    })
    .from(service)
    .where(eq(service.environmentId, args.environmentId))

  // Materialize the accounts compose declares before either ownership lane
  // resolves — the site pin and the release owner both read the map this
  // returns, and an alias that had not become a `principal` row by now would
  // silently produce an unowned site or an unreleased app.
  const principalReconcile = await reconcilePrincipalsFromCompose(db, {
    organizationId: args.organizationId,
    projectId: args.projectId,
    merged: args.merged,
    serviceRows,
  })
  if (!principalReconcile.ok) {
    return {
      ok: false,
      failure: {
        kind: 'principal_alias_unknown',
        composeServiceName: principalReconcile.composeServiceName,
        alias: principalReconcile.alias,
      },
    }
  }

  // Materialize the ingress compose declares, in the same slot and for the same
  // reason principals occupy the one above: the hosting fan-out later in this
  // deploy (`buildHostingsForService` in `./deploy-routes.ts`) reads `hosting`
  // rows, so a route that had not become a row by now would simply not be
  // served — with nothing said about why.
  const hostingReconcile = await reconcileHostingsFromCompose(db, {
    organizationId: args.organizationId,
    environmentId: args.environmentId,
    merged: args.merged,
    serviceRows,
  })
  if (!hostingReconcile.ok) {
    return { ok: false, failure: hostingReconcile.error }
  }

  // Re-materialize bindings so endpoint / CA / topology drift is picked up.
  const bindingOutcome = await resolveBindingMaterializationOutcome(
    db,
    c.get('dataEncryptionSecrets'),
    serviceRows.map((r) => r.id),
    args.mode,
    // What the document says each service is: a site or native app dials the
    // proxy on loopback, a container service by container name.
    deliveryByServiceId(hostRunDeliveryByComposeName(args.merged.data), serviceRows)
  )
  const bindingErr = absorbBindingOutcome(args.warnings, bindingOutcome)
  if (bindingErr) return { ok: false, failure: bindingErr }

  return {
    ok: true,
    serviceRows,
    principalResolution: principalReconcile.resolution,
  }
}

/**
 * The gates asked of the resolved placement, in order: storage locality, then
 * org/server resource limits, then health-check policy. The soft ones fold
 * into `warnings` in preview.
 */
async function resolvedPlacementGateError(
  db: Db,
  args: {
    mode: DeployPrepareMode
    warnings: DeployPrepareWarning[]
    environmentId: string
    serverId: string
    acknowledgeHealthCheckWarnings: boolean | undefined
    resolved: ResolvedApplication
    pipeline: Pick<
      DeployExpandPipeline,
      'expandedDocument' | 'expandedServiceNames' | 'optionsByComposeName'
    >
    orgOptions: unknown
    serverOptions: unknown
  }
): Promise<DeployPrepareError | null> {
  const locationErr = await findUnavailableStorageCopy(db, {
    environmentId: args.environmentId,
    scheduledServerId: args.serverId,
    serviceIds: serviceIdsOnServer(args.resolved),
  })
  if (locationErr) return locationErr

  const limitErr = absorbSoftPrepareError(
    args.mode,
    args.warnings,
    resourceLimitPrepareError(
      args.resolved.services,
      args.pipeline.expandedServiceNames.length,
      args.orgOptions,
      args.serverOptions,
      args.pipeline.expandedDocument.data.services
    )
  )
  if (limitErr) return limitErr

  return absorbSoftPrepareError(
    args.mode,
    args.warnings,
    evaluateHealthCheckGates(
      args.pipeline.expandedDocument,
      args.pipeline.optionsByComposeName,
      healthCheckAcknowledge(args.mode, args.acknowledgeHealthCheckWarnings)
    )
  )
}

/**
 * Host name of the org's managed network, when anything joins it.
 *
 * Scoped to the server owner, matching the ProxySQL frontend the joining
 * services dial. Skipped entirely when nothing joins — a deploy that touches
 * no managed binding must not allocate the org's network row as a side effect.
 */
async function resolveManagedNetworkHostName(
  db: Db,
  managedNetworkServices: readonly string[],
  organizationId: string
): Promise<string | undefined> {
  if (managedNetworkServices.length === 0) return undefined
  const network = await ensureOrganizationManagedNetwork(db, {
    organizationId,
  })
  return network.hostName
}

/**
 * Everything that depends on which runtime each local native app runs: the
 * Deno feature gate and the repository's Node version. The first refusal wins;
 * a Deno app is refused before anything reads it as Node.
 */
async function prepareNativeAppRuntimes(
  c: Context<AppEnv>,
  db: Db,
  args: Omit<Parameters<typeof prepareLocalSourcesWithNodeVersions>[2], 'nativeApps'> & {
    nativeApps: readonly PreparedNativeAppService[]
  }
): Promise<
  | {
      localSourceMaterial: EnvironmentDeploySource[]
      nodeVersions: { apps: PreparedNativeAppService[]; views: NativeAppNodeVersionView[] }
    }
  | DeployPrepareError
  | Response
> {
  // A rollback runs each app on the runtime its release ran on.
  const nativeApps = withRecordedRuntimes(args.nativeApps, args.params.rollback?.releaseByService)
  const denoGate = await withDenoNativeApps(db, args.params.serverId, nativeApps)
  if ('kind' in denoGate) return denoGate

  // An app with no `nodeVersion` gets one here from its repository at the
  // commit being deployed.
  const localSources = await prepareLocalSourcesWithNodeVersions(c, db, { ...args, nativeApps })
  if (!('sourceMaterial' in localSources)) return localSources
  const { sourceMaterial: localSourceMaterial, nodeVersions } = localSources

  return { localSourceMaterial, nodeVersions }
}

export async function prepareDeployCompose(
  c: Context<AppEnv>,
  db: Db,
  params: {
    environmentId: string
    serverId: string
    organizationId: string
    acknowledgeHealthCheckWarnings?: boolean
    /**
     * `preview` skips daemon sealing, softens prepare gates into `warnings`,
     * and redacts secret values in the returned YAML. Allocation + volume
     * registration still run (idempotent) so previewed UUIDs match deploy.
     */
    mode?: DeployPrepareMode
    /** When set, compile and allocate from the scheduler plan instead of YAML expansion. */
    schedule?: DeployScheduleSlice
    /**
     * Commit the caller asked to build. Threaded in from the deploy route and
     * the webhook trigger so the request reaches the layer that will resolve it;
     * this phase only carries it (see {@link PREPARE_HONORS_SOURCE_SELECTION}).
     */
    sourceSelection?: DeploySourceSelection
    /**
     * Roll one Git-backed service back to an already-published release.
     *
     * Everything else about the prepare is unchanged — same compose, same
     * placement, same principals, same hostings — because a rollback *is* a
     * deploy of the current environment that promotes existing releases instead
     * of building new ones. Only `sourceMaterial[]` differs: every Git-backed
     * service is pinned to a release it already has (see `deploy-sources.ts`
     * for why the whole set, not just the one being undone).
     */
    rollback?: DeployRollbackRequest
    /**
     * Release ids allocated once for the whole deploy, shared by every server.
     *
     * Prepare runs once per participating server, so without this each host
     * would mint its own id for the same logical release and no single id would
     * describe the environment's release — see {@link ReleaseIdAllocator}.
     * Omitted by preview, which resolves one host in isolation.
     */
    releaseIds?: ReleaseIdAllocator
    /**
     * The scheduler already validated this exact merged document for this
     * request (`PlannedDeploy.composeValidated`).
     *
     * Set by the fan-out so one verdict covers the whole deploy: prepare runs
     * once per participating server over a merge that cannot differ between
     * them, and re-deriving the same answer per host would let a diagnostic
     * appear N times for one document. It is a *skip*, never a *bypass* — a
     * caller that has not validated leaves it unset and prepare gates here,
     * which is what keeps every path that reaches the compiler gated.
     */
    composeValidated?: boolean
  }
): Promise<PreparedDeployCompose | DeployPrepareError | Response> {
  const mode = params.mode ?? 'deploy'
  const warnings: DeployPrepareWarning[] = []

  const context = await loadDeployComposeContext(db, params)
  if (!context.ok) return context.failure
  const { envRow, projectRow, orgRow, serverRow, merged } = context

  // Stage 2 of the compiler IR (`lib/compose/ir.ts`): read the merged document
  // once into named parts — kind, `x-turbopanel`, interpreted `deploy:`,
  // hosting declarations, principal aliases — instead of re-parsing the same
  // service at each call site that needs one of them. A read view over the
  // existing parsers; it decides nothing and touches no database.
  const application: Application = buildApplicationModel(merged, {
    project: { id: envRow.projectId },
  })
  const composeServiceNames = application.services.map((entry) => entry.name)
  if (composeServiceNames.length === 0) {
    return await emptyComposePrepareResult(mode)
  }

  const declared = await reconcileComposeDeclaredRows(c, db, {
    environmentId: params.environmentId,
    organizationId: params.organizationId,
    projectId: envRow.projectId,
    merged,
    mode,
    warnings,
  })
  if (!declared.ok) return declared.failure
  const { serviceRows, principalResolution } = declared

  const pipeline = await allocateExpandDeployPipeline(db, {
    environmentId: params.environmentId,
    serverId: params.serverId,
    organizationId: params.organizationId,
    projectOptions: projectRow.options,
    merged,
    composeServiceNames,
    serviceRows,
    schedule: params.schedule,
    deployHooks: resolveDeployHooksEnabled(parseOrganizationOptions(orgRow?.options)),
  })

  // Stage 3: the same services after the control plane answered what the
  // document could not — which `service.id` each compose key became, which
  // `principal.id` each alias materialized into, where the scheduler put every
  // replica, which containers were allocated. A projection over values already
  // computed above, so naming the stage cannot change placement.
  const resolved: ResolvedApplication = buildResolvedApplication({
    serverId: params.serverId,
    application,
    serviceRows,
    ...(params.schedule ? { slots: params.schedule.slots } : {}),
    containers: pipeline.containers,
    expansion: pipeline.expansion,
    principals: principalResolution,
    resourcesByComposeServiceName: resolvedResourcesByComposeName(pipeline.optionsByComposeName),
  })

  const gateErr = await resolvedPlacementGateError(db, {
    mode,
    warnings,
    environmentId: params.environmentId,
    serverId: params.serverId,
    acknowledgeHealthCheckWarnings: params.acknowledgeHealthCheckWarnings,
    resolved,
    pipeline,
    orgOptions: orgRow?.options,
    serverOptions: serverRow?.options,
  })
  if (gateErr) return gateErr

  const serviceRowByCloneName = buildServiceRowByCloneName(serviceRows, pipeline.expansion)
  const {
    globalEntries,
    perServiceEntries: userPerService,
    perServiceScopes,
  } = await resolveDeployVariableBuckets(db, {
    environmentId: params.environmentId,
    serverId: params.serverId,
    composeServiceNames: pipeline.expandedServiceNames,
    serviceRowByComposeName: serviceRowByCloneName,
    dataEncryptionSecrets: c.get('dataEncryptionSecrets'),
  })

  const perServiceEntries = stripReservedKeysFromEntries(userPerService)

  const withVariables = applyVariablesToComposeDocument(pipeline.expandedDocument, {
    globalEntries,
    perServiceEntries,
    perServiceScopes,
    nativeServiceNames: nativeComposeServiceNames(pipeline.expandedDocument),
    projectId: envRow.projectId,
    environmentId: params.environmentId,
  })
  if (isApplyVariablesError(withVariables)) {
    return toApplyVariablesPrepareError(withVariables)
  }
  const withServiceOptions = applyServiceOptionsToComposeDocument(
    documentForServiceOptions(mode, withVariables),
    pipeline.optionsByComposeName,
    buildContainerNameByComposeName(
      pipeline.containers,
      pipeline.localReplicaCounts,
      params.serverId
    ),
    // Opt-in per organization; fills a ceiling only where the service sets
    // none of its own (tenant-resource-limits-lint, decided 2026-09-16).
    resolveComposeDefaultResourceLimits(parseOrganizationOptions(orgRow?.options)),
    // Deploy hooks ride along only when the organization's owner enabled
    // them; otherwise service options are read without their command fields.
    {
      enabled: resolveDeployHooksEnabled(parseOrganizationOptions(orgRow?.options)),
    }
  )

  const storageMaterialRaw = await loadStorageMaterial(db, {
    environmentId: params.environmentId,
    projectId: envRow.projectId,
    organizationId: params.organizationId,
    serverId: params.serverId,
    serviceIds: serviceRows.map((row) => row.id),
    cloneNamesByServiceId: buildCloneNamesByServiceId(serviceRows, pipeline.expansion),
    registeredVolumes: pipeline.registeredVolumes,
  })
  const sealed = await maybeSealDeployMaterials(
    mode,
    c,
    db,
    params.serverId,
    withVariables.secretMaterial,
    storageMaterialRaw
  )
  if (sealed instanceof Response) return sealed
  const { variableMaterial, storageMaterial } = sealed

  const stewardPrincipalIds = await loadTenancyPrincipalIdsForEnvironment(db, params.environmentId)
  const storagePrincipalIds = storageMaterial
    .map((entry) => entry.principalId)
    .filter((id): id is string => typeof id === 'string')
  const principalMaterial = await loadPrincipalMaterial(db, [
    ...stewardPrincipalIds,
    ...storagePrincipalIds,
  ])

  const split = splitHostNativeFromDocument(withServiceOptions.document)
  // Drop host-native hooks — neither sites nor native apps are
  // Docker compose services, so a compose-scoped hook has nothing to run in.
  const siteNames = new Set(split.sites.map((site) => site.composeServiceName))
  const hostNativeNames = new Set([
    ...siteNames,
    ...split.nativeApps.map((app) => app.composeServiceName),
  ])
  const hooks = withServiceOptions.hooks.filter(
    (hook) => !hostNativeNames.has(hook.composeServiceName)
  )

  // Task rows (`POST /tasks`) join compose-authored cron on the wire for
  // sites and native apps alike — loaded once here, keyed by compose name.
  const tasksByComposeName = await loadTasksByComposeServiceName(db, serviceRows)
  const phpDaemonState = await getServerDaemonStateByServerId(db, params.serverId)
  const siteResolved = await withSitePhpModes(
    db,
    {
      daemonRunsModes:
        phpDaemonState?.projection?.features?.includes(PHP_SITE_MODES_FEATURE) === true,
      environmentId: params.environmentId,
      serverId: params.serverId,
      localServiceNames: pipeline.localServiceNames,
      specs: split.sites,
      orgOptions: orgRow?.options,
      serverOptions: serverRow?.options,
      warnings,
    },
    resolveSitesForMode(
      mode,
      warnings,
      await attachPrincipalsToSites(
        db,
        params.environmentId,
        serviceRows,
        principalMaterial,
        split.sites,
        principalResolution,
        tasksByComposeName
      ),
      split.sites
    )
  )
  if ('kind' in siteResolved) return siteResolved
  const localSite = sitesOnScheduledServer(siteResolved, pipeline.localServiceNames)
  const engineGate = await withSiteEngineFeature(db, params.serverId, localSite)
  if ('kind' in engineGate) return engineGate
  const dbBindingWarnings: SiteDbBindingsWarning[] = []
  const localSiteBound = await withSiteDbBindings(db, c.get('dataEncryptionSecrets'), {
    organizationId: params.organizationId,
    sites: localSite,
    serviceRows,
    daemonFeatures: phpDaemonState?.projection?.features ?? [],
    warnings: dbBindingWarnings,
  })
  warnings.push(...dbBindingWarnings)

  const localNativeAppsOrError = resolveLocalNativeAppServicesForDeploy(
    split.nativeApps,
    withVariables,
    resolved.services,
    orgRow?.options,
    serverRow?.options,
    tasksByComposeName,
    pipeline.localServiceNames
  )
  if ('kind' in localNativeAppsOrError) return localNativeAppsOrError
  const { localNativeApps, nativeVariables } = localNativeAppsOrError

  const runtimes = await prepareNativeAppRuntimes(c, db, {
    mode,
    warnings,
    params,
    merged,
    serviceRows,
    principalMaterial,
    principalResolution,
    localServiceNames: pipeline.localServiceNames,
    nativeApps: localNativeApps,
  })
  if ('kind' in runtimes || runtimes instanceof Response) return runtimes
  const { localSourceMaterial, nodeVersions } = runtimes

  const dockerExternalNetworks = collectComposeExternalDockerNetworkNames(split.composeYaml)
  const externalNetworks = await resolveExternalNetworks(
    db,
    params.organizationId,
    params.serverId,
    dockerExternalNetworks
  )
  const networkErr = absorbSoftPrepareError(mode, warnings, externalNetworks.error)
  if (networkErr) return networkErr

  // Sites and native `node` apps are host-native (stripped from
  // `composeYaml` above) and never join a Docker network — exclude them even if
  // a binding was somehow attached to one.
  const managedBindings = await resolveManagedNetworkComposeServiceNames(
    db,
    serviceRows,
    pipeline.expansion,
    params.serverId
  )
  const boundNames = managedBindings.bound.filter((name) => !hostNativeNames.has(name))
  const managedLogicalNames = localManagedNetworkServiceNames(
    boundNames,
    params.schedule?.managedIngressHostsByService,
    managedBindings.coResident
  )

  // Effective document = the same post-split container document serialized as
  // composeYaml today. Compile one runtime snapshot; daemons never see
  // project/environment/platform layers.
  const effective = split.containerDocument
  const compiled = compileRuntimeCompose(effective, {
    ...compileRuntimeOptionsForServer(params.environmentId, pipeline, params.schedule),
    placementServerId: params.serverId,
  })
  const expansion = overlayCompiledExpansion(pipeline.expansion, compiled.expansion)
  const managedNetworkServices = applyExpansionToNames(managedLogicalNames, expansion)
  const managedNetwork = await resolveManagedNetworkHostName(
    db,
    managedNetworkServices,
    serverRow?.organizationId ?? params.organizationId
  )
  const composeYaml = runtimeComposeYamlOrEmpty(compiled.document)
  const composeFiles = renderRuntimeComposeFiles(composeYaml)

  // Stage 4's remaining half. Compiled here, on the final expansion, so what
  // this function returns is the whole `ServerDeployment` a daemon is sent —
  // the deploy route enqueues it and assembles nothing of its own.
  const edge = await compileServerEdgeDeployment(c, db, {
    mode,
    environmentId: params.environmentId,
    organizationId: params.organizationId,
    ...(serverRow?.organizationId ? { serverOrganizationId: serverRow.organizationId } : {}),
    serverId: params.serverId,
    expansion: expansionToRecord(expansion),
    storageMaterial,
  })
  if (edge instanceof Response) return edge
  if ('kind' in edge) return edge

  return await toPreparedDeployResult(mode, {
    serverId: resolved.serverId,
    composeYaml,
    composeFiles,
    hooks,
    variableMaterial,
    storageMaterial,
    principalMaterial,
    sites: localSiteBound,
    nativeAppServices: nodeVersions.apps,
    nativeAppVariables: nativeAppVariableViews(nodeVersions.apps, nativeVariables),
    nativeAppNodeVersions: nodeVersions.views,
    nativeAppDenoVersions: nativeAppDenoVersionViews(nodeVersions.apps),
    sourceMaterial: localSourceMaterial,
    dockerExternalNetworks,
    dockerNetworkAddressing: externalNetworks.addressing,
    fabricNetworks: fabricNetworksFromSchedule(params.schedule),
    managedNetworkServices,
    ...(managedNetwork === undefined ? {} : { managedNetwork }),
    containers: pipeline.containers,
    ingressServices: pipeline.ingressServices,
    edge,
    expansion,
    registeredVolumes: pipeline.registeredVolumes,
    warnings,
    replicaCounts: replicaCountsFromMap(pipeline.localReplicaCounts),
    envFile: withVariables.envFileContent,
    secretPlan: withVariables.secretPlan,
    sourceSelection: params.sourceSelection,
  })
}

/** Why one site could not be pinned to a principal. */
export type SitePrincipalError =
  | {
      kind: 'site_principal_ambiguous' | 'site_managed_directory_unowned' | 'site_cron_unowned'
      composeServiceName: string
    }
  | {
      kind: 'principal_required_for_service_kind'
      composeServiceName: string
      serviceKind: 'site' | 'node'
    }

/**
 * The material for the account one site runs as, or the ownership refusal.
 *
 * A declared alias wins outright: the operator wrote down which account this
 * site runs as, so there is nothing to weigh it against and
 * `site_principal_ambiguous` is unreachable for this service. Extra tenancy
 * edges then say who else may reach the tree, not who owns it.
 */
function resolveSitePrincipalMaterial(
  site: SiteSpec,
  assignedIds: readonly string[],
  principalById: ReadonlyMap<string, EnvironmentDeployPrincipalMaterial>,
  declared: { alias: string; principalId: string | undefined } | undefined
):
  | { ok: true; material: EnvironmentDeployPrincipalMaterial | undefined }
  | {
      ok: false
      error: SitePrincipalError
    } {
  if (declared) {
    return {
      ok: true,
      material:
        declared.principalId === undefined ? undefined : principalById.get(declared.principalId),
    }
  }
  const sole = pickSolePrincipalId(assignedIds)
  if (sole.status === 'ambiguous') {
    return {
      ok: false,
      error: {
        kind: 'site_principal_ambiguous',
        composeServiceName: site.composeServiceName,
      },
    }
  }
  if (sole.status === 'none') {
    // No alias and no steward at all. A site's tree belongs to an account, so
    // this is refused rather than deployed as a daemon-owned directory no
    // tenant can reach. Asked of the *pick*, not of the material: a steward
    // whose material simply did not load is still an owner, and reporting it
    // as unowned would send the operator looking for the wrong thing.
    return {
      ok: false,
      error: {
        kind: 'principal_required_for_service_kind',
        composeServiceName: site.composeServiceName,
        serviceKind: 'site',
      },
    }
  }
  return { ok: true, material: principalById.get(sole.principalId) }
}

/**
 * One site, pinned to its sole assigned principal and rendered for the wire.
 *
 * The ownership refusals are caught here rather than at payload validation so
 * the operator gets a sentence naming the service instead of a generic
 * "Invalid sites entry" during enqueue.
 */
function prepareSiteForDeploy(
  site: SiteSpec,
  assignedIds: readonly string[],
  principalById: ReadonlyMap<string, EnvironmentDeployPrincipalMaterial>,
  /** `principal.id` the service's declared alias resolved to, if it declared one. */
  declared: { alias: string; principalId: string | undefined } | undefined,
  tasks: readonly TaskRecord[] = []
):
  | { ok: true; site: EnvironmentDeploySite }
  | {
      ok: false
      error: SitePrincipalError
    } {
  const fail = (
    kind: Exclude<SitePrincipalError['kind'], 'principal_required_for_service_kind'>
  ) => ({
    ok: false as const,
    error: { kind, composeServiceName: site.composeServiceName },
  })

  const resolvedMaterial = resolveSitePrincipalMaterial(site, assignedIds, principalById, declared)
  if (!resolvedMaterial.ok) return resolvedMaterial
  const { material } = resolvedMaterial
  const principalPin = material ? toSitePrincipal(material) : undefined

  // "A directory and a principal" needs both — falling back to the
  // daemon-owned tree would serve fine and be unreachable over SFTP forever.
  if (site.sourceKind === 'managed-directory' && !principalPin) {
    return fail('site_managed_directory_unowned')
  }

  // Compose carries what the operator authored; the wire carries what was
  // validated and translated. Anything that fails its spec is dropped rather
  // than escaped — the save-time linter is what tells them why.
  const { php: authoredPhp, cron: authoredCron, ...rest } = site
  const php = renderPhpForDeploy(authoredPhp, ALLOWED_PHP_EXTENSIONS)
  const cron = renderCronForDeploy(authoredCron, tasks)
  // A timer with no `User=` runs as root; the wire refuses that.
  if (cron.length > 0 && !principalPin) return fail('site_cron_unowned')

  return {
    ok: true,
    site: {
      ...rest,
      ...(php ? { php } : {}),
      ...(cron.length > 0 ? { cron } : {}),
      ...(principalPin ? { principal: principalPin } : {}),
    },
  }
}

/**
 * Pin each site to the account its compose declares, falling back to a sole
 * assigned project principal for a document that declares none.
 *
 * Multiple principals on an un-aliased service is ambiguous ownership → prepare
 * error; none at all is unowned → prepare error.
 */
export async function attachPrincipalsToSites(
  db: Db,
  environmentId: string,
  serviceRows: ReadonlyArray<{ id: string; composeServiceName: string }>,
  principalMaterial: readonly EnvironmentDeployPrincipalMaterial[],
  sites: readonly SiteSpec[],
  principalResolution: ComposePrincipalResolution,
  tasksByComposeName: ReadonlyMap<string, readonly TaskRecord[]> = new Map()
): Promise<EnvironmentDeploySite[] | SitePrincipalError> {
  if (sites.length === 0) return []

  const principalById = new Map(principalMaterial.map((entry) => [entry.principalId, entry]))
  const principalIdsByServiceId = await loadPrincipalIdsByServiceIdForEnvironment(db, environmentId)
  const serviceIdByComposeName = new Map<string, string>()
  for (const row of serviceRows) {
    serviceIdByComposeName.set(row.composeServiceName, row.id)
  }

  const out: EnvironmentDeploySite[] = []
  for (const site of sites) {
    const serviceId = serviceIdByComposeName.get(site.composeServiceName)
    const assignedIds = serviceId ? (principalIdsByServiceId.get(serviceId) ?? []) : []
    const alias = principalResolution.aliasByComposeServiceName.get(site.composeServiceName)
    const prepared = prepareSiteForDeploy(
      site,
      assignedIds,
      principalById,
      alias === undefined
        ? undefined
        : {
            alias,
            principalId: principalResolution.principalIdByAlias.get(alias),
          },
      tasksByComposeName.get(site.composeServiceName)
    )
    if (!prepared.ok) return prepared.error
    out.push(prepared.site)
  }
  return out
}

/**
 * Translate authored cron and the service's task rows into the wire shape.
 *
 * Two authoring paths, one namespace of timers on the host: compose-authored
 * jobs (`x-turbopanel.cron`) and task rows (`POST /tasks`). Compose comes
 * first and wins a name collision — the API refuses a task whose unit name
 * matches a compose job (`task_name_in_compose`), so a collision here is a
 * compose edit made after the task existed, and the document is what the
 * operator is looking at when they deploy. Disabled rows are not rendered.
 *
 * A job whose schedule or command fails its spec is **dropped**, matching how
 * PHP settings are handled: the compose linter / the tasks API already
 * refused it at save with the reason, and re-reporting it at deploy would be
 * a second, worse explanation of a problem the operator has already been
 * shown. The combined list is capped at {@link MAX_CRON_JOBS_PER_SERVICE},
 * which each path also enforces on its own.
 */
export function renderCronForDeploy(
  jobs: readonly ComposeServiceCronJob[] | undefined,
  tasks: readonly TaskRecord[] = []
): EnvironmentDeployCronJob[] {
  const out: EnvironmentDeployCronJob[] = []
  const seen = new Set<string>()
  for (const job of jobs ?? []) tryPushComposeCronJob(job, seen, out)
  for (const row of tasks) tryPushTaskCronJob(row, seen, out)
  return out
}

function tryPushComposeCronJob(
  job: ComposeServiceCronJob,
  seen: Set<string>,
  out: EnvironmentDeployCronJob[]
): void {
  if (out.length >= MAX_CRON_JOBS_PER_SERVICE) return
  if (!CRON_JOB_NAME_RE.test(job.name) || seen.has(job.name)) return
  const schedule = cronToOnCalendar(job.schedule)
  if (!schedule.ok) return
  const command = parseCronCommand(job.command)
  if (!command.ok) return
  seen.add(job.name)
  out.push({
    name: job.name,
    schedule: schedule.value,
    command: command.value,
  })
}

function tryPushTaskCronJob(
  row: TaskRecord,
  seen: Set<string>,
  out: EnvironmentDeployCronJob[]
): void {
  if (out.length >= MAX_CRON_JOBS_PER_SERVICE) return
  if (!row.isEnabled) return
  const name = cronJobUnitName(row.name)
  if (name === null || seen.has(name)) return
  const schedule = cronToOnCalendar(row.schedule, row.timezone)
  if (!schedule.ok) return
  const command = parseCronCommand(row.command)
  if (!command.ok) return
  seen.add(name)
  const extra: Partial<EnvironmentDeployCronJob> = {}
  if (row.timeoutSeconds !== null) extra.timeoutSeconds = row.timeoutSeconds
  // The wire carries `forbid` only (see EnvironmentDeployCronJob); a row
  // holding another policy is rendered without one, which is systemd's
  // own behaviour for a still-active unit — the same thing as forbid.
  if (row.concurrencyPolicy === 'forbid') extra.concurrencyPolicy = 'forbid'
  out.push({
    name,
    schedule: schedule.value,
    command: command.value,
    ...extra,
  })
}

/** Task rows for an environment's services, keyed by compose service name. */
export async function loadTasksByComposeServiceName(
  db: Db,
  serviceRows: ReadonlyArray<{ id: string; composeServiceName: string }>
): Promise<ReadonlyMap<string, TaskRecord[]>> {
  const byServiceId = new Map(serviceRows.map((row) => [row.id, row.composeServiceName]))
  const out = new Map<string, TaskRecord[]>()
  if (byServiceId.size === 0) return out
  for (const row of await listTasksForServices(db, [...byServiceId.keys()])) {
    const composeName = byServiceId.get(row.serviceId)
    if (composeName === undefined) continue
    const list = out.get(composeName) ?? []
    list.push(row)
    out.set(composeName, list)
  }
  return out
}

function toSitePrincipal(
  material: EnvironmentDeployPrincipalMaterial
): EnvironmentDeploySitePrincipal {
  return {
    principalId: material.principalId,
    username: material.username,
    ...(material.uid !== undefined ? { uid: material.uid } : {}),
    ...(material.gid !== undefined ? { gid: material.gid } : {}),
  }
}

/**
 * Strip every **host-native** service out of the Docker document: site
 * sites and `serviceKind: node` apps alike.
 *
 * Both lanes end up behind hosting Caddy on a loopback port, so they allocate
 * out of **one** `usedPorts` ledger — a site and an app handed the same port
 * would leave whichever bound second dead with no diagnostic anywhere near the
 * cause.
 */
function splitHostNativeFromDocument(document: ComposeDocument): {
  composeYaml: string
  /** Post-split / pruned container document (same body as `composeYaml`). */
  containerDocument: ComposeDocument
  sites: SiteSpec[]
  nativeApps: NativeAppServiceSpec[]
} {
  const services = isPlainObject(document.data.services)
    ? (document.data.services as Record<string, unknown>)
    : {}
  const usedPorts = new Set<number>()
  const split = splitSiteServices(services, new Map(), usedPorts)
  const sites = split.sites
  const { containerServices, apps: nativeApps } = splitNativeAppServices(
    split.containerServices,
    usedPorts
  )

  if (Object.keys(containerServices).length === 0) {
    const emptyDocument: ComposeDocument = {
      version: 1,
      data: { services: {} },
      presentation: { keyOrder: ['services'], comments: {} },
    }
    return {
      composeYaml: emptyContainerComposeYaml(),
      containerDocument: emptyDocument,
      sites,
      nativeApps,
    }
  }

  const existingNetworks = isPlainObject(document.data.networks)
    ? (document.data.networks as Record<string, unknown>)
    : undefined
  const prunedNetworks = pruneUnreferencedComposeNetworks(containerServices, existingNetworks)

  const nextData: Record<string, unknown> = {
    ...document.data,
    services: containerServices,
  }
  if (prunedNetworks) {
    nextData.networks = prunedNetworks
  } else {
    delete nextData.networks
  }

  const containerDocument: ComposeDocument = {
    ...document,
    data: nextData,
  }
  return {
    composeYaml: composeDocumentToRuntimeYaml(containerDocument),
    containerDocument,
    sites,
    nativeApps,
  }
}

// ---------------------------------------------------------------------------
// The edge half of one server's deployment
// ---------------------------------------------------------------------------
//
// Hostings, their TLS, the shared ingress they join and the org's listener
// ports are as much a part of "what this server is told to run" as the compiled
// compose document is, so they are compiled here rather than by the route that
// enqueues the result. `ServerDeployment` (`lib/compose/ir.ts`) is then the
// whole per-server contract, and the transport layer assembles nothing.

type DeployHostingPayload = EnvironmentDeployHosting

type BuildHostingResult =
  | {
      hostings: DeployHostingPayload[]
      resolvedTlsIds: string[]
    }
  | { error: Response }
  | { prepareError: DeployPrepareError }

function isTlsSource(value: string): value is TlsSource {
  return (TLS_SOURCES as readonly string[]).includes(value)
}

type OrgTlsCandidate = TlsCandidate & {
  certificatePem: string | null
  privateKeyPem: string | null
}

export type HostingTlsWire =
  | { ok: true; tlsId: string | null; tlsMode?: 'acme' }
  | { ok: false; error: 'acme_requires_public_bind' }
  | { ok: false; error: 'acme_requires_org_opt_in' }

/**
 * ACME-managed Let's Encrypt pins omit `tlsId` on the wire so older daemons
 * fall back to `tls internal`, and they are excluded from `tlsMaterial`.
 *
 * `acmeEnabled` is the org's opt-in gate (`organization.options.acmeEnabled`,
 * off by default) — checked here as defense in depth even though `POST /tls`
 * already refuses to create a `lets_encrypt` row while the org is opted out,
 * because a `managed` row can predate the org later disabling the gate.
 */
export function hostingTlsWireFromResolved(params: {
  tlsId: string | null
  status: TlsStatus | undefined
  bindScope: HostingBindScope
  acmeEnabled: boolean
}): HostingTlsWire {
  if (params.status !== 'managed') {
    return { ok: true, tlsId: params.tlsId }
  }
  if (!params.acmeEnabled) {
    return { ok: false, error: 'acme_requires_org_opt_in' }
  }
  if (params.bindScope === 'local' || params.bindScope === 'datacenter') {
    return { ok: false, error: 'acme_requires_public_bind' }
  }
  return { ok: true, tlsId: null, tlsMode: 'acme' }
}

/** The `service` columns a hosting fan-out needs. */
type HostingServiceRow = {
  id: string
  composeServiceName: string
}

type HostingRow = {
  id: string
  options: unknown
  tlsId: string | null
  ipId: string | null
}

/**
 * Names a pinned certificate must cover. An uploaded pair is served as-is on
 * every name the www mode adds, so it must list them all. A Let's Encrypt pin
 * is issued by Caddy name by name in `acme` mode, so only the typed names are
 * checked against the row (the www names get their own certificate).
 */
function pinCoverageNames(
  pinId: string | null,
  candidates: OrgTlsCandidate[],
  hosting: Readonly<{ hostnames: string[]; www: HostingWwwMode }>
): string[] {
  const pinned = pinId ? candidates.find((candidate) => candidate.id === pinId) : undefined
  return pinned?.source === 'lets_encrypt' ? hosting.hostnames : hostingCertificateNames(hosting)
}

/**
 * The refusal for a pin that cannot serve the hosting. When the certificate
 * covers the typed names and only misses names the www choice adds, say so in
 * plain words, naming exactly the missing ones.
 */
function tlsPinErrorResponse(
  error: Parameters<typeof tlsPinErrorCode>[0],
  hostingId: string,
  pinned: OrgTlsCandidate | undefined,
  hosting: Readonly<{ hostnames: string[]; www: HostingWwwMode }>
): Response {
  const dnsNames = pinned?.metadata.dnsNames ?? []
  const typedCovered = coversAllHostnames(dnsNames, hosting.hostnames)
  const missing = hostingCertificateNames(hosting).filter(
    (name) => !coversAllHostnames(dnsNames, [name])
  )
  const message =
    error === 'pin_mismatch' && typedCovered && missing.length > 0
      ? `The certificate on this hosting covers ${hosting.hostnames.join(', ')} but not ${missing.join(', ')}, which its www setting adds. Upload one that lists every name, or set www to "Only ${hosting.hostnames.join(', ')}".`
      : undefined
  return Response.json(
    { error: tlsPinErrorCode(error), hostingId, ...(message ? { message } : {}) },
    { status: 400 }
  )
}

async function resolveHttpHostingEntry(
  db: Db,
  h: HostingRow,
  svc: Readonly<{ id: string; composeServiceName: string }>,
  candidates: OrgTlsCandidate[],
  serverId: string,
  acmeEnabled: boolean
): Promise<
  | { entry: DeployHostingPayload }
  | { skip: true }
  | { error: Response }
  | { prepareError: DeployPrepareError }
> {
  const hostnames = readHostnames(h.options)
  if (hostnames.length === 0) return { skip: true }
  const www = readWwwMode(h.options)

  // A revoked Let's Encrypt pin resolves as internal (`tlsId: null`) here —
  // do not treat it as `tls_pin_not_ready`. Deleted / mismatched pins still fail.
  const resolved = resolveTlsForHosting({
    pinId: h.tlsId,
    hostnames: pinCoverageNames(h.tlsId, candidates, { hostnames, www }),
    candidates,
  })
  if (!resolved.ok) {
    const pinned = candidates.find((candidate) => candidate.id === h.tlsId)
    return { error: tlsPinErrorResponse(resolved.error, h.id, pinned, { hostnames, www }) }
  }

  const bindScope = resolveHostingBind(parseHostingOptions(h.options))
  const pinned = resolved.tlsId
    ? candidates.find((candidate) => candidate.id === resolved.tlsId)
    : undefined
  const tlsWire = hostingTlsWireFromResolved({
    tlsId: resolved.tlsId,
    status: pinned?.metadata.status,
    bindScope,
    acmeEnabled,
  })
  if (!tlsWire.ok) {
    return {
      error: Response.json(
        { error: tlsWire.error, hostingId: h.id },
        {
          status: 400,
        }
      ),
    }
  }

  const bindResolved = await resolveHostingBindAddress(db, {
    serverId,
    options: h.options,
    ipId: h.ipId,
  })
  if (typeof bindResolved === 'object' && bindResolved !== null && 'kind' in bindResolved) {
    return { prepareError: bindResolved }
  }

  const web = await resolveHostingDeployWeb(db, h.id, h.options)

  return {
    entry: {
      hostingId: h.id,
      serviceId: svc.id,
      composeServiceName: svc.composeServiceName,
      hostnames,
      pathPrefix: readPathPrefix(h.options),
      targetPort: readTargetPort(h.options),
      tlsId: tlsWire.tlsId,
      ...(tlsWire.tlsMode === undefined ? {} : { tlsMode: tlsWire.tlsMode }),
      proxy: readHostingProxyFromOptions(h.options),
      ...(www === 'off' ? {} : { www }),
      ...(bindResolved === undefined ? {} : { bindAddress: bindResolved }),
      ...(web === undefined ? {} : { web }),
    },
  }
}

/**
 * `tcp` / `udp` hosting publishes raw port(s) straight through Traefik — no
 * hostname/TLS routing, used for non-HTTP docker services (e.g. Postgres).
 */
async function resolveTcpUdpHostingEntry(
  db: Db,
  h: HostingRow,
  svc: Readonly<{ id: string; composeServiceName: string }>,
  protocol: 'tcp' | 'udp',
  serverId: string
): Promise<
  | { entry: DeployHostingPayload }
  | { skip: true }
  | {
      prepareError: DeployPrepareError
    }
> {
  const ports = readHostingPorts(h.options)
  if (ports.length === 0) return { skip: true }

  const bindResolved = await resolveHostingBindAddress(db, {
    serverId,
    options: h.options,
    ipId: h.ipId,
  })
  if (typeof bindResolved === 'object' && bindResolved !== null && 'kind' in bindResolved) {
    return { prepareError: bindResolved }
  }

  return {
    entry: {
      hostingId: h.id,
      serviceId: svc.id,
      composeServiceName: svc.composeServiceName,
      hostnames: [],
      protocol,
      ports,
      ...(bindResolved === undefined ? {} : { bindAddress: bindResolved }),
    },
  }
}

function resolveHostingEntry(
  db: Db,
  h: HostingRow,
  svc: Readonly<{ id: string; composeServiceName: string }>,
  candidates: OrgTlsCandidate[],
  serverId: string,
  acmeEnabled: boolean
): Promise<
  | { entry: DeployHostingPayload }
  | { skip: true }
  | { error: Response }
  | { prepareError: DeployPrepareError }
> {
  const protocol = readHostingProtocol(h.options)
  if (protocol === 'http') {
    return resolveHttpHostingEntry(db, h, svc, candidates, serverId, acmeEnabled)
  }
  return resolveTcpUdpHostingEntry(db, h, svc, protocol, serverId)
}

async function loadOrgTlsCandidates(db: Db, organizationId: string): Promise<OrgTlsCandidate[]> {
  const rows = await db
    .select({
      id: tls.id,
      source: tls.source,
      status: tls.status,
      notAfter: tls.notAfter,
      fingerprintSha256: tls.fingerprintSha256,
      metadata: tls.metadata,
      options: tls.options,
      certificatePem: tls.certificatePem,
      privateKeyPem: tls.privateKeyPem,
    })
    .from(tls)
    .where(eq(tls.organizationId, organizationId))

  const out: OrgTlsCandidate[] = []
  for (const row of rows) {
    const metadata = assembleTlsMetadata(
      {
        status: row.status,
        notAfter: row.notAfter,
        fingerprintSha256: row.fingerprintSha256,
      },
      row.metadata
    )
    if (!metadata) continue
    out.push({
      id: row.id,
      metadata,
      options: parseTlsOptions(row.options),
      ...(isTlsSource(row.source) ? { source: row.source } : {}),
      certificatePem: row.certificatePem,
      privateKeyPem: row.privateKeyPem,
    })
  }
  return out
}

async function buildHostingsForService(
  db: Db,
  svc: HostingServiceRow,
  candidates: OrgTlsCandidate[],
  serverId: string,
  acmeEnabled: boolean
): Promise<
  | { hostings: DeployHostingPayload[]; tlsIds: string[] }
  | { error: Response }
  | { prepareError: DeployPrepareError }
> {
  const composeServiceName = svc.composeServiceName
  const hostingRows = await db
    .select({
      id: hosting.id,
      options: hosting.options,
      tlsId: hosting.tlsId,
      ipId: hosting.ipId,
    })
    .from(hosting)
    .where(eq(hosting.serviceId, svc.id))

  const hostings: DeployHostingPayload[] = []
  const tlsIds: string[] = []
  for (const h of hostingRows) {
    const result = await resolveHostingEntry(
      db,
      h,
      { id: svc.id, composeServiceName },
      candidates,
      serverId,
      acmeEnabled
    )
    if ('skip' in result) continue
    if ('error' in result) return result
    if ('prepareError' in result) return result
    hostings.push(result.entry)
    if (result.entry.tlsId && result.entry.tlsMode !== 'acme') {
      tlsIds.push(result.entry.tlsId)
    }
  }
  return { hostings, tlsIds }
}

async function buildHostingPayload(
  db: Db,
  environmentId: string,
  organizationId: string,
  serverId: string
): Promise<BuildHostingResult> {
  const serviceRows = await db
    .select({
      id: service.id,
      composeServiceName: service.composeServiceName,
    })
    .from(service)
    .where(eq(service.environmentId, environmentId))

  const candidates = await loadOrgTlsCandidates(db, organizationId)
  const [orgRow] = await db
    .select({ options: organization.options })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  const acmeEnabled = resolveAcmeEnabled(parseOrganizationOptions(orgRow?.options))
  const hostingPayload: DeployHostingPayload[] = []
  const resolvedTlsIds = new Set<string>()

  for (const svc of serviceRows) {
    const built = await buildHostingsForService(db, svc, candidates, serverId, acmeEnabled)
    if ('error' in built) return built
    if ('prepareError' in built) return built
    hostingPayload.push(...built.hostings)
    for (const tlsId of built.tlsIds) resolvedTlsIds.add(tlsId)
  }

  return { hostings: hostingPayload, resolvedTlsIds: [...resolvedTlsIds] }
}

async function sealTlsMaterialForDaemon(
  c: Context<AppEnv>,
  db: Db,
  serverId: string,
  organizationId: string,
  tlsIds: string[]
): Promise<EnvironmentDeployTlsMaterial[] | Response> {
  // `managed` / `tlsMode: 'acme'` ids are excluded from `tlsIds` by
  // `buildHostingsForService` — this set is only PEM-backed pins.
  if (tlsIds.length === 0) return []

  const dataEncryptionSecrets = c.get('dataEncryptionSecrets')
  const secretsConfig = c.get('secretsConfig')
  if (!dataEncryptionSecrets || !secretsConfig) {
    return c.json(
      {
        error: 'Encryption unavailable — no encryption key configured',
      },
      503
    )
  }

  const daemonState = await getServerDaemonStateByServerId(db, serverId)
  if (!daemonState || !isDaemonKeyActive(daemonState.key)) {
    return c.json(
      {
        error: 'No encryption-capable daemon key on target server',
      },
      422
    )
  }
  const keyId = daemonState.key.id

  const rows = await db
    .select({
      id: tls.id,
      certificatePem: tls.certificatePem,
      privateKeyPem: tls.privateKeyPem,
      organizationId: tls.organizationId,
    })
    .from(tls)
    .where(and(eq(tls.organizationId, organizationId)))

  const byId = new Map(rows.map((row) => [row.id, row]))
  const material: EnvironmentDeployTlsMaterial[] = []

  for (const tlsId of tlsIds) {
    const row = byId.get(tlsId)
    if (!row?.certificatePem || !row.privateKeyPem) {
      return c.json({ error: 'tls_material_missing', tlsId }, 400)
    }
    // Refuse plaintext / non-tpsecret rows — keys must be sealed at rest.
    if (
      !row.privateKeyPem.startsWith(`${ENVELOPE_MAGIC}.`) ||
      row.privateKeyPem.includes('BEGIN')
    ) {
      return c.json({ error: 'tls_key_not_sealed', tlsId }, 500)
    }
    let privateKeyEnvelope: string
    try {
      privateKeyEnvelope = await resealSecretForDaemon(
        secretsConfig,
        dataEncryptionSecrets,
        { serverId, keyId },
        row.privateKeyPem
      )
    } catch {
      return c.json({ error: 'tls_decrypt_failed', tlsId }, 500)
    }
    material.push({
      tlsId,
      certificatePem: row.certificatePem,
      privateKeyEnvelope,
    })
  }

  return material
}

type ResolvedHostingIngress = {
  /** HTTP proxy identity — set only when an HTTP hosting actually routes. */
  hostingIngress?: EnvironmentDeployIngressService
  /**
   * Shared ingress Docker network / compose project name: the same
   * `hosting-ingress` component `serviceId`. Set whenever this deploy carries
   * hostings at all — a tcp/udp-only deploy has no HTTP proxy identity but its
   * per-service Traefik still joins this network.
   */
  hostingIngressNetwork?: string
}

async function resolveSharedHttpHostingIngress(
  db: Db,
  organizationId: string,
  serverId: string,
  hostings: readonly DeployHostingPayload[]
): Promise<ResolvedHostingIngress> {
  if (hostings.length === 0) return {}
  const hierarchy = await ensureSystemHierarchy(db, {
    organizationId,
    serverId,
  })
  // The network name is the component's own serviceId — never a literal.
  const resolved: ResolvedHostingIngress = {
    hostingIngressNetwork: hierarchy.serviceId,
  }
  if (!hostingsNeedSharedHttpIngress(hostings)) return resolved
  return {
    ...resolved,
    hostingIngress: {
      serviceId: hierarchy.serviceId,
      composeServiceName: SYSTEM_TRAEFIK_COMPOSE_SERVICE_NAME,
      containerName: hierarchy.containerName,
    },
  }
}

/**
 * The edge fields of {@link ServerDeployment}, compiled for one server.
 *
 * Returned as its own object only so the assembly below stays readable; every
 * field lands on the prepared deployment unchanged.
 */
type ServerEdgeDeployment = Pick<
  ServerDeployment,
  'hostings' | 'tlsMaterial' | 'listenerPorts' | 'hostingIngress' | 'hostingIngressNetwork'
>

/**
 * Compile the edge: routes, certificates, shared ingress, listener ports.
 *
 * **Preview compiles no edge.** It is the same rule the rest of prepare already
 * follows — `toPreparedDeployResult` empties `variableMaterial` and
 * `storageMaterial` for a preview because a dry run must not mint daemon-
 * readable secrets — and the edge is where the sharpest two of both kinds live:
 * a sealed TLS private key, and `ensureSystemHierarchy`, which *provisions* the
 * shared hosting-ingress project for a server. Neither belongs to a request
 * that publishes nothing. Listener ports are read anyway: they are a plain
 * organization setting, and reporting the shape a deploy would take is exactly
 * what preview is for.
 */
async function compileServerEdgeDeployment(
  c: Context<AppEnv>,
  db: Db,
  params: {
    mode: DeployPrepareMode
    environmentId: string
    organizationId: string
    /** Owner of the target host; falls back to the requesting organization. */
    serverOrganizationId?: string
    serverId: string
    /** Final compose expansion, so a clone routes like the key it came from. */
    expansion: Record<string, string[]>
    storageMaterial: EnvironmentDeployStorageMaterial[]
  }
): Promise<ServerEdgeDeployment | DeployPrepareError | Response> {
  // Scoped to the server's owner, matching the ProxySQL frontend the joining
  // services dial — the same rule `managedNetwork` follows above.
  const listenerPorts = await loadManagedIngressPorts(
    db,
    params.serverOrganizationId ?? params.organizationId
  )
  if (params.mode === 'preview') {
    return { hostings: [], tlsMaterial: [], listenerPorts }
  }

  const built = await buildHostingPayload(
    db,
    params.environmentId,
    params.organizationId,
    params.serverId
  )
  if ('prepareError' in built) return built.prepareError
  if ('error' in built) return built.error

  const sealedHostings = await sealHostingWebSecretsForDaemon(
    c,
    db,
    params.serverId,
    built.hostings
  )
  if (sealedHostings instanceof Response) return sealedHostings
  const hostings = expandHostingsForComposeInstances(sealedHostings, params.expansion)
  const tlsMaterial = await sealTlsMaterialForDaemon(
    c,
    db,
    params.serverId,
    params.organizationId,
    built.resolvedTlsIds
  )
  if (tlsMaterial instanceof Response) return tlsMaterial

  // Both halves at once: a route and the storage it serves from are validated
  // against each other, so this cannot move to either side alone.
  const materialsError = deployMaterialsErrorResponse(hostings, params.storageMaterial)
  if (materialsError) return materialsError

  const { hostingIngress, hostingIngressNetwork } = await resolveSharedHttpHostingIngress(
    db,
    params.organizationId,
    params.serverId,
    hostings
  )

  return {
    hostings,
    tlsMaterial,
    listenerPorts,
    ...(hostingIngress ? { hostingIngress } : {}),
    ...(hostingIngressNetwork ? { hostingIngressNetwork } : {}),
  }
}

export function readHostingProxyFromOptions(options: unknown): EnvironmentDeployHosting['proxy'] {
  if (!isPlainObject(options)) return undefined
  const proxy = resolveHostingProxy({
    proxy: isPlainObject(options.proxy) ? options.proxy : undefined,
  })
  return {
    forceHttps: proxy.forceHttps,
    gzip: proxy.gzip,
    brotli: proxy.brotli,
    ...(proxy.stripPrefix ? { stripPrefix: proxy.stripPrefix } : {}),
  }
}

/**
 * Resolve the Caddy `bind` address for one hosting entry at deploy-prepare time
 * so the daemon stays DB-free. Returns `undefined` when no bind directive should
 * be emitted (public bind with no pinned IP).
 */
export async function resolveHostingBindAddress(
  db: Db,
  params: Readonly<{
    serverId: string
    options: unknown
    ipId: string | null
  }>
): Promise<string | undefined | Extract<DeployPrepareError, { kind: 'datacenter_ip_required' }>> {
  const bind = resolveHostingBind(parseHostingOptions(params.options))

  if (bind === 'local') return '127.0.0.1'

  if (bind === 'datacenter') {
    const address = await loadServerDatacenterAddress(db, params.serverId)
    if (!address) {
      return { kind: 'datacenter_ip_required', serverId: params.serverId }
    }
    return address
  }

  // public (default)
  if (!params.ipId) return undefined

  const [row] = await db
    .select({ address: ip.address, serverId: ip.serverId })
    .from(ip)
    .where(eq(ip.id, params.ipId))
    .limit(1)
  if (!row) {
    throw new Error('hosting ip pin not found')
  }
  if (row.serverId !== null && row.serverId !== params.serverId) {
    throw new Error('hosting ip pin server mismatch')
  }
  const address = inetAddressToString(row.address)
  if (!address) {
    throw new Error('hosting ip pin address invalid')
  }
  return address
}

export { extractComposeFromOptions }

/** Pure helpers exported for host-free unit coverage of prepare gates. */
export {
  absorbSoftPrepareError,
  buildCloneNamesByServiceId,
  buildExpandedServiceOptionsMap,
  buildInstancesByComposeName,
  buildServiceRowByCloneName,
  compileRuntimeOptionsForServer,
  documentForServiceOptions,
  emptyComposePrepareResult,
  emptyPreparedCompose,
  evaluateHealthCheckGates,
  expansionToRecord,
  fabricNetworksFromSchedule,
  healthCheckAcknowledge,
  listComposeServiceKeys,
  listContainerComposeNames,
  localManagedNetworkServiceNames,
  mapResolvedScopesToDeployEntries,
  nativeAppServicesForDeploy,
  nativeAppVariableViews,
  nativeComposeServiceNames,
  resolveNativeAppVariables,
  resolveSitesForMode,
  resourceLimitPrepareError,
  sitesOnScheduledServer,
  splitHostNativeFromDocument,
  stripReservedKeysFromEntries,
  tagVariableSources,
  toApplyVariablesPrepareError,
  toPreparedDeployResult,
  warningFromPrepareError,
}

// Re-export layer builders used by prepare for host-free coverage imports.
export {
  environmentComposeFilename,
  PROJECT_COMPOSE_FILENAME,
  renderRuntimeComposeFiles,
  RUNTIME_COMPOSE_FILENAME,
} from '../../features/deploy/deploy-layers.ts'
