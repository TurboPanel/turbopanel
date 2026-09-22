/**
 * Compile a parsed `docker run` into a single-service {@link ComposeDocument}.
 *
 * Two rules shape everything in here.
 *
 * **Standard Compose vocabulary only.** The output is an ordinary compose
 * document that the existing five-stage pipeline (`../compose/`) validates like
 * any other authored one. Nothing is written under `x-turbopanel`, and there is
 * no `dockerRunArgs` field kept anywhere — a second persisted format for "what
 * the operator originally pasted" would be a format that drifts from the
 * document actually deployed, and a reader would have no way to tell which one
 * the running container came from.
 *
 * **Nothing is dropped in silence.** A flag the compiler cannot express becomes
 * a diagnostic naming it, the same posture `../compose/field-policy.ts` takes
 * for compose fields. `operational` flags produce a non-blocking note (they
 * describe the CLI invocation, so losing them changes nothing that runs) and
 * `unsupported` ones a blocking diagnostic (they describe the container, and
 * importing around them would deploy something the operator did not ask for).
 */

import {
  type ComposeDocument,
  emptyComposeDocument,
} from '../compose/types.ts'
import { dockerRunOptionName } from './option-registry.ts'
import type {
  DockerRunDiagnostic,
  DockerRunParseEntry,
  ParsedDockerRun,
} from './parse.ts'

/** Stable slug for a class of blast-radius widening. */
export type DockerRunRiskKind =
  | 'privileged'
  | 'capability_add'
  | 'device_passthrough'
  | 'device_cgroup_rule'
  | 'pid_namespace'
  | 'ipc_namespace'
  | 'host_network'
  | 'user_namespace'
  | 'cgroup_namespace'
  | 'security_option'
  | 'docker_api_socket'
  | 'host_bind_mount'

export type DockerRunRiskFlag = {
  kind: DockerRunRiskKind
  /** The flag and value that raised it, exactly as authored. */
  source: string
  /** Why it matters — rendered verbatim to the operator. */
  message: string
}

export type DockerRunComposeResult = {
  compose: ComposeDocument
  diagnostics: DockerRunDiagnostic[]
  riskFlags: DockerRunRiskFlag[]
}

export type DockerRunComposeOptions = {
  /** Compose service key the imported container becomes. */
  serviceName: string
}

/** Compose network keys are `^[a-zA-Z0-9._-]+$`; docker network names are looser. */
const COMPOSE_NETWORK_KEY_RE = /^[a-zA-Z0-9._-]+$/

/** Canonical flag → Compose service key, for plain string scalars. */
const STRING_FIELDS: Readonly<Record<string, string>> = {
  '--cgroup-parent': 'cgroup_parent',
  '--cgroupns': 'cgroup',
  '--cpuset-cpus': 'cpuset',
  '--domainname': 'domainname',
  '--entrypoint': 'entrypoint',
  '--hostname': 'hostname',
  '--ipc': 'ipc',
  '--isolation': 'isolation',
  '--memory': 'mem_limit',
  '--memory-reservation': 'mem_reservation',
  '--memory-swap': 'memswap_limit',
  '--name': 'container_name',
  '--pid': 'pid',
  '--platform': 'platform',
  '--pull': 'pull_policy',
  '--restart': 'restart',
  '--runtime': 'runtime',
  '--shm-size': 'shm_size',
  '--stop-signal': 'stop_signal',
  '--user': 'user',
  '--userns': 'userns_mode',
  '--uts': 'uts',
  '--workdir': 'working_dir',
}

/** Canonical flag → Compose service key, for numeric scalars. */
const NUMBER_FIELDS: Readonly<Record<string, string>> = {
  '--cpu-period': 'cpu_period',
  '--cpu-quota': 'cpu_quota',
  '--cpu-rt-period': 'cpu_rt_period',
  '--cpu-rt-runtime': 'cpu_rt_runtime',
  '--cpu-shares': 'cpu_shares',
  '--cpus': 'cpus',
  '--memory-swappiness': 'mem_swappiness',
  '--oom-score-adj': 'oom_score_adj',
  '--pids-limit': 'pids_limit',
}

/** Canonical flag → Compose service key, for sequence fields. */
const LIST_FIELDS: Readonly<Record<string, string>> = {
  '--add-host': 'extra_hosts',
  '--annotation': 'annotations',
  '--cap-add': 'cap_add',
  '--cap-drop': 'cap_drop',
  '--device': 'devices',
  '--device-cgroup-rule': 'device_cgroup_rules',
  '--dns': 'dns',
  '--dns-option': 'dns_opt',
  '--dns-search': 'dns_search',
  '--env': 'environment',
  '--env-file': 'env_file',
  '--expose': 'expose',
  '--group-add': 'group_add',
  '--label': 'labels',
  '--label-file': 'label_file',
  '--publish': 'ports',
  '--security-opt': 'security_opt',
  '--sysctl': 'sysctls',
  '--tmpfs': 'tmpfs',
  '--volume': 'volumes',
  '--volumes-from': 'volumes_from',
}

/** Canonical flag → Compose service key, for booleans. */
const BOOLEAN_FIELDS: Readonly<Record<string, string>> = {
  '--init': 'init',
  '--interactive': 'stdin_open',
  '--oom-kill-disable': 'oom_kill_disable',
  '--privileged': 'privileged',
  '--read-only': 'read_only',
  '--tty': 'tty',
  '--use-api-socket': 'use_api_socket',
}

/** Canonical flag → `blkio_config` list key. */
const BLKIO_LIMIT_FIELDS: Readonly<Record<string, string>> = {
  '--device-read-bps': 'device_read_bps',
  '--device-read-iops': 'device_read_iops',
  '--device-write-bps': 'device_write_bps',
  '--device-write-iops': 'device_write_iops',
}

/** Canonical flag → `healthcheck` key, for the duration/count options. */
const HEALTHCHECK_FIELDS: Readonly<Record<string, string>> = {
  '--health-interval': 'interval',
  '--health-start-interval': 'start_interval',
  '--health-start-period': 'start_period',
  '--health-timeout': 'timeout',
}

/** Which risk a flag raises, when it raises one unconditionally. */
const RISK_KINDS: Readonly<Record<string, DockerRunRiskKind>> = {
  '--privileged': 'privileged',
  '--cap-add': 'capability_add',
  '--device': 'device_passthrough',
  '--device-cgroup-rule': 'device_cgroup_rule',
  '--pid': 'pid_namespace',
  '--ipc': 'ipc_namespace',
  '--userns': 'user_namespace',
  '--cgroupns': 'cgroup_namespace',
  '--security-opt': 'security_option',
  '--use-api-socket': 'docker_api_socket',
}

/** Docker socket paths worth naming as their own risk rather than a bind mount. */
const DOCKER_SOCKET_PATHS = new Set([
  '/var/run/docker.sock',
  '/run/docker.sock',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toNumber(raw: string): number | null {
  if (!/^-?\d+(\.\d+)?$/.test(raw.trim())) return null
  const parsed = Number(raw.trim())
  return Number.isFinite(parsed) ? parsed : null
}

/** Docker booleans: bare flag means true; `=false` / `=0` mean false. */
function toBoolean(value: string | null): boolean {
  if (value === null || value === '') return true
  const normalized = value.trim().toLowerCase()
  return normalized !== 'false' && normalized !== '0' && normalized !== 'no'
}

/**
 * A `-v` source that names a host path rather than a named volume.
 *
 * Docker's own rule: anything containing a path separator is a bind mount, a
 * bare name is a volume. Windows drive letters are matched too, because a
 * pasted command is as likely to have come from a Windows README as anywhere.
 */
function isHostPathSource(source: string): boolean {
  return source.startsWith('/') || source.startsWith('./') ||
    source.startsWith('../') || source.startsWith('~') ||
    /^[A-Za-z]:[\\/]/.test(source)
}

/** Split `-v` short syntax, tolerating the Windows `C:\x:/y` drive colon. */
function splitVolumeSpec(spec: string): string[] {
  const parts: string[] = []
  let current = ''
  for (const char of spec) {
    if (char === ':') {
      // `C:` at the start of a segment is a drive letter, not a separator.
      if (current.length === 1 && /[A-Za-z]/.test(current) && parts.length === 0) {
        current += char
        continue
      }
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)
  return parts
}

/**
 * Parse `key=value,key2=value2` — Docker's `--mount` / `--gpus` CSV form.
 *
 * `continuesPreviousValue` decides what a comma-separated chunk with no `=`
 * means, and the two callers genuinely disagree. In `--mount` a bare chunk is a
 * valueless flag (`readonly`, `ro`). In `--gpus` it is the tail of a
 * comma-separated list (`device=0,1`, `capabilities=compute,utility`), so it
 * belongs to the key before it.
 */
function parseCsvOptions(
  raw: string,
  continuesPreviousValue = false,
): Map<string, string> {
  const options = new Map<string, string>()
  let lastKey: string | null = null
  for (const chunk of raw.split(',')) {
    const trimmed = chunk.trim()
    if (!trimmed) continue
    const equals = trimmed.indexOf('=')
    if (equals === -1) {
      if (continuesPreviousValue && lastKey !== null) {
        options.set(lastKey, `${options.get(lastKey) ?? ''},${trimmed}`)
        continue
      }
      options.set(trimmed.toLowerCase(), '')
      lastKey = trimmed.toLowerCase()
      continue
    }
    const key = trimmed.slice(0, equals).trim().toLowerCase()
    options.set(key, trimmed.slice(equals + 1).trim())
    lastKey = key
  }
  return options
}

class ComposeServiceBuilder {
  readonly service: Record<string, unknown> = {}

  setScalar(key: string, value: unknown) {
    this.service[key] = value
  }

  appendList(key: string, value: unknown) {
    const existing = this.service[key]
    if (Array.isArray(existing)) {
      existing.push(value)
      return
    }
    this.service[key] = [value]
  }

  nested(key: string): Record<string, unknown> {
    const existing = this.service[key]
    if (isRecord(existing)) return existing
    const created: Record<string, unknown> = {}
    this.service[key] = created
    return created
  }

  nestedList(parentKey: string, key: string): unknown[] {
    const parent = this.nested(parentKey)
    const existing = parent[key]
    if (Array.isArray(existing)) return existing
    const created: unknown[] = []
    parent[key] = created
    return created
  }
}

type CompileState = {
  readonly diagnostics: DockerRunDiagnostic[]
  readonly riskFlags: DockerRunRiskFlag[]
  readonly builder: ComposeServiceBuilder
  /** Named volumes referenced by `-v` / `--mount`, in first-seen order. */
  readonly namedVolumes: string[]
  /** `--volume-driver`, applied to every named volume this service declares. */
  volumeDriver: string | null
  /** Attachment attributes accumulated from `--network-alias`, `--ip`, … */
  readonly networkAttachment: Record<string, unknown>
  networkKey: string | null
  networkMode: string | null
}

function note(
  state: CompileState,
  code: DockerRunDiagnostic['code'],
  flag: string,
  message: string,
  blocking = false,
) {
  state.diagnostics.push({ code, flag, message, blocking })
}

function raiseRisk(
  state: CompileState,
  kind: DockerRunRiskKind,
  source: string,
  message: string,
) {
  if (
    state.riskFlags.some((flag) => flag.kind === kind && flag.source === source)
  ) {
    return
  }
  state.riskFlags.push({ kind, source, message })
}

function sourceOf(entry: DockerRunParseEntry): string {
  return entry.value === null ? entry.rawFlag : `${entry.rawFlag} ${entry.value}`
}

function registerNamedVolume(state: CompileState, name: string) {
  if (!state.namedVolumes.includes(name)) state.namedVolumes.push(name)
}

/**
 * Compile `parsed` into a one-service compose document.
 *
 * Always returns a document, even when a blocking diagnostic is present, so a
 * caller can show the operator what *would* have been imported alongside the
 * reason it was refused. Deciding whether a blocking diagnostic ends the
 * request belongs to the caller (see `src/client/docker-run/routes.ts`), the
 * same split the compose linter uses between `lintComposeYaml` and
 * `blockingComposeLintIssues`.
 */
export function dockerRunToComposeDocument(
  parsed: ParsedDockerRun,
  options: DockerRunComposeOptions,
): DockerRunComposeResult {
  const state: CompileState = {
    diagnostics: [...parsed.diagnostics],
    riskFlags: [],
    builder: new ComposeServiceBuilder(),
    namedVolumes: [],
    volumeDriver: null,
    networkAttachment: {},
    networkKey: null,
    networkMode: null,
  }

  for (const entry of parsed.entries) {
    compileEntry(state, entry)
  }

  if (parsed.image) {
    state.builder.setScalar('image', parsed.image)
  }
  if (parsed.command.length > 0) {
    state.builder.setScalar('command', [...parsed.command])
  }

  const topLevelNetworks = buildTopLevelNetworks(state)
  const topLevelVolumes = buildTopLevelVolumes(state)

  const data: Record<string, unknown> = {
    services: { [options.serviceName]: state.builder.service },
  }
  const keyOrder = ['services']
  if (Object.keys(topLevelNetworks).length > 0) {
    data.networks = topLevelNetworks
    keyOrder.push('networks')
  }
  if (Object.keys(topLevelVolumes).length > 0) {
    data.volumes = topLevelVolumes
    keyOrder.push('volumes')
  }

  const compose: ComposeDocument = {
    ...emptyComposeDocument(),
    data,
    presentation: { keyOrder, comments: {} },
  }

  return {
    compose,
    diagnostics: state.diagnostics,
    riskFlags: state.riskFlags,
  }
}

function compileEntry(state: CompileState, entry: DockerRunParseEntry) {
  const flag = dockerRunOptionName(entry.definition)
  const value = entry.value

  if (entry.definition.behavior === 'operational') {
    note(
      state,
      'operational_option_ignored',
      entry.rawFlag,
      `"${flag}" was not imported — ${
        entry.definition.reason ?? 'it configures the CLI invocation, not the container'
      }.`,
    )
    return
  }

  if (entry.definition.behavior === 'unsupported') {
    note(
      state,
      'option_unsupported',
      entry.rawFlag,
      `"${flag}" is not supported — ${
        entry.definition.reason ?? 'TurboPanel has no behavior for it'
      }.`,
      true,
    )
    return
  }

  raiseUnconditionalRisk(state, entry, flag)

  if (flag in BOOLEAN_FIELDS) {
    state.builder.setScalar(BOOLEAN_FIELDS[flag]!, toBoolean(value))
    return
  }

  // A boolean that maps onto a *nested* field rather than a service key of
  // its own, so it has to be handled before the missing-value guard below.
  if (flag === '--no-healthcheck') {
    state.builder.nested('healthcheck').disable = toBoolean(value)
    return
  }

  if (value === null) {
    compileValuelessEntry(state, entry, flag)
    return
  }

  if (compileMappedField(state, entry, flag, value)) return
  compileSpecialFlag(state, entry, flag, value)
}

/**
 * Unconditional risks. The conditional ones (`--network host`, host bind
 * mounts) are raised inside their own branches, where the value is known.
 */
function raiseUnconditionalRisk(
  state: CompileState,
  entry: DockerRunParseEntry,
  flag: string,
) {
  const riskKind = RISK_KINDS[flag]
  const risk = entry.definition.risk
  if (!riskKind || !risk) return
  const isBoolean = flag in BOOLEAN_FIELDS
  if (!isBoolean || toBoolean(entry.value)) {
    raiseRisk(state, riskKind, sourceOf(entry), risk)
  }
}

function compileValuelessEntry(
  state: CompileState,
  entry: DockerRunParseEntry,
  flag: string,
) {
  if (entry.definition.value === 'required') {
    note(
      state,
      'missing_option_value',
      entry.rawFlag,
      `"${flag}" arrived without a value and was not imported.`,
      true,
    )
    return
  }
  // A boolean the compiler has no branch for. Same answer as the `default:`
  // arm below — say so rather than let it look like a parse failure.
  note(
    state,
    'option_value_unparsed',
    entry.rawFlag,
    `"${flag}" is classified as importable but has no compose mapping yet, so it was not imported.`,
    true,
  )
}

/** The table-driven mappings; returns `false` when `flag` is in none of them. */
function compileMappedField(
  state: CompileState,
  entry: DockerRunParseEntry,
  flag: string,
  value: string,
): boolean {
  if (flag in STRING_FIELDS) {
    if (value.length > 0) state.builder.setScalar(STRING_FIELDS[flag]!, value)
    return true
  }

  if (flag in NUMBER_FIELDS) {
    // Docker accepts suffixed sizes (`--cpus 0.5` is a number, `-m 512m` is
    // not); the Compose schema accepts a string for all of these, so an
    // unparseable value is carried through rather than refused.
    state.builder.setScalar(NUMBER_FIELDS[flag]!, toNumber(value) ?? value)
    return true
  }

  if (flag in LIST_FIELDS) {
    if (flag === '--volume') {
      importVolumeShortSyntax(state, value, entry)
    } else {
      state.builder.appendList(LIST_FIELDS[flag]!, value)
    }
    return true
  }

  if (flag in HEALTHCHECK_FIELDS) {
    state.builder.nested('healthcheck')[HEALTHCHECK_FIELDS[flag]!] = value
    return true
  }

  if (flag in BLKIO_LIMIT_FIELDS) {
    importBlkioLimit(state, entry, flag, value)
    return true
  }

  return false
}

function compileSpecialFlag(
  state: CompileState,
  entry: DockerRunParseEntry,
  flag: string,
  value: string,
) {
  switch (flag) {
    case '--health-cmd': {
      // `docker run --health-cmd` is always shell-evaluated by the daemon,
      // which is exactly CMD-SHELL. Using CMD here would change the check.
      state.builder.nested('healthcheck').test = ['CMD-SHELL', value]
      break
    }
    case '--health-retries': {
      state.builder.nested('healthcheck').retries = toNumber(value) ?? value
      break
    }
    case '--stop-timeout': {
      const seconds = toNumber(value)
      // Compose expresses this as a duration string, not a bare second count.
      state.builder.setScalar(
        'stop_grace_period',
        seconds === null ? value : `${seconds}s`,
      )
      break
    }
    case '--log-driver': {
      state.builder.nested('logging').driver = value
      break
    }
    case '--log-opt': {
      importLogOpt(state, entry, value)
      break
    }
    case '--storage-opt': {
      importStorageOpt(state, entry, value)
      break
    }
    case '--blkio-weight': {
      state.builder.nested('blkio_config').weight = toNumber(value) ?? value
      break
    }
    case '--blkio-weight-device': {
      importBlkioWeightDevice(state, entry, value)
      break
    }
    case '--ulimit': {
      importUlimitFlag(state, entry, value)
      break
    }
    case '--gpus': {
      importGpus(state.builder, value)
      break
    }
    case '--mount': {
      importMount(state, value, entry)
      break
    }
    case '--network': {
      importNetworkFlag(state, entry, value)
      break
    }
    case '--network-alias': {
      appendAttachmentList(state, 'aliases', value)
      break
    }
    case '--ip': {
      state.networkAttachment.ipv4_address = value
      break
    }
    case '--ip6': {
      state.networkAttachment.ipv6_address = value
      break
    }
    case '--link-local-ip': {
      appendAttachmentList(state, 'link_local_ips', value)
      break
    }
    case '--mac-address': {
      state.networkAttachment.mac_address = value
      break
    }
    case '--volume-driver': {
      state.volumeDriver = value
      break
    }
    case '--link': {
      state.builder.appendList('links', value)
      note(
        state,
        'option_value_unparsed',
        entry.rawFlag,
        'Container links became a Compose links: entry. Links are legacy Docker networking — a shared network with service-name DNS is the supported replacement.',
      )
      break
    }
    default: {
      // A `compose`/`transform` flag with no branch here is a registry entry
      // the compiler has not caught up with. Say so rather than drop it.
      note(
        state,
        'option_value_unparsed',
        entry.rawFlag,
        `"${flag}" is classified as importable but has no compose mapping yet, so it was not imported.`,
        true,
      )
    }
  }
}

function importBlkioLimit(
  state: CompileState,
  entry: DockerRunParseEntry,
  flag: string,
  value: string,
) {
  const limit = parseBlkioLimit(value)
  if (!limit) {
    note(
      state,
      'option_value_unparsed',
      entry.rawFlag,
      `"${flag} ${value}" is not in Docker's <path>:<rate> form and was not imported.`,
    )
    return
  }
  state.builder.nestedList('blkio_config', BLKIO_LIMIT_FIELDS[flag]!).push(limit)
}

function importLogOpt(
  state: CompileState,
  entry: DockerRunParseEntry,
  value: string,
) {
  const [key, ...rest] = value.split('=')
  if (!key || rest.length === 0) {
    note(
      state,
      'option_value_unparsed',
      entry.rawFlag,
      `"--log-opt ${value}" is not in KEY=VALUE form and was not imported.`,
    )
    return
  }
  const logging = state.builder.nested('logging')
  const optionsMap = isRecord(logging.options) ? logging.options : {}
  optionsMap[key] = rest.join('=')
  logging.options = optionsMap
}

function importStorageOpt(
  state: CompileState,
  entry: DockerRunParseEntry,
  value: string,
) {
  const [key, ...rest] = value.split('=')
  if (!key || rest.length === 0) {
    note(
      state,
      'option_value_unparsed',
      entry.rawFlag,
      `"--storage-opt ${value}" is not in KEY=VALUE form and was not imported.`,
    )
    return
  }
  state.builder.nested('storage_opt')[key] = rest.join('=')
}

function importBlkioWeightDevice(
  state: CompileState,
  entry: DockerRunParseEntry,
  value: string,
) {
  const limit = parseBlkioWeightDevice(value)
  if (!limit) {
    note(
      state,
      'option_value_unparsed',
      entry.rawFlag,
      `"--blkio-weight-device ${value}" is not in <path>:<weight> form and was not imported.`,
    )
    return
  }
  state.builder.nestedList('blkio_config', 'weight_device').push(limit)
}

function importUlimitFlag(
  state: CompileState,
  entry: DockerRunParseEntry,
  value: string,
) {
  const ulimit = parseUlimit(value)
  if (!ulimit) {
    note(
      state,
      'option_value_unparsed',
      entry.rawFlag,
      `"--ulimit ${value}" is not in <name>=<soft>[:<hard>] form and was not imported.`,
    )
    return
  }
  state.builder.nested('ulimits')[ulimit.name] = ulimit.limit
}

function importNetworkFlag(
  state: CompileState,
  entry: DockerRunParseEntry,
  value: string,
) {
  if (isNetworkModeValue(value)) {
    state.networkMode = value
    const risk = entry.definition.risk
    if (value === 'host' && risk) {
      raiseRisk(state, 'host_network', sourceOf(entry), risk)
    }
    return
  }
  if (!COMPOSE_NETWORK_KEY_RE.test(value)) {
    note(
      state,
      'option_value_unparsed',
      entry.rawFlag,
      `Docker network name "${value}" cannot be a Compose network key (letters, digits, dot, dash and underscore only), so no attachment was created.`,
    )
    return
  }
  if (state.networkKey !== null && state.networkKey !== value) {
    note(
      state,
      'option_value_unparsed',
      entry.rawFlag,
      `Only the first named network is imported as an attachment; "${value}" was skipped. Add it under the service's networks: after merging.`,
    )
    return
  }
  state.networkKey = value
}

function appendAttachmentList(state: CompileState, key: string, value: string) {
  const existing = state.networkAttachment[key]
  const list = Array.isArray(existing) ? (existing as string[]) : []
  list.push(value)
  state.networkAttachment[key] = list
}

function buildTopLevelNetworks(state: CompileState): Record<string, unknown> {
  const topLevelNetworks: Record<string, unknown> = {}
  const hasAttachment = Object.keys(state.networkAttachment).length > 0

  if (state.networkMode !== null) {
    state.builder.setScalar('network_mode', state.networkMode)
    if (state.networkKey !== null || hasAttachment) {
      state.diagnostics.push({
        code: 'option_value_unparsed',
        flag: '--network',
        blocking: false,
        message:
          `network_mode: ${state.networkMode} replaces the container's own network stack, so per-network aliases and addresses have nothing to attach to and were not imported.`,
      })
    }
    return topLevelNetworks
  }

  if (state.networkKey !== null || hasAttachment) {
    // `--network-alias` / `--ip` with no `--network` attach to the network the
    // container would have joined by default; Compose spells that `default`.
    const key = state.networkKey ?? 'default'
    state.builder.nested('networks')[key] = hasAttachment
      ? state.networkAttachment
      : null
    topLevelNetworks[key] = {}
  }
  return topLevelNetworks
}

function buildTopLevelVolumes(state: CompileState): Record<string, unknown> {
  const topLevelVolumes: Record<string, unknown> = {}
  for (const name of state.namedVolumes) {
    topLevelVolumes[name] = state.volumeDriver === null
      ? {}
      : { driver: state.volumeDriver }
  }
  if (state.volumeDriver !== null && state.namedVolumes.length === 0) {
    state.diagnostics.push({
      code: 'option_value_unparsed',
      flag: '--volume-driver',
      blocking: false,
      message:
        '--volume-driver sets the driver for named volumes and this command declares none, so no top-level volumes: entry was created.',
    })
  }
  return topLevelVolumes
}

/** `host` / `none` / `bridge` / `container:<name>` are Compose `network_mode`. */
function isNetworkModeValue(value: string): boolean {
  return value === 'host' || value === 'none' || value === 'bridge' ||
    value.startsWith('container:')
}

function parseBlkioLimit(
  raw: string,
): { path: string; rate: number | string } | null {
  const separator = raw.lastIndexOf(':')
  if (separator <= 0 || separator === raw.length - 1) return null
  const path = raw.slice(0, separator)
  const rate = raw.slice(separator + 1)
  return { path, rate: toNumber(rate) ?? rate }
}

function parseBlkioWeightDevice(
  raw: string,
): { path: string; weight: number | string } | null {
  const limit = parseBlkioLimit(raw)
  if (!limit) return null
  return { path: limit.path, weight: limit.rate }
}

function parseUlimit(
  raw: string,
): { name: string; limit: number | string | { soft: number; hard: number } } | null {
  const equals = raw.indexOf('=')
  if (equals <= 0) return null
  const name = raw.slice(0, equals).trim()
  const limits = raw.slice(equals + 1).trim()
  if (!name || !limits) return null
  const colon = limits.indexOf(':')
  if (colon === -1) {
    return { name, limit: toNumber(limits) ?? limits }
  }
  const soft = toNumber(limits.slice(0, colon))
  const hard = toNumber(limits.slice(colon + 1))
  if (soft === null || hard === null) return null
  return { name, limit: { soft, hard } }
}

/**
 * `--gpus all` is the one value the Compose schema takes as a bare string;
 * everything else is Docker's CSV device request, which becomes one entry in
 * the `gpus:` list.
 */
function importGpus(builder: ComposeServiceBuilder, raw: string) {
  if (raw.trim() === 'all') {
    builder.setScalar('gpus', 'all')
    return
  }
  const options = parseCsvOptions(raw, true)
  const request: Record<string, unknown> = {}
  const driver = options.get('driver')
  if (driver) request.driver = driver
  const count = options.get('count')
  if (count) request.count = count === 'all' ? 'all' : toNumber(count) ?? count
  const devices = options.get('device') ?? options.get('device_ids')
  if (devices) request.device_ids = devices.split(',').map((id) => id.trim())
  const capabilities = options.get('capabilities')
  if (capabilities) {
    request.capabilities = capabilities.split(',').map((cap) => cap.trim())
  }
  builder.appendList('gpus', request)
}

function raiseBindMountRisk(
  state: CompileState,
  entry: DockerRunParseEntry,
  raw: string,
  source: string,
  risk: string,
) {
  if (DOCKER_SOCKET_PATHS.has(source)) {
    raiseRisk(
      state,
      'docker_api_socket',
      `${entry.rawFlag} ${raw}`,
      'bind-mounting the Docker API socket gives the container full control of the daemon, which is equivalent to root on the host',
    )
    return
  }
  raiseRisk(state, 'host_bind_mount', `${entry.rawFlag} ${raw}`, risk)
}

/** Docker `-v SRC:DST[:MODE]` short syntax, carried across verbatim. */
function importVolumeShortSyntax(
  state: CompileState,
  raw: string,
  entry: DockerRunParseEntry,
) {
  state.builder.appendList('volumes', raw)
  const parts = splitVolumeSpec(raw)
  if (parts.length < 2) {
    // `-v /data` is an anonymous volume: no host path, nothing to declare.
    return
  }
  const source = parts[0]!
  if (!isHostPathSource(source)) {
    registerNamedVolume(state, source)
    return
  }
  const risk = entry.definition.risk
  if (!risk) return
  raiseBindMountRisk(state, entry, raw, source, risk)
}

/** Docker `--mount type=…,source=…,target=…` becomes Compose long syntax. */
function importMount(
  state: CompileState,
  raw: string,
  entry: DockerRunParseEntry,
) {
  const options = parseCsvOptions(raw)
  const type = options.get('type') ?? 'volume'
  const source = options.get('source') ?? options.get('src') ?? null
  const target = options.get('target') ?? options.get('dst') ??
    options.get('destination') ?? null

  if (target === null) {
    note(
      state,
      'option_value_unparsed',
      entry.rawFlag,
      `"--mount ${raw}" has no target= and was not imported.`,
      true,
    )
    return
  }

  const mount: Record<string, unknown> = { type, target }
  if (source !== null) mount.source = source
  if (options.has('readonly') || options.has('ro')) {
    const explicit = options.get('readonly') ?? options.get('ro') ?? ''
    mount.read_only = explicit === '' ? true : explicit !== 'false'
  }
  const propagation = options.get('bind-propagation')
  if (propagation) mount.bind = { propagation }
  const nocopy = options.get('volume-nocopy')
  if (nocopy !== undefined) mount.volume = { nocopy: nocopy !== 'false' }
  const tmpfsSize = options.get('tmpfs-size')
  if (tmpfsSize) {
    mount.tmpfs = { size: toNumber(tmpfsSize) ?? tmpfsSize }
  }

  state.builder.appendList('volumes', mount)

  if (type === 'volume' && source !== null) {
    registerNamedVolume(state, source)
    return
  }
  if (type !== 'bind' || source === null) return
  const risk = entry.definition.risk
  if (!risk) return
  raiseBindMountRisk(state, entry, raw, source, risk)
}
