/**
 * Who authored a `hosting` row — the panel, or a compose document.
 *
 * A tiny pure module rather than a field on `hosting.options`, because this is
 * not an option: it is a statement about *provenance*, and two very different
 * callers need the same answer without importing each other. Deploy-prepare
 * stamps it (`../client/environments/reconcile-hostings.ts`), and the hostings
 * API reads it to refuse a mutation that the next deploy would silently undo
 * (`../client/hostings/routes.ts`).
 *
 * It lives on `hosting.metadata`, the same jsonb-with-a-marker shape
 * `principal.metadata.composeAlias` already uses for exactly the same job.
 * Rows without the marker — everything created before this existed, and
 * everything an operator creates in the panel — are untouched by any of it.
 */

/** Marker key. Truthy means the row is materialized from compose. */
export const HOSTING_COMPOSE_OWNED_METADATA_KEY = 'composeOwned'

/** Compose service the route was declared on. */
export const HOSTING_COMPOSE_SERVICE_METADATA_KEY = 'composeServiceName'

/**
 * The `(hostname, pathPrefix)` identity the entry was upserted on, as
 * `hostingEntryKey` spells it. Stored so a rename of the hostname is a
 * different route rather than an in-place edit of the old one.
 */
export const HOSTING_COMPOSE_ROUTE_METADATA_KEY = 'composeRoute'

/**
 * The authored `tls.mode`.
 *
 * `certificate` resolves to a `tls_id` and needs no marker; `automatic` and
 * `internal` both resolve to *no* pin, and without recording which was asked
 * for the two are indistinguishable on the row.
 */
export const HOSTING_COMPOSE_TLS_MODE_METADATA_KEY = 'composeTlsMode'

/**
 * True when the row **pre-existed** its declaration and was taken over.
 *
 * A route an operator had already built in the panel, which a compose document
 * later wrote down verbatim, is adopted rather than duplicated — two rows for
 * one `(hostname, pathPrefix)` is what `validateDeployHostings` refuses. The
 * marker is what makes that reversible: when the declaration goes away the
 * reconcile *releases* an adopted row (strips these keys, leaves the row) while
 * a row compose itself minted is deleted. Without it the takeover would be a
 * one-way trip that ends in deleting something the operator made.
 */
export const HOSTING_COMPOSE_ADOPTED_METADATA_KEY = 'composeAdopted'

export type HostingComposeOwner = {
  composeServiceName: string
  route: string
  tlsMode?: string
  /** See {@link HOSTING_COMPOSE_ADOPTED_METADATA_KEY}. */
  adopted?: boolean
}

function isPlainMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True when this row is materialized from a compose document. */
export function isComposeOwnedHosting(metadata: unknown): boolean {
  if (!isPlainMapping(metadata)) return false
  return metadata[HOSTING_COMPOSE_OWNED_METADATA_KEY] === true
}

/** The compose provenance recorded on a row, or null when there is none. */
export function readHostingComposeOwner(
  metadata: unknown,
): HostingComposeOwner | null {
  if (!isComposeOwnedHosting(metadata) || !isPlainMapping(metadata)) return null
  const composeServiceName = metadata[HOSTING_COMPOSE_SERVICE_METADATA_KEY]
  const route = metadata[HOSTING_COMPOSE_ROUTE_METADATA_KEY]
  if (typeof composeServiceName !== 'string' || typeof route !== 'string') {
    return null
  }
  const tlsMode = metadata[HOSTING_COMPOSE_TLS_MODE_METADATA_KEY]
  return {
    composeServiceName,
    route,
    ...(typeof tlsMode === 'string' ? { tlsMode } : {}),
    ...(metadata[HOSTING_COMPOSE_ADOPTED_METADATA_KEY] === true
      ? { adopted: true }
      : {}),
  }
}

/** True when compose took over a row the panel had already created. */
export function isAdoptedComposeHosting(metadata: unknown): boolean {
  if (!isPlainMapping(metadata)) return false
  return metadata[HOSTING_COMPOSE_ADOPTED_METADATA_KEY] === true
}

/**
 * The metadata an adopted row keeps once its declaration disappears.
 *
 * Every compose-written key is removed, so the row is indistinguishable from
 * one the panel made — including to the `409 hosting_owned_by_compose` guard,
 * which is the point: once compose stops declaring the route, editing it in
 * the panel has to work again.
 */
export function withoutHostingComposeOwner(
  existing: unknown,
): Record<string, unknown> {
  const base = isPlainMapping(existing) ? { ...existing } : {}
  delete base[HOSTING_COMPOSE_OWNED_METADATA_KEY]
  delete base[HOSTING_COMPOSE_SERVICE_METADATA_KEY]
  delete base[HOSTING_COMPOSE_ROUTE_METADATA_KEY]
  delete base[HOSTING_COMPOSE_TLS_MODE_METADATA_KEY]
  delete base[HOSTING_COMPOSE_ADOPTED_METADATA_KEY]
  return base
}

/**
 * The metadata a compose-materialized row carries.
 *
 * Merged over whatever the row already held rather than replacing it: an
 * operator note stored alongside is theirs, and the reconcile only owns the
 * keys it writes.
 */
export function withHostingComposeOwner(
  existing: unknown,
  owner: HostingComposeOwner,
): Record<string, unknown> {
  const base = isPlainMapping(existing) ? { ...existing } : {}
  base[HOSTING_COMPOSE_OWNED_METADATA_KEY] = true
  base[HOSTING_COMPOSE_SERVICE_METADATA_KEY] = owner.composeServiceName
  base[HOSTING_COMPOSE_ROUTE_METADATA_KEY] = owner.route
  if (owner.tlsMode === undefined) {
    delete base[HOSTING_COMPOSE_TLS_MODE_METADATA_KEY]
  } else {
    base[HOSTING_COMPOSE_TLS_MODE_METADATA_KEY] = owner.tlsMode
  }
  // Sticky once set: a row stays "adopted" for as long as compose owns it, so
  // the eventual prune still knows it must release rather than delete.
  if (owner.adopted || base[HOSTING_COMPOSE_ADOPTED_METADATA_KEY] === true) {
    base[HOSTING_COMPOSE_ADOPTED_METADATA_KEY] = true
  }
  return base
}
