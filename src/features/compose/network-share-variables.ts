/**
 * Resolves the `device` and `o` of one network share volume against project
 * variables, and refuses anything that could make the mount reach the host.
 *
 * `./network-shares.ts` decides which volumes are shares from the authored
 * text, before variables exist. A variable's value is not authored text: it can
 * be `bind`, a host path or another server. So the volume is checked again
 * here on the RESOLVED values, and only a plain `cifs` / `smb3` mount of a
 * `//host/share` address gets through.
 *
 * Secrets never enter the compose document. A secret named for `username` or
 * `password` in `o` leaves `o` and becomes a credentials entry: the sealed value
 * rides as `variableMaterial` and the daemon adds `username=`, `password=` and
 * `domain=` to `o` itself. A plain user name and domain move into the entry
 * with it. A secret anywhere else is refused; a literal password is refused too
 * (it would be stored in the project's compose document).
 */

import { formatVariableRef, type ParsedVariableRef, splitEmbeddedRefs } from './variable-refs.ts'

/** A project variable as the volume sees it; a secret's `value` is its sealed envelope. */
export type ShareVariable = { key: string; value: string; isSecret: boolean }

export type ShareLookup = (ref: ParsedVariableRef) => ShareVariable | undefined

export type ShareCredentialField = 'username' | 'password'

/** What an option of `o` can name: a secret login field, or the plain domain. */
type OptionField = ShareCredentialField | 'domain'

export type ShareCredentialEntry = {
  field: ShareCredentialField
  /** The secret variable's key. */
  key: string
  /** Sealed value, for `variableMaterial`; never written to YAML. */
  envelope: string
}

/**
 * One share volume's secret credentials on the wire (`networkShareCredentials`).
 * Each `*Key` is the `key` of a sealed `variableMaterial[]` entry with the same
 * `composeServiceName`; there is no value here.
 */
export type NetworkShareCredential = {
  volume: string
  composeServiceName: string
  passwordKey: string
  /** A secret user name (a `variableMaterial` key) ... */
  usernameKey?: string
  /** ... or a plain one; never both. */
  username?: string
  /** Plain domain or workgroup. */
  domain?: string
}

export type ShareVariableError = {
  kind: 'variable_unresolved' | 'variable_ref_invalid' | 'variable_secret_interpolation'
  message: string
  ref?: string
}

export type ResolvedShareVolume = {
  type: string
  /** Resolved, unescaped. */
  device: string
  /** Resolved, unescaped, credentials removed; `undefined` when nothing is left. */
  o: string | undefined
  /** Secret user name and password; present only together with a password. */
  credentials: ShareCredentialEntry[]
  /** Plain user name and domain that move into the credential entry with a password. */
  plain: { username?: string; domain?: string }
}

const CREDENTIAL_OPTION: Record<string, OptionField> = {
  username: 'username',
  user: 'username',
  password: 'password',
  pass: 'password',
  pwd: 'password',
  domain: 'domain',
  dom: 'domain',
}

/** Options the control plane and daemon own, or that turn the mount into a host reach. */
const REFUSED_OPTIONS = new Set(['credentials', 'cred', 'bind', 'rbind', 'remount', 'move'])

/** `//host/share[/path]`: no spaces and no comma, which would split `o`. */
const SHARE_ADDRESS = /^\/\/[^/\s,]+\/[^\s,]+$/

function fail(
  volume: string,
  field: string,
  kind: ShareVariableError['kind'],
  message: string,
  ref?: string
): ShareVariableError {
  return {
    kind,
    message: `${message} (volumes.${volume}.driver_opts.${field})`,
    ...(ref === undefined ? {} : { ref }),
  }
}

type Resolver = {
  volume: string
  field: string
  lookup: ShareLookup
}

/** Fill the references in `text`. Secrets are refused; a bare `$` is refused. */
function resolveText(text: string, r: Resolver): string | ShareVariableError {
  let out = ''
  for (const part of splitEmbeddedRefs(text)) {
    if (part.kind === 'text') {
      if (part.text.includes('$')) {
        return fail(
          r.volume,
          r.field,
          'variable_ref_invalid',
          'A network share volume takes {$KEY} references only, not Compose $ interpolation'
        )
      }
      out += part.text
      continue
    }
    if (part.kind === 'invalid') {
      return fail(r.volume, r.field, 'variable_ref_invalid', part.message, part.raw)
    }
    const entry = r.lookup(part.ref)
    const labeled = formatVariableRef(part.ref)
    if (!entry) {
      return fail(
        r.volume,
        r.field,
        'variable_unresolved',
        `Unresolved variable ${labeled}`,
        labeled
      )
    }
    if (entry.isSecret) {
      return fail(
        r.volume,
        r.field,
        'variable_secret_interpolation',
        `Secret ${entry.key} can only be the username, password or domain option of a network share, never part of another value`,
        labeled
      )
    }
    out += entry.value.trim()
  }
  return out
}

function isError<T>(value: T | ShareVariableError): value is ShareVariableError {
  return typeof value === 'object' && value !== null && 'kind' in value && 'message' in value
}

type OptionOutcome =
  | { kind: 'keep'; text: string }
  | { kind: 'credential'; entry: ShareCredentialEntry }
  | { kind: 'error'; error: ShareVariableError }

function optionError(error: ShareVariableError): OptionOutcome {
  return { kind: 'error', error }
}

function resolveOption(raw: string, volume: string, lookup: ShareLookup): OptionOutcome {
  const eq = raw.indexOf('=')
  const name = (eq < 0 ? raw : raw.slice(0, eq)).trim().toLowerCase()
  const value = eq < 0 ? undefined : raw.slice(eq + 1).trim()
  if (name.includes('$') || name === '') {
    return optionError(
      fail(
        volume,
        'o',
        'variable_ref_invalid',
        'An option name of a network share volume must be written out, not a variable'
      )
    )
  }
  const field = CREDENTIAL_OPTION[name]
  if (field === undefined) {
    const resolved = resolveText(raw, { volume, field: 'o', lookup })
    return isError(resolved) ? optionError(resolved) : { kind: 'keep', text: resolved.trim() }
  }
  return resolveCredentialOption({ volume, name, value: value ?? '', field }, lookup)
}

/** A `username` / `password` / `domain` option: a secret reference becomes a credential entry. */
function resolveCredentialOption(
  option: { volume: string; name: string; value: string; field: OptionField },
  lookup: ShareLookup
): OptionOutcome {
  const { volume, name, value, field } = option
  const parts = splitEmbeddedRefs(value)
  const single = parts.length === 1 && parts[0].kind === 'ref' ? parts[0] : null
  if (single) {
    const entry = lookup(single.ref)
    const labeled = formatVariableRef(single.ref)
    if (!entry) {
      return optionError(
        fail(volume, 'o', 'variable_unresolved', `Unresolved variable ${labeled}`, labeled)
      )
    }
    if (entry.isSecret) {
      return secretCredentialOption(volume, field, entry, labeled)
    }
  }
  if (field === 'password') {
    return optionError(
      fail(
        volume,
        'o',
        'variable_secret_interpolation',
        'The password of a network share must be written as {$KEY} of a secret variable; a written-out or non-secret password would be stored in the compose document'
      )
    )
  }
  const resolved = resolveText(`${name}=${value}`, { volume, field: 'o', lookup })
  return isError(resolved) ? optionError(resolved) : { kind: 'keep', text: resolved }
}

function secretCredentialOption(
  volume: string,
  field: OptionField,
  entry: ShareVariable,
  labeled: string
): OptionOutcome {
  if (field === 'domain') {
    return optionError(
      fail(
        volume,
        'o',
        'variable_secret_interpolation',
        `Secret ${entry.key} cannot be the domain of a network share; the domain is not secret`,
        labeled
      )
    )
  }
  return { kind: 'credential', entry: { field, key: entry.key, envelope: entry.value } }
}

/**
 * Resolve one share volume's `driver_opts` (`type`, `device`, `o`), or say why
 * it cannot be a share. The result is checked, not trusted: type, address and
 * flags are read from the resolved values.
 */
export function resolveShareVolume(
  volume: string,
  driverOpts: Record<string, unknown>,
  lookup: ShareLookup
): ResolvedShareVolume | ShareVariableError {
  const address = resolveShareAddress(volume, driverOpts, lookup)
  if (isError(address)) return address
  const options = resolveShareOptions(volume, driverOpts.o, lookup)
  if (isError(options)) return options
  const login = splitPlainLogin(volume, options)
  if (isError(login)) return login
  return {
    type: address.type,
    device: address.device,
    o: login.left.length === 0 ? undefined : login.left.join(','),
    credentials: options.credentials,
    plain: login.plain,
  }
}

/** The checked `type` and `//host/share` device. */
function resolveShareAddress(
  volume: string,
  driverOpts: Record<string, unknown>,
  lookup: ShareLookup
): { type: string; device: string } | ShareVariableError {
  const type = typeof driverOpts.type === 'string' ? driverOpts.type.trim().toLowerCase() : ''
  if (type !== 'cifs' && type !== 'smb3') {
    return fail(
      volume,
      'type',
      'variable_ref_invalid',
      'A network share volume must be cifs or smb3'
    )
  }
  if (typeof driverOpts.device !== 'string') {
    return fail(volume, 'device', 'variable_ref_invalid', 'A network share volume needs a device')
  }
  const device = resolveText(driverOpts.device, { volume, field: 'device', lookup })
  if (isError(device)) return device
  const address = device.trim()
  if (!SHARE_ADDRESS.test(address)) {
    return fail(
      volume,
      'device',
      'variable_ref_invalid',
      'The device of a network share must be //host/share (no spaces or commas)'
    )
  }
  return { type, device: address }
}

type ResolvedOptions = { kept: string[]; credentials: ShareCredentialEntry[] }

/** Every option of `o`, resolved: written-out options to keep and the secret login fields. */
function resolveShareOptions(
  volume: string,
  rawO: unknown,
  lookup: ShareLookup
): ResolvedOptions | ShareVariableError {
  if (rawO !== undefined && typeof rawO !== 'string') {
    return fail(volume, 'o', 'variable_ref_invalid', 'The options of a network share must be text')
  }
  const kept: string[] = []
  const credentials: ShareCredentialEntry[] = []
  for (const piece of (rawO ?? '').split(',')) {
    if (piece.trim() === '') continue
    const outcome = resolveOption(piece, volume, lookup)
    if (outcome.kind === 'error') return outcome.error
    if (outcome.kind === 'credential') {
      if (credentials.some((entry) => entry.field === outcome.entry.field)) {
        return fail(
          volume,
          'o',
          'variable_ref_invalid',
          `The ${outcome.entry.field} of a network share is given twice`
        )
      }
      credentials.push(outcome.entry)
      continue
    }
    const refused = checkKeptOption(volume, outcome.text)
    if (refused) return refused
    kept.push(outcome.text)
  }
  if (credentials.length > 0 && !credentials.some((entry) => entry.field === 'password')) {
    return fail(
      volume,
      'o',
      'variable_ref_invalid',
      'A secret user name needs the password of the network share as a secret variable too'
    )
  }
  return { kept, credentials }
}

/** What a resolved option may not be: split by a comma or line break, empty, or one the platform owns. */
function checkKeptOption(volume: string, text: string): ShareVariableError | undefined {
  if (text.includes(',') || /[\r\n]/.test(text)) {
    return fail(
      volume,
      'o',
      'variable_ref_invalid',
      'A variable used in the options of a network share must not contain a comma or a line break'
    )
  }
  const optionName = text.split('=')[0].trim().toLowerCase()
  if (text.includes('=') && text.slice(text.indexOf('=') + 1).trim() === '') {
    return fail(
      volume,
      'o',
      'variable_ref_invalid',
      `The option ${optionName} of a network share has an empty value (is its variable empty?)`
    )
  }
  if (REFUSED_OPTIONS.has(optionName)) {
    return fail(
      volume,
      'o',
      'variable_ref_invalid',
      `The ${optionName} option is not allowed on a network share volume`
    )
  }
  return undefined
}

/**
 * With a password the daemon adds the login to `o` itself, so a plain user
 * name and domain move out of `o` and into the credential entry.
 */
function splitPlainLogin(
  volume: string,
  options: ResolvedOptions
): { plain: ResolvedShareVolume['plain']; left: string[] } | ShareVariableError {
  const hasPassword = options.credentials.some((entry) => entry.field === 'password')
  const secretUsername = options.credentials.some((entry) => entry.field === 'username')
  const plain: ResolvedShareVolume['plain'] = {}
  const left: string[] = []
  for (const text of options.kept) {
    const optionName = text.split('=')[0].trim().toLowerCase()
    const value = text.includes('=') ? text.slice(text.indexOf('=') + 1).trim() : ''
    const field = CREDENTIAL_OPTION[optionName]
    if (!hasPassword || field === 'password' || field === undefined) {
      left.push(text)
      continue
    }
    const duplicate = plain[field] !== undefined || (field === 'username' && secretUsername)
    if (duplicate) {
      return fail(
        volume,
        'o',
        'variable_ref_invalid',
        `The ${field} of a network share is given twice`
      )
    }
    plain[field] = value
  }
  return { plain, left }
}

/** Stable text of the resolved volumes: what the host will actually be told to mount. */
export function resolvedSharesCanonical(
  volumes: ReadonlyArray<readonly [string, ResolvedShareVolume]>
): string {
  const rows = [...volumes]
    .sort(([a], [b]) => (a < b ? -1 : Number(a > b)))
    .map(([name, v]) => [
      name,
      v.type,
      v.device,
      v.o ?? '',
      // Which secret fills which field, never the value.
      v.credentials
        .map((entry) => `${entry.field}:${entry.key}`)
        .sort((a, b) => (a < b ? -1 : Number(a > b))),
      v.plain.username ?? '',
      v.plain.domain ?? '',
    ])
  return JSON.stringify(rows)
}
