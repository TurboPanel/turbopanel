/**
 * `{$db.<binding>.<field>}`: read one field of a database binding of the
 * consuming service from any variable value, a Compose `environment:` value or
 * a config file.
 *
 * The values come from the binding's own stored rows (`materialize.ts`), so a
 * reference follows failover, password rotation and CA changes with no push path
 * of its own: those re-materialize the rows, the next deploy (and a daemon
 * reboot) reads them again.
 *
 * Everything here works on the **stored** form of a value (a secret is still
 * the sealed envelope), so the PHP site path never decrypts anything. Messages
 * name variables and references, never a value.
 */

import { eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'
import { binding, hosting, login, managed, variable } from '../../db/schema.ts'
import { bindingPrefixedKeys } from '../../lib/naming.ts'
import type { DbRefLookup, DeployVariableEntry } from '../compose/apply-variables.ts'
import {
  type DbRefField,
  type DbVariableRef,
  formatVariableRef,
  isDbRef,
  splitEmbeddedRefs,
  type VariableRefScope,
} from '../compose/variable-refs.ts'
import {
  resolveHostingVariables,
  type ResolvedVariableEntry,
  type ResolvedVariableMap,
} from '../variables/resolve-inherited.ts'
import { type BindingDelivery, inferStoredDelivery } from './host-run.ts'

export { DB_REF_FIELDS } from '../compose/variable-refs.ts'

type RefRow = { value: string; isSecret: boolean }

/** What a service knows about one of its bindings, read from the binding's own rows. */
export type BindingRefInfo = {
  bindingId: string
  /** `postgres`, `mysql` or `mariadb`. */
  engine: string
  delivery: BindingDelivery
  /** Stored value by variable key (a secret is still sealed). */
  rows: ReadonlyMap<string, RefRow>
}

/** Binding key prefix to what the service knows of it. */
export type BindingRefTable = ReadonlyMap<string, BindingRefInfo>

export type DbRefIssue = {
  code: 'variable_unresolved' | 'variable_ref_invalid' | 'variable_db_ref_unresolved'
  message: string
  /** The variable the reference sits in. */
  key: string
  ref: string
}

export type ApplyDbRefsOptions = {
  /** Keys set on the service itself or one of its hostnames (not inherited from above). */
  ownScopeKeys: ReadonlySet<string>
  serviceName?: string
}

export type ApplyDbRefsResult = {
  map: ResolvedVariableMap
  /** Names a PHP site's daemon fills with the CA file path (the entries are left out of the map). */
  siteCaFileNames: string[]
  /** Names holding a Postgres URL on a PHP site (the daemon adds `sslrootcert`). */
  siteUrlNames: string[]
  errors: DbRefIssue[]
  warnings: DbRefIssue[]
}

const FIELD_ROW_KEY: Partial<Record<DbRefField, keyof ReturnType<typeof bindingPrefixedKeys>>> = {
  host: 'host',
  port: 'port',
  name: 'database',
  user: 'user',
  password: 'password',
  url: 'url',
  ca_text: 'caCert',
  ssl_mode: 'sslMode',
  read_split: 'readSplit',
}

type FieldResult =
  | { kind: 'value'; value: string; isSecret: boolean; rowKey: string }
  | { kind: 'computed'; value: string }
  | { kind: 'site-ca-file' }
  | { kind: 'refused'; message: string }
  | { kind: 'missing' }

/** Read every binding of a service, with the rows each one owns. One request, one `db`. */
export async function loadBindingRefTable(db: Db, serviceId: string): Promise<BindingRefTable> {
  const bindings = await db
    .select({
      id: binding.id,
      keyPrefix: binding.keyPrefix,
      engine: managed.engine,
    })
    .from(binding)
    .innerJoin(login, eq(login.id, binding.loginId))
    .innerJoin(managed, eq(managed.id, login.managedId))
    .where(eq(binding.serviceId, serviceId))
  if (bindings.length === 0) return new Map()
  const rows = await db
    .select({
      bindingId: variable.bindingId,
      key: variable.key,
      value: variable.value,
      isSecret: variable.isSecret,
    })
    .from(variable)
    .where(
      inArray(
        variable.bindingId,
        bindings.map((row) => row.id)
      )
    )
  const table = new Map<string, BindingRefInfo>()
  for (const row of bindings) {
    if (!row.engine) continue
    const own = rows.filter((candidate) => candidate.bindingId === row.id)
    table.set(row.keyPrefix, {
      bindingId: row.id,
      engine: row.engine,
      delivery: inferStoredDelivery(own, row.keyPrefix),
      rows: new Map(own.map((r) => [r.key, { value: r.value, isSecret: r.isSecret }])),
    })
  }
  return table
}

function caFileField(info: BindingRefInfo, prefix: string): FieldResult {
  if (info.delivery === 'host-site') return { kind: 'site-ca-file' }
  if (info.delivery === 'host-node') {
    return {
      kind: 'refused',
      message: 'A Node app gets the CA as text (ca_text) for now',
    }
  }
  const rowKey = bindingPrefixedKeys(prefix).caFile
  const row = info.rows.get(rowKey)
  return row
    ? { kind: 'value', value: row.value, isSecret: row.isSecret, rowKey }
    : { kind: 'missing' }
}

/** One field of one binding, or why it is not available for this kind of service. */
export function resolveDbField(
  info: BindingRefInfo,
  prefix: string,
  field: DbRefField
): FieldResult {
  if (field === 'driver') return { kind: 'computed', value: info.engine }
  if (field === 'ca_file') return caFileField(info, prefix)
  if (field === 'ca_text' && info.delivery === 'host-site') {
    return {
      kind: 'refused',
      message: 'A PHP site gets the CA as a file; use ca_file',
    }
  }
  const slot = FIELD_ROW_KEY[field]
  if (!slot) return { kind: 'missing' }
  const rowKey = bindingPrefixedKeys(prefix)[slot]
  const row = info.rows.get(rowKey)
  return row
    ? { kind: 'value', value: row.value, isSecret: row.isSecret, rowKey }
    : { kind: 'missing' }
}

const hasDbToken = (value: string): boolean => value.includes('{$db.') || value.includes('{$$db.')

/** `{$$db.` is how a literal `{$db.` is written in a stored value. */
const unescapeDb = (text: string): string => text.replaceAll('{$$db.', '{$db.')

type Pass = {
  table: BindingRefTable
  opts: ApplyDbRefsOptions
  out: ApplyDbRefsResult
}

type EntryOutcome =
  { kind: 'keep' } | { kind: 'drop' } | { kind: 'set'; entry: ResolvedVariableEntry }

function describeUnresolved(pass: Pass, key: string, ref: DbVariableRef): string {
  const where = pass.opts.serviceName ? ` on ${pass.opts.serviceName}` : ''
  return `${key} uses ${formatVariableRef(ref)}, but this service has no database binding named "${ref.binding}"${where}`
}

/** Q4: a setting made for this app is an error; one made higher up is left out with a warning. */
function reportUnresolved(pass: Pass, key: string, ref: DbVariableRef): void {
  const issue = { key, ref: formatVariableRef(ref) }
  if (pass.opts.ownScopeKeys.has(key)) {
    pass.out.errors.push({
      ...issue,
      code: 'variable_unresolved',
      message: describeUnresolved(pass, key, ref),
    })
    return
  }
  pass.out.warnings.push({
    ...issue,
    code: 'variable_db_ref_unresolved',
    message: `${describeUnresolved(pass, key, ref)}; the variable is left out for it`,
  })
}

function reportInvalid(pass: Pass, key: string, ref: DbVariableRef, reason: string): void {
  pass.out.errors.push({
    code: 'variable_ref_invalid',
    key,
    ref: formatVariableRef(ref),
    message: `${key}: ${formatVariableRef(ref)}: ${reason}`,
  })
}

function wholeSecretEntry(info: BindingRefInfo, value: string): ResolvedVariableEntry {
  return {
    value,
    isSecret: true,
    isLiteral: true,
    forBuild: false,
    forRuntime: true,
    bindingId: info.bindingId,
  }
}

function rewriteWhole(
  pass: Pass,
  key: string,
  entry: ResolvedVariableEntry,
  ref: DbVariableRef
): EntryOutcome {
  const info = pass.table.get(ref.binding)
  if (!info) {
    reportUnresolved(pass, key, ref)
    return { kind: 'drop' }
  }
  const field = resolveDbField(info, ref.binding, ref.field)
  switch (field.kind) {
    case 'missing':
      reportUnresolved(pass, key, ref)
      return { kind: 'drop' }
    case 'refused':
      reportInvalid(pass, key, ref, field.message)
      return { kind: 'drop' }
    case 'site-ca-file':
      pass.out.siteCaFileNames.push(key)
      return { kind: 'drop' }
    case 'computed':
      return { kind: 'set', entry: { ...entry, value: field.value, forBuild: false } }
    case 'value':
      if (field.isSecret) {
        if (info.delivery === 'host-site' && info.engine === 'postgres' && ref.field === 'url') {
          pass.out.siteUrlNames.push(key)
        }
        return { kind: 'set', entry: wholeSecretEntry(info, field.value) }
      }
      return { kind: 'set', entry: { ...entry, value: field.value, forBuild: false } }
  }
}

/** The plain text a reference stands for inside a longer value, or null after reporting why not. */
function embeddedText(pass: Pass, key: string, ref: DbVariableRef): string | null {
  const info = pass.table.get(ref.binding)
  const field = info ? resolveDbField(info, ref.binding, ref.field) : ({ kind: 'missing' } as const)
  switch (field.kind) {
    case 'missing':
      reportUnresolved(pass, key, ref)
      return null
    case 'refused':
      reportInvalid(pass, key, ref, field.message)
      return null
    case 'site-ca-file':
      reportInvalid(pass, key, ref, 'On a PHP site the CA file can only be the whole value')
      return null
    case 'computed':
      return field.value
    case 'value':
      if (!field.isSecret) return field.value
      reportInvalid(pass, key, ref, 'it is secret, so it must be the whole value')
      return null
  }
}

function rewriteEmbedded(pass: Pass, key: string, entry: ResolvedVariableEntry): EntryOutcome {
  let text = ''
  let expanded = false
  let failed = false
  for (const part of splitEmbeddedRefs(entry.value)) {
    if (part.kind === 'text') text += unescapeDb(part.text)
    else if (part.kind === 'invalid') text += part.raw
    else if (!isDbRef(part.ref)) text += part.ref.raw
    else {
      const piece = embeddedText(pass, key, part.ref)
      if (piece === null) failed = true
      else text += piece
      expanded = true
    }
  }
  if (failed) return { kind: 'drop' }
  return {
    kind: 'set',
    entry: { ...entry, value: text, forBuild: expanded ? false : entry.forBuild },
  }
}

function rewriteEntry(pass: Pass, key: string, entry: ResolvedVariableEntry): EntryOutcome {
  if (entry.isSecret || entry.bindingId || !hasDbToken(entry.value)) return { kind: 'keep' }
  const whole = splitEmbeddedRefs(entry.value.trim())
  const only = whole.length === 1 ? whole[0] : undefined
  if (only?.kind === 'ref' && isDbRef(only.ref)) return rewriteWhole(pass, key, entry, only.ref)
  return rewriteEmbedded(pass, key, entry)
}

/**
 * Expand `{$db.<binding>.<field>}` in the plain values of a variable map. Pure
 * and never mutates `map` or its entries (scope maps share entry objects), and
 * what it inserts is not scanned again.
 */
export function applyDbRefs(
  map: ResolvedVariableMap,
  table: BindingRefTable,
  opts: ApplyDbRefsOptions
): ApplyDbRefsResult {
  const out: ApplyDbRefsResult = {
    map: new Map(),
    siteCaFileNames: [],
    siteUrlNames: [],
    errors: [],
    warnings: [],
  }
  const pass: Pass = { table, opts, out }
  for (const [key, entry] of map) {
    const outcome = rewriteEntry(pass, key, entry)
    if (outcome.kind === 'keep') out.map.set(key, entry)
    else if (outcome.kind === 'set') out.map.set(key, outcome.entry)
  }
  return out
}

const synthesizedKey = (ref: DbVariableRef): string =>
  `TURBOPANEL_DB_${ref.binding}_${ref.field.toUpperCase()}`

/**
 * How a Compose `environment:` value or a config file reads
 * `{$db.<binding>.<field>}`: the binding's own row from the service's resolved
 * variables (so a secret keeps its key, which a daemon reboot can find again),
 * or a plain entry for a computed field.
 */
export function dbRefLookupFor(
  table: BindingRefTable,
  inherited: ReadonlyMap<string, DeployVariableEntry>
): DbRefLookup {
  return (ref) => {
    const info = table.get(ref.binding)
    if (!info) return undefined
    const field = resolveDbField(info, ref.binding, ref.field)
    if (field.kind === 'computed') {
      return {
        key: synthesizedKey(ref),
        value: field.value,
        isSecret: false,
        isLiteral: true,
        forBuild: false,
        forRuntime: true,
      }
    }
    return field.kind === 'value' ? inherited.get(field.rowKey) : undefined
  }
}

/**
 * Names a PHP site's daemon fills for the references a service's hostings
 * hold. Same rules as {@link applyDbRefs}, which it wraps: a name dropped from
 * the environment there is the name sent here.
 */
export async function loadSiteRefNames(
  db: Db,
  serviceId: string
): Promise<{ siteCaFileNames: string[]; siteUrlNames: string[] }> {
  const hostings = await db
    .select({ id: hosting.id })
    .from(hosting)
    .where(eq(hosting.serviceId, serviceId))
  const names = { siteCaFileNames: [] as string[], siteUrlNames: [] as string[] }
  if (hostings.length === 0) return names
  const table = await loadBindingRefTable(db, serviceId)
  if (table.size === 0) return names
  for (const row of hostings) {
    const vars = await resolveHostingVariables(db, row.id)
    const result = applyDbRefs(vars.map, table, { ownScopeKeys: vars.ownKeys })
    names.siteCaFileNames.push(...result.siteCaFileNames)
    names.siteUrlNames.push(...result.siteUrlNames)
  }
  return names
}

export type ServiceDbRefsResult = {
  merged: ResolvedVariableMap
  scopes: Partial<Record<VariableRefScope, ResolvedVariableMap>>
  errors: DbRefIssue[]
  warnings: DbRefIssue[]
}

/**
 * Expand a service's references in its merged map and in every scope map (so
 * `{$service.KEY}` or `{$hosting.KEY}` never hands an app a raw token). Issues
 * are taken from the merged map only, so each is reported once.
 */
export function resolveDbRefsForService(
  table: BindingRefTable,
  input: Readonly<{
    merged: ResolvedVariableMap
    scopes: Partial<Record<VariableRefScope, ResolvedVariableMap>>
    ownScopeKeys: ReadonlySet<string>
    serviceName: string
  }>
): ServiceDbRefsResult {
  const opts = { ownScopeKeys: input.ownScopeKeys, serviceName: input.serviceName }
  const main = applyDbRefs(input.merged, table, opts)
  const scopes: Partial<Record<VariableRefScope, ResolvedVariableMap>> = {}
  for (const [scope, map] of Object.entries(input.scopes)) {
    scopes[scope as VariableRefScope] = applyDbRefs(map, table, opts).map
  }
  return { merged: main.map, scopes, errors: main.errors, warnings: main.warnings }
}

/** A map with no binding to read from: every reference is left out (no service owns it). */
export function dropDbRefs(map: ResolvedVariableMap): ResolvedVariableMap {
  return applyDbRefs(map, new Map(), { ownScopeKeys: new Set() }).map
}
