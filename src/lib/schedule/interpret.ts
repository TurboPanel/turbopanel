/**
 * Interpret Compose `deploy:` as TurboPanel scheduler input.
 *
 * Standalone Docker ignores most of this block; the control plane uses it to
 * size and place `task` rows. Scheduler-only keys are stripped from compiled
 * runtime YAML by `compileRuntimeComposeDocument`.
 *
 * ## Why `resources.reservations` is absent from this module
 *
 * A reservation is an admission requirement — "do not place this anywhere that
 * cannot promise me this much" — and admitting against one needs a per-host
 * capacity inventory (how much CPU and memory each server has, how much every
 * already-placed slot has claimed) that `lib/db/schema.ts` does not have. So
 * the field is **refused at deploy time** by `../compose/field-policy.ts`
 * rather than parsed here and quietly ignored by `./planner.ts`: a deploy that
 * succeeded would have told the operator the placement honoured it.
 *
 * `deploy.resources` itself stays `passthrough` + `keep` in the registry —
 * standalone Docker Compose applies `limits` and the native lane renders the
 * same numbers as systemd directives, so the ceiling half of the block is
 * genuinely acted on by both engines.
 */

export type ReplicaMode = 'replicated' | 'global'

export type PlacementConstraintOp = 'eq' | 'neq'

export type PlacementConstraint = {
  key: string
  op: PlacementConstraintOp
  value: string
}

export type ServiceScheduleSpec = {
  composeServiceName: string
  mode: ReplicaMode
  /** Desired replica count for `replicated` mode. Ignored for `global`. */
  replicas: number
  constraints: PlacementConstraint[]
  /** Label keys to spread across, from `placement.preferences`. */
  spreadKeys: string[]
  /** Fixed host ports that cannot be shared by two local replicas. */
  publishedHostPorts: number[]
  /** Compose service names this service must share a host with. */
  colocateWith: string[]
  /**
   * `placement.max_replicas_per_node` — the cap on how many of this service's
   * replicas may land on any one server. `null` when unset (no cap).
   */
  maxReplicasPerNode: number | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) {
    return value
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number.parseInt(value, 10)
    return parsed >= 1 ? parsed : null
  }
  return null
}

const NODE_LABEL_CONSTRAINT_RE =
  /^node\.labels\.([A-Za-z0-9][A-Za-z0-9._-]*)\s*(==|!=)\s*(\S.*)$/

function parseConstraint(raw: string): PlacementConstraint | null {
  const trimmed = raw.trim()
  const match = NODE_LABEL_CONSTRAINT_RE.exec(trimmed)
  if (!match) return null
  const key = match[1]
  const opToken = match[2]
  const value = match[3]?.trim()
  if (!key || !opToken || value === undefined || value.length === 0) return null
  return {
    key,
    op: opToken === '!=' ? 'neq' : 'eq',
    value,
  }
}

function parseConstraints(deploy: Record<string, unknown>): PlacementConstraint[] {
  if (!isPlainObject(deploy.placement)) return []
  const raw = deploy.placement.constraints
  if (!Array.isArray(raw)) return []
  const out: PlacementConstraint[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const parsed = parseConstraint(item)
    if (parsed) out.push(parsed)
  }
  return out
}

/**
 * `placement.max_replicas_per_node`, or `null` when unset or unusable.
 *
 * Same shape as {@link parsePositiveInt} everywhere else in this module: a
 * whole number of at least one, string form accepted because Compose allows it.
 * A zero or negative cap would mean "place nowhere", which is not a cap an
 * author can have meant, so it reads as absent rather than as a refusal — the
 * value-level refusals live in `../compose/lint.ts`.
 */
function parseMaxReplicasPerNode(deploy: Record<string, unknown>): number | null {
  if (!isPlainObject(deploy.placement)) return null
  return parsePositiveInt(deploy.placement.max_replicas_per_node)
}

function parseSpreadKeys(deploy: Record<string, unknown>): string[] {
  if (!isPlainObject(deploy.placement)) return []
  const raw = deploy.placement.preferences
  if (!Array.isArray(raw)) return []
  const keys: string[] = []
  for (const item of raw) {
    if (!isPlainObject(item) || typeof item.spread !== 'string') continue
    const spread = item.spread.trim()
    const prefix = 'node.labels.'
    if (spread.startsWith(prefix)) {
      const key = spread.slice(prefix.length)
      if (key.length > 0) keys.push(key)
    }
  }
  return keys
}

function parsePublishedPort(entry: unknown): number | null {
  if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 1 && entry <= 65535) {
    return entry
  }
  if (typeof entry === 'string') {
    const host = entry.split(':')[0]?.trim()
    if (!host || host.includes('-')) return null
    const parsed = Number.parseInt(host, 10)
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null
  }
  if (isPlainObject(entry)) {
    return parsePublishedPort(entry.published)
  }
  return null
}

function parsePublishedHostPorts(body: Record<string, unknown>): number[] {
  if (!Array.isArray(body.ports)) return []
  const ports: number[] = []
  for (const entry of body.ports) {
    const port = parsePublishedPort(entry)
    if (port !== null && !ports.includes(port)) ports.push(port)
  }
  return ports.sort((a, b) => a - b)
}

function colocateTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const prefix = 'service:'
  if (!value.startsWith(prefix)) return null
  const name = value.slice(prefix.length).trim()
  return name.length > 0 ? name : null
}

function parseColocateWith(body: Record<string, unknown>): string[] {
  const names: string[] = []
  for (const key of ['network_mode', 'pid', 'ipc'] as const) {
    const target = colocateTarget(body[key])
    if (target && !names.includes(target)) names.push(target)
  }
  return names
}

function parseDeployMode(deploy: Record<string, unknown> | null): ReplicaMode {
  if (!deploy) return 'replicated'
  return deploy.mode === 'global' ? 'global' : 'replicated'
}

function parseDeployReplicas(deploy: Record<string, unknown> | null): number | null {
  if (!deploy) return null
  return parsePositiveInt(deploy.replicas)
}

/**
 * Replica precedence: `deploy.replicas` / `mode: global` → else
 * `service.options.instances` → else 1.
 */
export function resolveReplicaPolicy(
  body: Record<string, unknown>,
  fallbackInstances: number,
): { mode: ReplicaMode; replicas: number } {
  const deploy = isPlainObject(body.deploy) ? body.deploy : null
  const mode = parseDeployMode(deploy)
  if (mode === 'global') return { mode, replicas: 1 }
  const fromDeploy = parseDeployReplicas(deploy)
  if (fromDeploy !== null) return { mode, replicas: fromDeploy }
  const fallback = Math.max(1, fallbackInstances)
  return { mode, replicas: fallback }
}

export function interpretServiceSchedule(
  composeServiceName: string,
  body: Record<string, unknown>,
  fallbackInstances: number,
): ServiceScheduleSpec {
  const deploy = isPlainObject(body.deploy) ? body.deploy : null
  const policy = resolveReplicaPolicy(body, fallbackInstances)
  return {
    composeServiceName,
    mode: policy.mode,
    replicas: policy.replicas,
    constraints: deploy ? parseConstraints(deploy) : [],
    spreadKeys: deploy ? parseSpreadKeys(deploy) : [],
    publishedHostPorts: parsePublishedHostPorts(body),
    colocateWith: parseColocateWith(body),
    maxReplicasPerNode: deploy ? parseMaxReplicasPerNode(deploy) : null,
  }
}

export function interpretComposeSchedule(
  services: Record<string, unknown>,
  instancesByComposeName: ReadonlyMap<string, number>,
): ServiceScheduleSpec[] {
  const specs: ServiceScheduleSpec[] = []
  for (const [name, raw] of Object.entries(services)) {
    if (!isPlainObject(raw)) continue
    const fallback = instancesByComposeName.get(name) ?? 1
    specs.push(interpretServiceSchedule(name, raw, fallback))
  }
  return specs
}
