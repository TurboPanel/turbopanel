/**
 * The "effective configuration" view of one environment.
 *
 * Host-free: no DB, no Hono. Given the ordered compose layers a deploy merges
 * (`resolveComposeLayerChain`) it answers three questions the editor screens ask:
 *
 * - what does the Base (the project's compose, plus any project overlays) say?
 * - what does this environment actually get (Base merged with the environment's
 *   own compose, by the same `mergeComposeLayers` a deploy uses)?
 * - what does this environment do differently, and where does each value come from?
 *
 * Nothing here is stored. "Follows the Base" is derived from the saved compose
 * files: an environment whose own compose replaces or deletes the whole
 * `services` block (`services: !override` / `services: !reset`) stands alone;
 * every other environment follows the Base.
 *
 * Values are display text for the editor, never a way to read a secret: variable
 * rows flagged secret carry no value, and any compose value whose name or text
 * looks like a credential is masked the same way. Masked values are still
 * compared here (so a change is still reported) but only the flag leaves the
 * server.
 *
 * Only `services`, the Linux users (`x-turbopanel.principals`) and variables are
 * covered. Root `networks` / `volumes` / `configs` are not part of this view.
 * The reserved `x-turbopanel` block is never returned as such: its useful parts
 * come out as plain fields ("Linux user", "Domain", "Branch", ...).
 */

import { mergeComposeLayers } from './layers.ts'
import type { ComposeLayer } from './layers.ts'
import { composeTagOf } from './tags.ts'
import { readHostingHostname, readHostingPathPrefix } from './hosting-extension.ts'
import { isNodeComposeService, isSiteComposeService } from './service-kind.ts'
import type { ComposeDocument } from './types.ts'

export type ConfigViewSource = 'base' | 'project' | 'environment'
export type ConfigViewArea = 'service' | 'domain' | 'linuxUser' | 'variable'
export type ConfigServiceKind = 'container' | 'site' | 'node'
export type ConfigLinuxUserAccess = 'none' | 'sftp' | 'ssh'

export type ConfigFieldRow = {
  /** Stable id of the row, e.g. `svc:web:command`. */
  key: string
  area: 'service' | 'domain' | 'linuxUser'
  /** The field inside the service, e.g. `command`, `environment.PORT`, `linuxUser`. */
  field: string
  label: string
  /** Display text. `null` when `masked`. */
  value: string | null
  masked: boolean
  source: ConfigViewSource
}

export type ConfigServiceView = {
  name: string
  /** This environment's service row, or `null` (the Base has none; or not saved yet). */
  serviceId: string | null
  kind: ConfigServiceKind
  /** Where the service itself is defined: `base`, or `environment` (added here or standing alone). */
  source: ConfigViewSource
  rows: ConfigFieldRow[]
}

export type ConfigLinuxUserView = {
  /** The Linux user's name as written in the Base (`x-turbopanel.principals` key). */
  name: string
  access: ConfigLinuxUserAccess
  description: string | null
  source: ConfigViewSource
  /** Services that run as this user. */
  usedBy: string[]
}

export type ConfigVariableView = {
  /** `var:NAME`. */
  key: string
  name: string
  variableId: string
  /** `null` when secret. */
  value: string | null
  isSecret: boolean
  forBuild: boolean
  forRuntime: boolean
  source: 'project' | 'environment'
}

export type ConfigChange = {
  /** Same keys as the rows: `svc:web:command`, `svc:web`, `user:deploy`, `var:API_URL`. */
  key: string
  area: ConfigViewArea
  label: string
  /** Field inside the service; `null` for a whole service, user or variable. */
  field: string | null
  serviceName: string | null
  serviceId: string | null
  kind: 'added' | 'changed' | 'removed'
  /** What the Base has. `null` when the Base has nothing, or when masked. */
  baseValue: string | null
  /** Where the Base value lives; `null` when the Base has nothing. */
  baseSource: 'base' | 'project' | null
  /** What this environment has. `null` when it has nothing, or when masked. */
  envValue: string | null
  envSource: 'environment' | null
  masked: boolean
}

export type ConfigSide = {
  services: ConfigServiceView[]
  variables: ConfigVariableView[]
  linuxUsers: ConfigLinuxUserView[]
}

export type EnvironmentConfigView = {
  followsBase: boolean
  base: ConfigSide
  effective: ConfigSide
  changes: ConfigChange[]
}

export type ConfigVariableInput = {
  id: string
  key: string
  value: string
  isSecret: boolean
  forBuild: boolean
  forRuntime: boolean
}

type Leaf = { path: string; value: unknown }

type FlatEntry = {
  key: string
  area: 'service' | 'domain' | 'linuxUser'
  field: string
  label: string
  /** Full text, used only to compare. Never leaves this module. */
  raw: string
  masked: boolean
}

type FlatService = { name: string; kind: ConfigServiceKind; entries: Map<string, FlatEntry> }
type FlatUser = { name: string; access: ConfigLinuxUserAccess; description: string | null }
type FlatConfig = { services: Map<string, FlatService>; users: Map<string, FlatUser> }

const TURBOPANEL_KEY = 'x-turbopanel'
const MAX_DEPTH = 4
const SECRET_NAME_RE = /pass(?:word|wd)?|secret|token|private.?key|credential|api.?key|auth/i
const SECRET_TEXT_RE = /(?:pass(?:word|wd)?|secret|token|api.?key)\s*[=:]\s*\S/i
const URL_CREDENTIALS_RE = /:\/\/[^/\s:@]+:[^/\s@]+@/

const FIELD_LABELS: Readonly<Record<string, string>> = {
  image: 'Image',
  command: 'Start command',
  entrypoint: 'Entrypoint',
  ports: 'Ports',
  volumes: 'Volumes',
  restart: 'Restart policy',
  healthcheck: 'Health check',
  'deploy.replicas': 'Instances',
  linuxUser: 'Linux user',
  'panel.source.branch': 'Branch',
  'panel.source.deployOnPush': 'Deploy on push',
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Text for a value, with object keys sorted so a reordered mapping is not a change. */
function stableText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(stableText).join(', ')
  if (isPlainObject(value)) {
    const sorted = Object.keys(value)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => `${key}: ${stableText(value[key])}`)
    return `{ ${sorted.join(', ')} }`
  }
  return String(value as string | number | boolean)
}

function looksSecret(field: string, text: string): boolean {
  const last = field.slice(field.lastIndexOf('.') + 1)
  return SECRET_NAME_RE.test(last) || SECRET_TEXT_RE.test(text) || URL_CREDENTIALS_RE.test(text)
}

function humanize(field: string): string {
  const exact = FIELD_LABELS[field]
  if (exact) return exact
  if (field.startsWith('environment.')) {
    return `Environment variable ${field.slice('environment.'.length)}`
  }
  const words = field
    .replace(/^panel\./, '')
    .replaceAll(/[._-]+/g, ' ')
    .trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Compose allows `environment: ["A=1", "B"]` as well as a mapping. */
function normalizeEnvironment(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  const out: Record<string, unknown> = {}
  for (const item of value) {
    if (typeof item !== 'string') continue
    const at = item.indexOf('=')
    if (at < 0) out[item] = null
    else out[item.slice(0, at)] = item.slice(at + 1)
  }
  return out
}

function collectLeaves(path: string, value: unknown, depth: number, out: Leaf[]): void {
  const descend = isPlainObject(value) && depth < MAX_DEPTH && path !== 'labels'
  if (!descend || Object.keys(value).length === 0) {
    out.push({ path, value })
    return
  }
  for (const [key, child] of Object.entries(value)) {
    collectLeaves(path ? `${path}.${key}` : key, child, depth + 1, out)
  }
}

function leavesOf(body: Record<string, unknown>, prefix = ''): Leaf[] {
  const out: Leaf[] = []
  for (const [key, raw] of Object.entries(body)) {
    const value = key === 'environment' ? normalizeEnvironment(raw) : raw
    collectLeaves(prefix + key, value, 1, out)
  }
  return out
}

function makeEntry(
  serviceName: string,
  area: FlatEntry['area'],
  field: string,
  value: unknown
): FlatEntry {
  const raw = stableText(value)
  return {
    key: `svc:${serviceName}:${field}`,
    area,
    field,
    label: humanize(field),
    raw,
    masked: looksSecret(field, raw),
  }
}

function domainEntries(serviceName: string, hosting: unknown): FlatEntry[] {
  if (!Array.isArray(hosting)) return []
  const out: FlatEntry[] = []
  for (const item of hosting) {
    if (!isPlainObject(item)) continue
    const hostname = readHostingHostname(item.hostname)
    if (hostname === undefined) continue
    const prefix = readHostingPathPrefix(item.pathPrefix)
    const text = prefix === undefined || prefix === '/' ? hostname : `${hostname}${prefix}`
    const entry = makeEntry(serviceName, 'domain', `domain:${text}`, text)
    out.push({ ...entry, label: 'Domain', masked: false })
  }
  return out
}

function panelEntries(serviceName: string, extension: unknown): FlatEntry[] {
  if (!isPlainObject(extension)) return []
  const out: FlatEntry[] = []
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(extension)) {
    if (key === 'principal') {
      if (typeof value === 'string' && value.length > 0) {
        out.push(makeEntry(serviceName, 'linuxUser', 'linuxUser', value))
      }
    } else if (key === 'hosting') {
      out.push(...domainEntries(serviceName, value))
    } else if (key !== 'serviceKind' && key !== 'placement') {
      rest[key] = value
    }
  }
  for (const leaf of leavesOf(rest, 'panel.')) {
    out.push(makeEntry(serviceName, 'service', leaf.path, leaf.value))
  }
  return out
}

function serviceKindOf(body: Record<string, unknown>): ConfigServiceKind {
  if (isSiteComposeService(body)) return 'site'
  if (isNodeComposeService(body)) return 'node'
  return 'container'
}

function flattenService(name: string, body: Record<string, unknown>): FlatService {
  const { [TURBOPANEL_KEY]: extension, ...compose } = body
  const entries = new Map<string, FlatEntry>()
  const add = (entry: FlatEntry) => entries.set(entry.key, entry)
  for (const leaf of leavesOf(compose)) {
    add(makeEntry(name, 'service', leaf.path, leaf.value))
  }
  for (const entry of panelEntries(name, extension)) add(entry)
  return { name, kind: serviceKindOf(body), entries }
}

function flattenUsers(data: Record<string, unknown>): Map<string, FlatUser> {
  const users = new Map<string, FlatUser>()
  const extension = data[TURBOPANEL_KEY]
  const principals = isPlainObject(extension) ? extension.principals : undefined
  if (!isPlainObject(principals)) return users
  for (const [name, spec] of Object.entries(principals)) {
    const body = isPlainObject(spec) ? spec : {}
    const access = body.access === 'sftp' || body.access === 'ssh' ? body.access : 'none'
    const description = typeof body.description === 'string' ? body.description : null
    users.set(name, { name, access, description })
  }
  return users
}

function flatten(document: ComposeDocument): FlatConfig {
  const services = new Map<string, FlatService>()
  const declared = document.data.services
  if (isPlainObject(declared)) {
    for (const [name, body] of Object.entries(declared)) {
      if (isPlainObject(body)) services.set(name, flattenService(name, body))
    }
  }
  return { services, users: flattenUsers(document.data) }
}

function isDetachedServices(value: unknown): boolean {
  const tag = composeTagOf(value)
  return tag === 'override' || tag === 'reset'
}

/**
 * True when the environment's own compose (or one of its extra layers) throws
 * the Base's services away: `services: !override ...` or `services: !reset`.
 */
export function environmentStandsAlone(layers: readonly ComposeLayer[]): boolean {
  return layers.some(
    (layer) => layer.role === 'environment' && isDetachedServices(layer.document.data.services)
  )
}

function entryView(
  entry: FlatEntry,
  baseEntry: FlatEntry | undefined,
  standsAlone: boolean
): ConfigFieldRow {
  const fromBase = !standsAlone && baseEntry?.raw === entry.raw
  return {
    key: entry.key,
    area: entry.area,
    field: entry.field,
    label: entry.label,
    value: entry.masked ? null : entry.raw,
    masked: entry.masked,
    source: fromBase ? 'base' : 'environment',
  }
}

type SideContext = {
  /** The Base's flat config, when building the effective side. */
  base: FlatConfig | null
  standsAlone: boolean
  serviceIds: ReadonlyMap<string, string>
}

function servicesView(flat: FlatConfig, context: SideContext): ConfigServiceView[] {
  return [...flat.services.values()].map((service) => {
    const baseService = context.base?.services.get(service.name)
    const inherited = context.base === null || (baseService !== undefined && !context.standsAlone)
    return {
      name: service.name,
      serviceId: context.base === null ? null : (context.serviceIds.get(service.name) ?? null),
      kind: service.kind,
      source: inherited ? 'base' : 'environment',
      rows: [...service.entries.values()].map((entry) =>
        context.base === null
          ? entryView(entry, entry, false)
          : entryView(entry, baseService?.entries.get(entry.key), context.standsAlone)
      ),
    }
  })
}

function usersView(flat: FlatConfig, context: SideContext): ConfigLinuxUserView[] {
  return [...flat.users.values()].map((user) => {
    const baseUser = context.base?.users.get(user.name)
    const same =
      context.base === null ||
      (!context.standsAlone &&
        baseUser?.access === user.access &&
        baseUser?.description === user.description)
    const usedBy = [...flat.services.values()]
      .filter((service) => service.entries.get(`svc:${service.name}:linuxUser`)?.raw === user.name)
      .map((service) => service.name)
    return {
      name: user.name,
      access: user.access,
      description: user.description,
      source: same ? 'base' : 'environment',
      usedBy,
    }
  })
}

type ChangeContext = { serviceIds: ReadonlyMap<string, string> }

function serviceChange(
  name: string,
  kind: ConfigChange['kind'],
  baseKind: string | null,
  envKind: string | null,
  context: ChangeContext
): ConfigChange {
  return {
    key: `svc:${name}`,
    area: 'service',
    label: name,
    field: null,
    serviceName: name,
    serviceId: context.serviceIds.get(name) ?? null,
    kind,
    baseValue: baseKind,
    baseSource: baseKind === null ? null : 'base',
    envValue: envKind,
    envSource: envKind === null ? null : 'environment',
    masked: false,
  }
}

function entryChange(
  serviceName: string,
  baseEntry: FlatEntry | undefined,
  envEntry: FlatEntry | undefined,
  context: ChangeContext
): ConfigChange | null {
  const entry = envEntry ?? baseEntry
  if (!entry || baseEntry?.raw === envEntry?.raw) return null
  const masked = Boolean(baseEntry?.masked || envEntry?.masked)
  const show = (side: FlatEntry | undefined) => (side && !masked ? side.raw : null)
  let kind: ConfigChange['kind'] = 'changed'
  if (!baseEntry) kind = 'added'
  else if (!envEntry) kind = 'removed'
  return {
    key: entry.key,
    area: entry.area,
    label: entry.label,
    field: entry.field,
    serviceName,
    serviceId: context.serviceIds.get(serviceName) ?? null,
    kind,
    baseValue: show(baseEntry),
    baseSource: baseEntry ? 'base' : null,
    envValue: show(envEntry),
    envSource: envEntry ? 'environment' : null,
    masked,
  }
}

function sharedServiceChanges(
  baseService: FlatService,
  envService: FlatService,
  context: ChangeContext
): ConfigChange[] {
  const out: ConfigChange[] = []
  if (baseService.kind !== envService.kind) {
    out.push({
      ...serviceChange(envService.name, 'changed', baseService.kind, envService.kind, context),
      key: `svc:${envService.name}:kind`,
      label: 'Kind of app',
      field: 'kind',
    })
  }
  const keys = new Set([...baseService.entries.keys(), ...envService.entries.keys()])
  for (const key of keys) {
    const change = entryChange(
      envService.name,
      baseService.entries.get(key),
      envService.entries.get(key),
      context
    )
    if (change) out.push(change)
  }
  return out
}

function serviceChanges(base: FlatConfig, env: FlatConfig, context: ChangeContext): ConfigChange[] {
  const out: ConfigChange[] = []
  const names = new Set([...env.services.keys(), ...base.services.keys()])
  for (const name of names) {
    const baseService = base.services.get(name)
    const envService = env.services.get(name)
    if (baseService && envService) {
      out.push(...sharedServiceChanges(baseService, envService, context))
    } else if (envService) {
      out.push(serviceChange(name, 'added', null, envService.kind, context))
    } else if (baseService) {
      out.push(serviceChange(name, 'removed', baseService.kind, null, context))
    }
  }
  return out
}

function userChange(
  baseUser: FlatUser | undefined,
  envUser: FlatUser | undefined
): ConfigChange | null {
  const user = envUser ?? baseUser
  if (!user) return null
  if (baseUser?.access === envUser?.access) return null
  let kind: ConfigChange['kind'] = 'changed'
  if (!baseUser) kind = 'added'
  else if (!envUser) kind = 'removed'
  return {
    key: `user:${user.name}`,
    area: 'linuxUser',
    label: `Sign-in access for ${user.name}`,
    field: 'access',
    serviceName: null,
    serviceId: null,
    kind,
    baseValue: baseUser?.access ?? null,
    baseSource: baseUser ? 'base' : null,
    envValue: envUser?.access ?? null,
    envSource: envUser ? 'environment' : null,
    masked: false,
  }
}

function linuxUserChanges(base: FlatConfig, env: FlatConfig): ConfigChange[] {
  const out: ConfigChange[] = []
  const names = new Set([...env.users.keys(), ...base.users.keys()])
  for (const name of names) {
    const change = userChange(base.users.get(name), env.users.get(name))
    if (change) out.push(change)
  }
  return out
}

function variableView(
  input: ConfigVariableInput,
  source: 'project' | 'environment'
): ConfigVariableView {
  return {
    key: `var:${input.key}`,
    name: input.key,
    variableId: input.id,
    value: input.isSecret ? null : input.value,
    isSecret: input.isSecret,
    forBuild: input.forBuild,
    forRuntime: input.forRuntime,
    source,
  }
}

function byName(a: ConfigVariableView, b: ConfigVariableView): number {
  return a.name.localeCompare(b.name)
}

function variableChange(
  project: ConfigVariableInput | undefined,
  env: ConfigVariableInput
): ConfigChange | null {
  // Secret values are stored sealed and never read here, so two secrets cannot
  // be compared: an environment's own secret always counts as a change.
  const masked = env.isSecret || Boolean(project?.isSecret)
  if (project && !masked && project.value === env.value) return null
  return {
    key: `var:${env.key}`,
    area: 'variable',
    label: env.key,
    field: null,
    serviceName: null,
    serviceId: null,
    kind: project ? 'changed' : 'added',
    baseValue: project && !masked ? project.value : null,
    baseSource: project ? 'project' : null,
    envValue: masked ? null : env.value,
    envSource: 'environment',
    masked,
  }
}

/**
 * Variables: the Base side is the project's own variables, the effective side
 * adds this environment's (which win by name). Organization and workspace
 * variables are not part of this view.
 */
export function buildVariableConfig(
  projectVariables: readonly ConfigVariableInput[],
  environmentVariables: readonly ConfigVariableInput[]
): { base: ConfigVariableView[]; effective: ConfigVariableView[]; changes: ConfigChange[] } {
  const projectByKey = new Map(projectVariables.map((row) => [row.key, row]))
  const effective = new Map<string, ConfigVariableView>()
  for (const row of projectVariables) effective.set(row.key, variableView(row, 'project'))
  const changes: ConfigChange[] = []
  for (const row of environmentVariables) {
    effective.set(row.key, variableView(row, 'environment'))
    const change = variableChange(projectByKey.get(row.key), row)
    if (change) changes.push(change)
  }
  return {
    base: projectVariables.map((row) => variableView(row, 'project')).sort(byName),
    effective: [...effective.values()].sort(byName),
    changes: [...changes].sort((a, b) => a.label.localeCompare(b.label)),
  }
}

export type BuildEnvironmentConfigViewInput = {
  /** From `resolveComposeLayerChain`: project layers first, then the environment's. */
  layers: readonly ComposeLayer[]
  /** This environment's service rows by compose service name. */
  serviceIds: ReadonlyMap<string, string>
  projectVariables: readonly ConfigVariableInput[]
  environmentVariables: readonly ConfigVariableInput[]
}

/** May throw when a stored layer cannot be merged; the route answers that in plain words. */
export function buildEnvironmentConfigView(
  input: BuildEnvironmentConfigViewInput
): EnvironmentConfigView {
  const standsAlone = environmentStandsAlone(input.layers)
  const baseFlat = flatten(mergeComposeLayers(input.layers.filter((l) => l.role === 'project')))
  const envFlat = flatten(mergeComposeLayers(input.layers))
  const variables = buildVariableConfig(input.projectVariables, input.environmentVariables)
  const context: SideContext = { base: baseFlat, standsAlone, serviceIds: input.serviceIds }
  const baseContext: SideContext = { base: null, standsAlone: false, serviceIds: input.serviceIds }
  return {
    followsBase: !standsAlone,
    base: {
      services: servicesView(baseFlat, baseContext),
      variables: variables.base,
      linuxUsers: usersView(baseFlat, baseContext),
    },
    effective: {
      services: servicesView(envFlat, context),
      variables: variables.effective,
      linuxUsers: usersView(envFlat, context),
    },
    changes: [
      ...serviceChanges(baseFlat, envFlat, input),
      ...linuxUserChanges(baseFlat, envFlat),
      ...variables.changes,
    ],
  }
}
