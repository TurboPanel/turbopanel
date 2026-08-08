import {
  isMap,
  LineCounter,
  parseDocument,
  type Node,
  type Scalar,
  type YAMLMap,
} from 'yaml'
import { TURBOPANEL_SERVICE_EXTENSION_KEY } from './service-kind.ts'

export type ComposeLintLevel = 'error' | 'warning'

export type ComposeLintIssue = {
  level: ComposeLintLevel
  message: string
  /** Dot-joined location within the compose tree (e.g. `services.nginx.imaage`). */
  path: string
  /** 1-based source line, when it can be resolved from the YAML. */
  line?: number
}

/** Top-level Compose Specification keys. `x-*` extensions are always allowed. */
const TOP_LEVEL_KEYS = new Set([
  'configs',
  'name',
  'networks',
  'secrets',
  'services',
  'version',
  'volumes',
])

/** Service-level keys from the Compose Specification. */
const SERVICE_KEYS = new Set([
  'annotations',
  'attach',
  'blkio_config',
  'build',
  'cap_add',
  'cap_drop',
  'cgroup',
  'cgroup_parent',
  'command',
  'configs',
  'container_name',
  'cpu_count',
  'cpu_percent',
  'cpu_period',
  'cpu_quota',
  'cpu_rt_period',
  'cpu_rt_runtime',
  'cpu_shares',
  'cpus',
  'cpuset',
  'credential_spec',
  'depends_on',
  'deploy',
  'develop',
  'device_cgroup_rules',
  'devices',
  'dns',
  'dns_opt',
  'dns_search',
  'domainname',
  'entrypoint',
  'env_file',
  'environment',
  'expose',
  'extends',
  'external_links',
  'extra_hosts',
  'gpus',
  'group_add',
  'healthcheck',
  'hostname',
  'image',
  'init',
  'ipc',
  'isolation',
  'labels',
  'links',
  'logging',
  'mac_address',
  'mem_limit',
  'mem_reservation',
  'mem_swappiness',
  'memswap_limit',
  'network_mode',
  'networks',
  'oom_kill_disable',
  'oom_score_adj',
  'pid',
  'pids_limit',
  'platform',
  'ports',
  'post_start',
  'pre_stop',
  'privileged',
  'profiles',
  'pull_policy',
  'read_only',
  'restart',
  'runtime',
  'scale',
  'secrets',
  'security_opt',
  'shm_size',
  'stdin_open',
  'stop_grace_period',
  'stop_signal',
  'storage_opt',
  'sysctls',
  'tmpfs',
  'tty',
  'ulimits',
  'user',
  'userns_mode',
  'uts',
  'volumes',
  'volumes_from',
  'working_dir',
])

/** Draft-only warnings that must not block saving a blank/empty compose. */
const DRAFT_ALLOWED_LINT_MESSAGES = new Set([
  'Compose file has no "services" section',
  'No services defined',
])

function isExtensionKey(key: string): boolean {
  return key.startsWith('x-')
}

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const dist = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (let i = 0; i < rows; i += 1) dist[i]![0] = i
  for (let j = 0; j < cols; j += 1) dist[0]![j] = j
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dist[i]![j] = Math.min(
        dist[i - 1]![j]! + 1,
        dist[i]![j - 1]! + 1,
        dist[i - 1]![j - 1]! + cost,
      )
    }
  }
  return dist[a.length]![b.length]!
}

/** Nearest allowed key within edit distance 2, for "did you mean" hints. */
function suggestKey(key: string, allowed: Iterable<string>): string | null {
  let best: string | null = null
  let bestDistance = 3
  for (const candidate of allowed) {
    const distance = levenshtein(key, candidate)
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

function unknownKeyMessage(
  key: string,
  kind: string,
  allowed: Iterable<string>,
): string {
  const suggestion = suggestKey(key, allowed)
  const base = `Unknown ${kind} key "${key}"`
  return suggestion ? `${base} — did you mean "${suggestion}"?` : base
}

function nodeLine(
  node: Node | null | undefined,
  lineCounter: LineCounter,
): number | undefined {
  const range = (node as { range?: [number, number, number] } | null)?.range
  if (!range) return undefined
  return lineCounter.linePos(range[0]).line
}

function stringKey(key: unknown): string | null {
  if (key && typeof key === 'object' && 'value' in (key as object)) {
    const value = (key as { value: unknown }).value
    if (typeof value === 'string') return value
  }
  return null
}

function scalarString(node: Node | null | undefined): string | null {
  if (!node || typeof node !== 'object' || !('value' in node)) return null
  const value = (node as Scalar).value
  return typeof value === 'string' ? value : null
}

/** True when an `image` key is present but empty/missing (not a real image ref). */
function isEmptyImageValue(node: Node | null | undefined): boolean {
  if (!node || typeof node !== 'object' || !('value' in node)) return false
  const value = (node as Scalar).value
  if (value === null || value === undefined) return true
  return typeof value === 'string' && value.trim().length === 0
}

function serviceIsTraditionalWeb(valueNode: YAMLMap): boolean {
  for (const item of valueNode.items) {
    if (stringKey(item.key) !== TURBOPANEL_SERVICE_EXTENSION_KEY) continue
    if (!isMap(item.value)) return false
    for (const extItem of item.value.items) {
      if (stringKey(extItem.key) !== 'serviceKind') continue
      return scalarString(extItem.value as Node) === 'traditional-web'
    }
  }
  return false
}

function lintService(
  name: string,
  valueNode: Node | null | undefined,
  keyLine: number | undefined,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  const path = `services.${name}`
  if (!isMap(valueNode)) {
    issues.push({
      level: 'error',
      message: `Service "${name}" must be a mapping`,
      path,
      line: keyLine,
    })
    return
  }

  let hasImage = false
  let hasBuild = false
  for (const item of valueNode.items) {
    const key = stringKey(item.key)
    if (key === null) continue
    if (key === 'image' && !isEmptyImageValue(item.value as Node)) {
      hasImage = true
    }
    if (key === 'build') hasBuild = true
    if (!SERVICE_KEYS.has(key) && !isExtensionKey(key)) {
      issues.push({
        level: 'warning',
        message: unknownKeyMessage(key, 'service', SERVICE_KEYS),
        path: `${path}.${key}`,
        line: nodeLine(item.key as Node, lineCounter),
      })
    }
  }

  const traditionalWeb = serviceIsTraditionalWeb(valueNode)
  if (!traditionalWeb && !hasImage && !hasBuild) {
    issues.push({
      level: 'error',
      message: `Service "${name}" must define "image" or "build"`,
      path,
      line: keyLine,
    })
  }
}

function lintServices(
  servicesNode: Node | null | undefined,
  servicesKeyLine: number | undefined,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  if (!isMap(servicesNode)) {
    issues.push({
      level: 'error',
      message: '"services" must be a mapping',
      path: 'services',
      line: servicesKeyLine,
    })
    return
  }

  if (servicesNode.items.length === 0) {
    issues.push({
      level: 'warning',
      message: 'No services defined',
      path: 'services',
      line: servicesKeyLine,
    })
    return
  }

  for (const item of servicesNode.items) {
    const name = stringKey(item.key)
    if (name === null) continue
    lintService(
      name,
      item.value as Node | null | undefined,
      nodeLine(item.key as Node, lineCounter),
      lineCounter,
      issues,
    )
  }
}

function lintTopLevel(
  root: YAMLMap,
  lineCounter: LineCounter,
  issues: ComposeLintIssue[],
): void {
  let servicesItem: (typeof root.items)[number] | null = null
  for (const item of root.items) {
    const key = stringKey(item.key)
    if (key === null) continue
    if (key === 'services') {
      servicesItem = item
      continue
    }
    if (!TOP_LEVEL_KEYS.has(key) && !isExtensionKey(key)) {
      issues.push({
        level: 'warning',
        message: unknownKeyMessage(key, 'top-level', TOP_LEVEL_KEYS),
        path: key,
        line: nodeLine(item.key as Node, lineCounter),
      })
    }
  }

  if (!servicesItem) {
    issues.push({
      level: 'warning',
      message: 'Compose file has no "services" section',
      path: '$',
    })
    return
  }

  lintServices(
    servicesItem.value as Node | null | undefined,
    nodeLine(servicesItem.key as Node, lineCounter),
    lineCounter,
    issues,
  )
}

/** Sort by source line (ascending); lineless last; errors before warnings on a tie. */
function compareLintIssues(a: ComposeLintIssue, b: ComposeLintIssue): number {
  const lineA = a.line ?? Number.POSITIVE_INFINITY
  const lineB = b.line ?? Number.POSITIVE_INFINITY
  if (lineA !== lineB) {
    return lineA - lineB
  }
  if (a.level !== b.level) {
    return a.level === 'error' ? -1 : 1
  }
  return a.path.localeCompare(b.path)
}

/**
 * Lint docker-compose YAML for structural mistakes (invalid YAML, unknown keys,
 * services missing image/build). Returns an empty list for empty input. Issues
 * are ordered by line number.
 */
export function lintComposeYaml(source: string): ComposeLintIssue[] {
  const trimmed = source.trim()
  if (!trimmed) return []

  const lineCounter = new LineCounter()
  const doc = parseDocument(source, { prettyErrors: true, lineCounter })

  if (doc.errors.length > 0) {
    return doc.errors
      .map((error) => ({
        level: 'error' as const,
        message: error.message.split('\n')[0] ?? error.message,
        path: '$',
        line: error.linePos?.[0]?.line,
      }))
      .sort(compareLintIssues)
  }

  const root = doc.contents
  if (!isMap(root)) {
    return [
      {
        level: 'error',
        message: 'Compose file root must be a mapping',
        path: '$',
        line: nodeLine(root as Node, lineCounter),
      },
    ]
  }

  const issues: ComposeLintIssue[] = []
  lintTopLevel(root, lineCounter, issues)
  return issues.sort(compareLintIssues)
}

/**
 * Issues that must fail a save (everything except empty-draft warnings).
 */
export function blockingComposeLintIssues(
  issues: readonly ComposeLintIssue[],
): ComposeLintIssue[] {
  return issues.filter((issue) => !DRAFT_ALLOWED_LINT_MESSAGES.has(issue.message))
}
