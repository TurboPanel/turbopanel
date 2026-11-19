/**
 * What a deploy sends when the names of one hosting row resolve to different
 * certificates (daemon feature `hosting-name-tls-v1`).
 *
 * Pure: the preparer works out each name's wire value (a pair to serve, the
 * daemon's own ACME client, or the self-signed one) and this turns the list
 * into the row-level value plus the `nameTls` entries for the names that
 * differ. When every name has the same value there is nothing to add and the
 * payload is the one every daemon already understands.
 */

import type { EnvironmentDeployNameTls } from '../../contracts/commands/schemas.ts'
import { wwwSiblingHostname } from '../../contracts/commands/hostname.ts'

/** The code a mixed row is refused with when the server's agent cannot take `nameTls`. */
export const NAME_CERTIFICATES_NEED_UPDATE = 'name_certificates_need_update'

export const NAME_CERTIFICATES_NEED_UPDATE_MESSAGE =
  "This server's agent is too old to give names in one row different certificates. Update it, or give them the same certificate."

/** One name's certificate on the wire. `tlsId: null` with no mode is the self-signed one. */
export type NameWireValue = { tlsId: string | null; tlsMode?: 'acme' }

export type NameWire = {
  hostname: string
  /** Typed by the owner; false for the www spelling the hosting's www mode adds. */
  typed: boolean
  value: NameWireValue
}

export type NameTlsPlan = {
  /** The row-level value (`tlsId`, `tlsMode`). */
  row: NameWireValue
  /** Empty when every name shares the row's value. */
  nameTls: EnvironmentDeployNameTls[]
}

function keyOf(value: NameWireValue): string {
  return `${value.tlsId ?? ''}|${value.tlsMode ?? ''}`
}

function entryFor(hostname: string, value: NameWireValue): EnvironmentDeployNameTls {
  if (value.tlsMode === 'acme') return { hostname, tlsMode: 'acme' }
  if (value.tlsId !== null) return { hostname, tlsId: value.tlsId }
  return { hostname, tlsMode: 'internal' }
}

/** True when every name has the same value. */
export function isUniform(names: readonly NameWire[]): boolean {
  const first = names[0]
  return first === undefined || names.every((n) => keyOf(n.value) === keyOf(first.value))
}

/**
 * The most common value, first in names order on a tie. With `avoidAcme` an
 * `acme` value is never picked unless nothing else is left (a row whose tunnel
 * names are not open may not ask for a public certificate at row level).
 */
function mostCommon(names: readonly NameWire[], avoidAcme: boolean): NameWireValue {
  const counts = new Map<string, { value: NameWireValue; count: number }>()
  for (const name of names) {
    const key = keyOf(name.value)
    const seen = counts.get(key)
    if (seen) seen.count += 1
    else counts.set(key, { value: name.value, count: 1 })
  }
  const all = [...counts.values()]
  const pool =
    avoidAcme && all.some((c) => c.value.tlsMode !== 'acme')
      ? all.filter((c) => c.value.tlsMode !== 'acme')
      : all
  let best = pool[0]!
  for (const candidate of pool) if (candidate.count > best.count) best = candidate
  return best.value
}

/**
 * Row-level value plus the entries for the names that differ. The daemon
 * applies an entry to its name and that name's www spelling, so an untyped www
 * name that has the same value as its typed name needs no entry of its own; one
 * whose value differs gets an explicit entry.
 */
export function planNameTls(
  names: readonly NameWire[],
  options: { avoidAcmeAtRow?: boolean } = {}
): NameTlsPlan {
  const row = mostCommon(names, options.avoidAcmeAtRow === true)
  const typed = new Map(names.filter((n) => n.typed).map((n) => [n.hostname, n]))
  const valueOfEntry = new Map<string, NameWireValue>()
  const nameTls: EnvironmentDeployNameTls[] = []
  const emit = (name: NameWire) => {
    nameTls.push(entryFor(name.hostname, name.value))
    valueOfEntry.set(name.hostname, name.value)
  }
  // Typed names first, so a partner is judged against its typed name's entry.
  for (const name of names.filter((n) => n.typed)) {
    if (keyOf(name.value) !== keyOf(row)) emit(name)
  }
  for (const name of names.filter((n) => !n.typed)) {
    const sibling = wwwSiblingHostname(name.hostname)
    const partnerOf = sibling !== null && typed.has(sibling) ? sibling : null
    const effective = (partnerOf !== null ? valueOfEntry.get(partnerOf) : undefined) ?? row
    if (keyOf(name.value) !== keyOf(effective)) emit(name)
  }
  return { row, nameTls }
}

export type NameTlsSend =
  | { ok: true; plan: NameTlsPlan }
  | { ok: false; error: typeof NAME_CERTIFICATES_NEED_UPDATE; message: string }

/**
 * {@link planNameTls} for one server. Names that share one value always plan
 * with no entries, the same payload as before the feature. Different values
 * need a daemon that lists `hosting-name-tls-v1`; otherwise the row is refused,
 * never sent with one certificate for all.
 */
export function planNameTlsForServer(
  names: readonly NameWire[],
  options: { avoidAcmeAtRow?: boolean; serverTakesNameTls: boolean }
): NameTlsSend {
  const plan = planNameTls(names, options)
  if (plan.nameTls.length > 0 && !options.serverTakesNameTls) {
    return {
      ok: false,
      error: NAME_CERTIFICATES_NEED_UPDATE,
      message: NAME_CERTIFICATES_NEED_UPDATE_MESSAGE,
    }
  }
  return { ok: true, plan }
}

/** Every pin an entry set puts in `tlsMaterial`. */
export function nameTlsPinIds(nameTls: readonly EnvironmentDeployNameTls[] | undefined): string[] {
  return (nameTls ?? []).flatMap((entry) => (entry.tlsId ? [entry.tlsId] : []))
}
