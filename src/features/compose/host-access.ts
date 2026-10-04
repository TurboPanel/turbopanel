/**
 * Host-level access by **value**: every place a Compose document can reach a
 * path on the daemon host outside the service's own directory.
 *
 * `./field-policy.ts` gates the keys that are dangerous whatever they say
 * (`privileged`, `use_api_socket`, …). `volumes` is not one of them — a bind
 * inside the service's directory (`./data:/data`) and a named volume are
 * ordinary, and most Compose files use both. What is host-level is a path that
 * resolves anywhere else: `/`, `/etc`, `/var/run/docker.sock`, `~`, `../..`.
 * Compose has more spellings for that than `volumes:`, so all of them are
 * checked here:
 *
 * - `services.<name>.volumes` — short (`src:dst[:mode]`) and long
 *   (`type: bind` / `npipe` / an unknown type) syntax;
 * - top-level `volumes.<name>.driver_opts` that make a local volume a bind
 *   (`o: bind`, `type: none`, a host-path `device`);
 * - top-level `volumes.<name>.name` / `external`, which name a Docker volume
 *   the stack does not own (another stack's data, mounted on deploy and
 *   removed by `compose down --volumes`);
 * - top-level `configs.<name>.file` / `secrets.<name>.file`;
 * - `services.<name>.env_file` / `label_file`;
 * - `services.<name>.extends.file` and top-level `include` — always, even
 *   inside the directory: the daemon reads those files on the host at deploy
 *   time, so what they add never passes this check.
 *
 * A bind of the service's directory itself (`.:/app`) is host-level too: a
 * container that can write there can rewrite the deployed files and plant
 * symlinks a later bind would follow. The daemon also resolves every bind on
 * the host before `compose up` (turbopaneld `compose-host-paths.ts`), which
 * is what catches a symlink this lexical check cannot see.
 *
 * Fail closed: a path this module cannot resolve statically — an interpolated
 * `${VAR}`, a backslash, a value of the wrong type — is treated as outside.
 *
 * `services.<name>.build` is not here: what a build may read and reach is
 * refused outright, with no opt-in, by `./build-policy.ts`.
 *
 * Pure and org-blind, like the rest of `src/features/compose/`: it only says
 * *what* is host-level. Whether this organization may deploy it is decided
 * where org and actor context exist (`validateComposeForDeploy`'s callers).
 */

import { GATED_SERVICE_FIELD_KEYS, HOST_LEVEL_OPT_IN_SENTENCE } from './field-policy.ts'
import { resolveComposeTags } from './tags.ts'

/** One host-level reach, at a Compose path, with the authored value. */
export type HostAccessFinding = {
  /** Dot path, `[i]` for sequence items — the same shape the linter reports. */
  path: string
  /** YAML path segments, for resolving the node (and its line). */
  segments: Array<string | number>
  message: string
  /** The authored value at `path`, for the approval fingerprint. */
  value: unknown
}

const DOCKER_SOCKET_PATHS = new Set(['/var/run/docker.sock', '/run/docker.sock'])

/** Long-syntax `volumes` types that never touch a host path. */
const SAFE_MOUNT_TYPES = new Set(['volume', 'tmpfs', 'image'])

const SAFE_TMPFS_OPTION = /^(size|mode|uid|gid|nr_inodes|nr_blocks)=[\w.]+$/
const SAFE_TMPFS_FLAGS = new Set(['noexec', 'nosuid', 'nodev', 'noatime', 'ro', 'rw'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function joinPath(segments: ReadonlyArray<string | number>): string {
  let out = ''
  for (const segment of segments) {
    if (typeof segment === 'number') out += `[${segment}]`
    else out += out === '' ? segment : `.${segment}`
  }
  return out
}

/** Trailing slashes stripped without a quantified regex. */
function withoutTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '/') end--
  return value.slice(0, end)
}

/**
 * Why a host path is outside the service's directory, or `null` when it is a
 * plain relative path that stays inside it.
 */
export function outsideReason(path: string): string | null {
  const trimmed = path.trim()
  if (trimmed === '') return 'is empty, so it cannot be resolved'
  if (trimmed.includes('$')) {
    return 'is interpolated, so where it points cannot be checked before deploy'
  }
  if (trimmed.includes('\\')) {
    return 'contains a backslash, so where it points cannot be checked'
  }
  if (DOCKER_SOCKET_PATHS.has(withoutTrailingSlashes(trimmed))) {
    return 'is the Docker engine socket, which controls every container on the host'
  }
  if (trimmed.startsWith('/')) return 'is an absolute path on the host'
  if (trimmed.startsWith('~')) return 'is in a home directory on the host'
  if (trimmed.split('/').includes('..')) {
    return "climbs out of the service's directory with `..`"
  }
  return null
}

/**
 * Why a bind source is not allowed even though it stays inside: the service's
 * directory itself (`.`, `./`). A container that can write there can rewrite
 * the files the daemon deploys from and plant symlinks a later bind follows.
 */
function wholeDirectoryReason(path: string): string | null {
  const parts = path
    .trim()
    .split('/')
    .filter((part) => part !== '' && part !== '.')
  return parts.length === 0
    ? "is the service's own directory, which holds the files the daemon deploys from"
    : null
}

/**
 * `extends` and `include` pull in another Compose file that the daemon reads
 * on the host at deploy time. Its content never reaches this check, and any
 * file inside the service's directory is one a container could have written.
 */
const PULLS_UNCHECKED_COMPOSE =
  'is read on the host at deploy time, so what it adds never passes this check'

class Collector {
  readonly findings: HostAccessFinding[] = []

  add(segments: Array<string | number>, what: string, reason: string, value: unknown): void {
    this.findings.push({
      path: joinPath(segments),
      segments,
      message: `${what} ${reason} — ${HOST_LEVEL_OPT_IN_SENTENCE}`,
      value,
    })
  }

  /** A path field: flag it unless it is relative and stays inside. */
  path(segments: Array<string | number>, what: string, value: unknown): void {
    if (typeof value !== 'string') {
      this.add(segments, what, 'is not a plain path, so it cannot be checked', value)
      return
    }
    const reason = outsideReason(value)
    if (reason) this.add(segments, `${what} \`${value}\``, reason, value)
  }

  /** A bind source: {@link path}, and never the service's directory itself. */
  bindSource(segments: Array<string | number>, what: string, value: unknown): void {
    if (typeof value === 'string' && outsideReason(value) === null) {
      const whole = wholeDirectoryReason(value)
      if (whole) {
        this.add(segments, `${what} \`${value}\``, whole, value)
        return
      }
    }
    this.path(segments, what, value)
  }
}

/** Short syntax: `[SOURCE:]TARGET[:MODE]`. Only the source can be a host path. */
function checkShortVolume(out: Collector, segments: Array<string | number>, spec: string): void {
  const trimmed = spec.trim()
  if (trimmed.includes('$')) {
    out.add(
      segments,
      `bind \`${spec}\``,
      'is interpolated, so where it points cannot be checked before deploy',
      spec
    )
    return
  }
  const colon = trimmed.indexOf(':')
  // No source: an anonymous volume.
  if (colon === -1) return
  const source = trimmed.slice(0, colon)
  const isPath =
    source.startsWith('/') ||
    source.startsWith('.') ||
    source.startsWith('~') ||
    source.includes('\\')
  // Anything else is a named volume (Compose refuses a named volume with `/`).
  if (!isPath) return
  const reason = outsideReason(source) ?? wholeDirectoryReason(source)
  if (reason) out.add(segments, `bind source \`${source}\``, reason, spec)
}

function checkLongVolume(
  out: Collector,
  segments: Array<string | number>,
  spec: Record<string, unknown>
): void {
  const type = typeof spec.type === 'string' ? spec.type : 'volume'
  if (type === 'bind') {
    out.bindSource([...segments, 'source'], 'bind source', spec.source)
    return
  }
  if (!SAFE_MOUNT_TYPES.has(type)) {
    out.add(
      [...segments, 'type'],
      `mount type \`${type}\``,
      'reaches the host outside a named volume',
      spec
    )
  }
}

function checkServiceVolumes(out: Collector, serviceSegments: string[], volumes: unknown): void {
  if (!Array.isArray(volumes)) return
  volumes.forEach((spec, index) => {
    const segments = [...serviceSegments, 'volumes', index]
    if (typeof spec === 'string') checkShortVolume(out, segments, spec)
    else if (isRecord(spec)) checkLongVolume(out, segments, spec)
    else out.add(segments, 'volume', 'is not a volume Compose accepts', spec)
  })
}

/** `env_file` / `label_file`: a string, or a list of strings / `{ path }`. */
function checkFileList(
  out: Collector,
  segments: Array<string | number>,
  what: string,
  value: unknown
): void {
  if (value === undefined || value === null) return
  if (!Array.isArray(value)) {
    out.path(segments, what, value)
    return
  }
  value.forEach((entry, index) => {
    const at = [...segments, index]
    if (isRecord(entry)) out.path([...at, 'path'], what, entry.path)
    else out.path(at, what, entry)
  })
}

/**
 * How an `extends.file` is named in a message: the text as written, or a
 * primitive (a number, `null`) spelled out. Anything else (a mapping or list
 * the schema would refuse) has no text to quote, and stringifying it would
 * print `[object Object]`.
 */
function extendsFileLabel(file: unknown): string {
  if (
    file === null ||
    typeof file === 'string' ||
    typeof file === 'number' ||
    typeof file === 'boolean' ||
    typeof file === 'bigint'
  ) {
    return `extends file \`${file}\``
  }
  return 'extends file'
}

function checkExtends(out: Collector, serviceSegments: string[], value: unknown): void {
  if (isRecord(value) && value.file !== undefined) {
    out.add(
      [...serviceSegments, 'extends', 'file'],
      extendsFileLabel(value.file),
      PULLS_UNCHECKED_COMPOSE,
      value.file
    )
  }
}

/** An explicit `name:` or `external` makes Compose use a volume by its host-wide name. */
function checkVolumeIdentity(out: Collector, name: string, entry: Record<string, unknown>): void {
  if (entry.name !== undefined) {
    out.add(
      ['volumes', name, 'name'],
      `volume \`${name}\``,
      'names a Docker volume on the host, which may belong to another stack',
      entry.name
    )
  }
  if (entry.external !== undefined && entry.external !== false) {
    out.add(
      ['volumes', name, 'external'],
      `volume \`${name}\``,
      'uses a Docker volume the stack does not own',
      entry.external
    )
  }
}

function checkTopLevelVolumes(out: Collector, volumes: unknown): void {
  if (!isRecord(volumes)) return
  for (const [name, entry] of Object.entries(volumes)) {
    if (!isRecord(entry)) continue
    checkVolumeIdentity(out, name, entry)
    if (!isRecord(entry.driver_opts)) continue
    const opts = entry.driver_opts
    const at = ['volumes', name, 'driver_opts']
    const type = typeof opts.type === 'string' ? opts.type.trim().toLowerCase() : undefined
    const o = typeof opts.o === 'string' ? opts.o : ''
    const mountFlags = new Set(o.split(',').map((flag) => flag.trim().toLowerCase()))
    const bindFlag = mountFlags.has('bind') || mountFlags.has('rbind')
    if (bindFlag || type === 'none' || type === 'bind') {
      out.add(at, `volume \`${name}\``, 'is a bind mount of a host path in disguise', opts)
      continue
    }
    const device = opts.device
    if (typeof device === 'string' && device.trim().startsWith('/')) {
      out.add(
        [...at, 'device'],
        `volume \`${name}\` device \`${device}\``,
        'mounts a host path',
        opts
      )
      continue
    }
    if (Object.keys(opts).length > 0 && !isSafeTmpfsVolume(opts, type, mountFlags)) {
      out.add(
        at,
        `volume \`${name}\``,
        'mounts something other than plain Docker storage (overlay, network and other filesystem types can reach host paths)',
        opts
      )
    }
  }
}

/** A tmpfs volume with sizing and ownership options only. */
function isSafeTmpfsVolume(
  opts: Record<string, unknown>,
  type: string | undefined,
  mountFlags: ReadonlySet<string>
): boolean {
  if (Object.keys(opts).some((key) => key !== 'type' && key !== 'device' && key !== 'o')) {
    return false
  }
  if (type !== 'tmpfs') return false
  if (opts.device !== undefined && opts.device !== 'tmpfs') return false
  return [...mountFlags].every(
    (flag) => flag === '' || SAFE_TMPFS_FLAGS.has(flag) || SAFE_TMPFS_OPTION.test(flag)
  )
}

function checkFileBacked(out: Collector, kind: 'configs' | 'secrets', value: unknown): void {
  if (!isRecord(value)) return
  for (const [name, entry] of Object.entries(value)) {
    if (isRecord(entry) && entry.file !== undefined) {
      out.path([kind, name, 'file'], `${kind === 'configs' ? 'config' : 'secret'} file`, entry.file)
    }
  }
}

function checkInclude(out: Collector, include: unknown): void {
  if (include === undefined || include === null) return
  const entries = Array.isArray(include) ? include : [include]
  entries.forEach((entry, index) => {
    const label = typeof entry === 'string' ? `included file \`${entry}\`` : 'include entry'
    out.add(['include', index], label, PULLS_UNCHECKED_COMPOSE, entry)
  })
}

/**
 * Every value-level host reach in a (merged or single-layer) Compose data
 * tree. Tag sentinels (`!reset` / `!override`) are resolved first, so a value
 * hidden inside an `!override` is judged like any other.
 */
export function collectHostAccessFindings(data: unknown): HostAccessFinding[] {
  const out = new Collector()
  const root = resolveComposeTags(data)
  if (!isRecord(root)) return out.findings

  if (isRecord(root.services)) {
    for (const [name, body] of Object.entries(root.services)) {
      if (!isRecord(body)) continue
      const at = ['services', name]
      checkServiceVolumes(out, at, body.volumes)
      checkFileList(out, [...at, 'env_file'], 'env_file', body.env_file)
      checkFileList(out, [...at, 'label_file'], 'label_file', body.label_file)
      checkExtends(out, at, body.extends)
    }
  }
  checkTopLevelVolumes(out, root.volumes)
  checkFileBacked(out, 'configs', root.configs)
  checkFileBacked(out, 'secrets', root.secrets)
  checkInclude(out, root.include)
  return out.findings
}

/**
 * Every gated key set on a service, in service order then registry order: its
 * dot path, the key and the authored value. Shared by the refusal list and the
 * approval fingerprint so the two can never disagree about which keys count.
 */
function gatedServiceKeys(root: unknown): Array<{ path: string; key: string; value: unknown }> {
  const found: Array<{ path: string; key: string; value: unknown }> = []
  if (!isRecord(root) || !isRecord(root.services)) return found
  for (const [name, body] of Object.entries(root.services)) {
    if (!isRecord(body)) continue
    for (const key of GATED_SERVICE_FIELD_KEYS) {
      if (key in body) found.push({ path: `services.${name}.${key}`, key, value: body[key] })
    }
  }
  return found
}

/**
 * Every host-level path in a document — gated keys and value-level reaches —
 * as the issue list a refusal carries.
 */
export function hostAccessIssues(data: unknown): Array<{ path: string; message: string }> {
  const root = resolveComposeTags(data)
  const issues: Array<{ path: string; message: string }> = gatedServiceKeys(root).map(
    ({ path, key }) => ({
      path,
      message: `${key} grants root-equivalent access to the shared daemon host`,
    })
  )
  for (const finding of collectHostAccessFindings(root)) {
    issues.push({ path: finding.path, message: finding.message })
  }
  return issues
}

/**
 * Everything host-level in a document — the gated keys *and* the value-level
 * reaches — as one canonical, order-independent string. Two documents with
 * the same host-level content produce the same string whatever else differs,
 * so an approval recorded against it survives an unrelated edit and is voided
 * by any change to what reaches the host.
 */
export function hostAccessCanonical(data: unknown): string {
  const root = resolveComposeTags(data)
  const entries: Array<[string, unknown]> = gatedServiceKeys(root).map(({ path, value }) => [
    path,
    value,
  ])
  for (const finding of collectHostAccessFindings(root)) {
    entries.push([finding.path, finding.value])
  }
  entries.sort(([a], [b]) => compareCodeUnits(a, b))
  return entries.length === 0 ? '' : JSON.stringify(entries, sortedReplacer)
}

/**
 * UTF-16 code-unit order — what `.sort()` does by default, spelled out. Never
 * `localeCompare`: the approval fingerprint must be byte-identical on every
 * host and locale, or a recorded approval would stop matching.
 */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort(compareCodeUnits)) {
    out[key] = value[key]
  }
  return out
}

/** SHA-256 hex of {@link hostAccessCanonical}, or `null` when nothing is host-level. */
export async function hostAccessFingerprint(data: unknown): Promise<string | null> {
  const canonical = hostAccessCanonical(data)
  if (canonical === '') return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
