/**
 * Binding name presets: the unprefixed variable names an app expects for a
 * database connection (`DB_HOST`, `MB_DB_USER`, ...). A binding picks one
 * preset beside its prefixed set (`DATABASE_HOST`, ...).
 *
 * Every entry is a name plus a template of `{field}` tokens, the same fields a
 * `{$db.<prefix>.<field>}` reference reads. An entry whose field this delivery
 * kind cannot have is left out, never an error: an older binding must keep
 * materializing whatever its form. Pure data and pure functions, no I/O.
 */

import type { ManagedSslMode } from '../managed/ssl.ts'

export const BINDING_PRESETS = [
  'postgres',
  'mysql',
  'laravel',
  'wordpress',
  'metabase',
  'uptime-kuma',
] as const

export type BindingPreset = (typeof BINDING_PRESETS)[number]

const BINDING_PRESET_SET: ReadonlySet<string> = new Set(BINDING_PRESETS)

export function isBindingPreset(value: unknown): value is BindingPreset {
  return typeof value === 'string' && BINDING_PRESET_SET.has(value)
}

/** The fields a template may name (the reference fields a preset reads). */
type PresetField =
  'host' | 'port' | 'name' | 'user' | 'password' | 'url' | 'ssl_mode' | 'ca_file' | 'ca_text'

const SECRET_FIELDS: ReadonlySet<string> = new Set(['password', 'url', 'ca_text'])
/** Fields a PHP site must receive for the app to connect at all. */
const REQUIRED_FIELDS: ReadonlySet<string> = new Set(['host', 'port', 'name', 'user', 'password'])

const VERIFY_MODES: ReadonlySet<string> = new Set(['verify-ca', 'verify-full'])

type PresetCondition = 'verify' | 'ssl'

type PresetEntry = {
  name: string
  /** One template for every engine of the preset, or one per engine code. */
  template: string | Readonly<Record<string, string>>
  /** Only in the Postgres verify modes (`verify`) or when TLS is not off (`ssl`). */
  when?: PresetCondition
  /** Engine codes this entry applies to; omitted means every engine of the preset. */
  engines?: ReadonlySet<string>
}

type PresetDefinition = {
  label: string
  engines: ReadonlySet<string>
  entries: readonly PresetEntry[]
}

const POSTGRES_ONLY: ReadonlySet<string> = new Set(['postgres'])
const MYSQL_FAMILY: ReadonlySet<string> = new Set(['mysql', 'mariadb'])
const ALL_ENGINES: ReadonlySet<string> = new Set(['postgres', 'mysql', 'mariadb'])

const PRESET_DEFINITIONS: Readonly<Record<BindingPreset, PresetDefinition>> = {
  postgres: {
    label: 'Plain PostgreSQL',
    engines: POSTGRES_ONLY,
    entries: [
      { name: 'PGHOST', template: '{host}' },
      { name: 'PGPORT', template: '{port}' },
      { name: 'PGDATABASE', template: '{name}' },
      { name: 'PGUSER', template: '{user}' },
      { name: 'PGPASSWORD', template: '{password}' },
      { name: 'PGSSLMODE', template: '{ssl_mode}' },
      { name: 'PGSSLROOTCERT', template: '{ca_file}', when: 'verify' },
    ],
  },
  mysql: {
    label: 'Plain MySQL',
    engines: MYSQL_FAMILY,
    entries: [
      { name: 'MYSQL_HOST', template: '{host}' },
      { name: 'MYSQL_PORT', template: '{port}' },
      { name: 'MYSQL_DATABASE', template: '{name}' },
      { name: 'MYSQL_USER', template: '{user}' },
      { name: 'MYSQL_PASSWORD', template: '{password}' },
    ],
  },
  laravel: {
    label: 'Laravel',
    engines: ALL_ENGINES,
    entries: [
      {
        name: 'DB_CONNECTION',
        template: { postgres: 'pgsql', mysql: 'mysql', mariadb: 'mariadb' },
      },
      { name: 'DB_HOST', template: '{host}' },
      { name: 'DB_PORT', template: '{port}' },
      { name: 'DB_DATABASE', template: '{name}' },
      { name: 'DB_USERNAME', template: '{user}' },
      { name: 'DB_PASSWORD', template: '{password}' },
      { name: 'DB_URL', template: '{url}' },
      { name: 'DB_SSLMODE', template: '{ssl_mode}', engines: POSTGRES_ONLY },
      { name: 'MYSQL_ATTR_SSL_CA', template: '{ca_file}', engines: MYSQL_FAMILY },
    ],
  },
  wordpress: {
    label: 'WordPress',
    engines: MYSQL_FAMILY,
    entries: [
      { name: 'DB_HOST', template: '{host}:{port}' },
      { name: 'DB_USER', template: '{user}' },
      { name: 'DB_PASSWORD', template: '{password}' },
      { name: 'DB_NAME', template: '{name}' },
    ],
  },
  metabase: {
    label: 'Metabase',
    engines: ALL_ENGINES,
    entries: [
      { name: 'MB_DB_TYPE', template: { postgres: 'postgres', mysql: 'mysql', mariadb: 'mysql' } },
      { name: 'MB_DB_HOST', template: '{host}' },
      { name: 'MB_DB_PORT', template: '{port}' },
      { name: 'MB_DB_DBNAME', template: '{name}' },
      { name: 'MB_DB_USER', template: '{user}' },
      { name: 'MB_DB_PASS', template: '{password}' },
    ],
  },
  'uptime-kuma': {
    label: 'Uptime Kuma',
    engines: MYSQL_FAMILY,
    entries: [
      { name: 'UPTIME_KUMA_DB_TYPE', template: 'mariadb' },
      { name: 'UPTIME_KUMA_DB_HOSTNAME', template: '{host}' },
      { name: 'UPTIME_KUMA_DB_PORT', template: '{port}' },
      { name: 'UPTIME_KUMA_DB_NAME', template: '{name}' },
      { name: 'UPTIME_KUMA_DB_USERNAME', template: '{user}' },
      { name: 'UPTIME_KUMA_DB_PASSWORD', template: '{password}' },
      { name: 'UPTIME_KUMA_DB_SSL', template: 'true', when: 'ssl' },
      { name: 'UPTIME_KUMA_DB_CA', template: '{ca_text}' },
    ],
  },
}

/** Title-case label of a preset, for audit text and the web interface. */
export function bindingPresetLabel(preset: BindingPreset): string {
  return PRESET_DEFINITIONS[preset].label
}

/** Whether the preset's names exist for this engine. */
export function presetFitsEngine(preset: BindingPreset, engineCode: string): boolean {
  return PRESET_DEFINITIONS[preset].engines.has(engineCode)
}

/** The plain preset of an engine (the names a binding emitted before presets). */
export function plainPresetForEngine(engineCode: string): BindingPreset {
  return engineCode === 'postgres' ? 'postgres' : 'mysql'
}

/**
 * The preset a stored binding row stands for. A row written before presets
 * has none and only the toggle: the toggle on means the engine's plain names.
 */
export function effectivePreset(
  row: Readonly<{ preset: string | null; isEmitEngineDefaults: boolean }>,
  engineCode: string | null
): BindingPreset | null {
  if (isBindingPreset(row.preset)) return row.preset
  if (!row.isEmitEngineDefaults) return null
  return plainPresetForEngine(engineCode ?? 'postgres')
}

const TOKEN_RE = /\{([a-z_]+)\}/g

function templateFor(entry: PresetEntry, engineCode: string): string | null {
  if (entry.engines && !entry.engines.has(engineCode)) return null
  if (typeof entry.template === 'string') return entry.template
  return entry.template[engineCode] ?? null
}

function templateFields(template: string): string[] {
  return [...template.matchAll(TOKEN_RE)].map((m) => m[1])
}

function conditionHolds(when: PresetCondition | undefined, sslMode: string | null): boolean {
  if (when === undefined) return true
  if (sslMode === null) return false
  if (when === 'verify') return VERIFY_MODES.has(sslMode)
  return sslMode !== 'disable'
}

export type PresetRow = { key: string; value: string; isSecret: boolean }

/** Values the caller holds, by field. A field the delivery kind cannot have is absent. */
export type PresetFieldValues = Readonly<Partial<Record<PresetField, string>>>

function renderTemplate(template: string, fields: PresetFieldValues): string | null {
  let missing = false
  const out = template.replaceAll(TOKEN_RE, (_whole, field: string) => {
    const value = fields[field as PresetField]
    if (value === undefined) missing = true
    return value ?? ''
  })
  return missing ? null : out
}

/**
 * The rows a preset adds for one binding, in table order. An entry whose
 * condition fails, whose engine does not match or whose field is missing is
 * left out.
 */
export function renderPresetRows(
  preset: BindingPreset,
  params: Readonly<{
    engineCode: string
    /** The effective TLS mode, or `null` when it is not known. */
    sslMode: ManagedSslMode | null
    fields: PresetFieldValues
  }>
): PresetRow[] {
  const rows: PresetRow[] = []
  for (const entry of PRESET_DEFINITIONS[preset].entries) {
    const template = templateFor(entry, params.engineCode)
    if (template === null || !conditionHolds(entry.when, params.sslMode)) continue
    const value = renderTemplate(template, params.fields)
    if (value === null) continue
    rows.push({
      key: entry.name,
      value,
      isSecret: templateFields(template).some((field) => SECRET_FIELDS.has(field)),
    })
  }
  return rows
}

/** Names of the preset's entries for an engine, in table order (no values). */
export function presetEntryNames(preset: BindingPreset, engineCode: string): string[] {
  return PRESET_DEFINITIONS[preset].entries
    .filter((entry) => templateFor(entry, engineCode) !== null)
    .map((entry) => entry.name)
}

export type PresetSiteNames = {
  /** Names the daemon fills with the CA file path. */
  caFile: string[]
  /** Postgres URL names the daemon adds `sslrootcert` to. */
  url: string[]
  /** Names a PHP site cannot work without. */
  required: string[]
}

/**
 * What a PHP site's preset needs from the daemon. A `{ca_file}` value is only
 * known there, so it is never stored; its name travels in the deploy instead.
 */
export function presetSiteNames(
  preset: BindingPreset,
  engineCode: string,
  sslMode: string | null
): PresetSiteNames {
  const out: PresetSiteNames = { caFile: [], url: [], required: [] }
  for (const entry of PRESET_DEFINITIONS[preset].entries) {
    const template = templateFor(entry, engineCode)
    if (template === null || !conditionHolds(entry.when, sslMode)) continue
    if (template === '{ca_file}') out.caFile.push(entry.name)
    if (template === '{url}' && engineCode === 'postgres') out.url.push(entry.name)
    if (templateFields(template).some((field) => REQUIRED_FIELDS.has(field))) {
      out.required.push(entry.name)
    }
  }
  return out
}
