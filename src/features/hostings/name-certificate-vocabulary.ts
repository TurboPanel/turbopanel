/**
 * The certificate choices one served name can have (`hostname.certificate`).
 *
 * Pure and dependency-free so the database schema, the enum-check test, the
 * API validators and the deploy preparer all read one list.
 */
export const HOSTNAME_CERTIFICATES = [
  'cloudflare_origin',
  'letsencrypt_http',
  'letsencrypt_dns',
  'self_signed',
  'library',
] as const

export type HostnameCertificate = (typeof HOSTNAME_CERTIFICATES)[number]

export function isHostnameCertificate(value: unknown): value is HostnameCertificate {
  return typeof value === 'string' && (HOSTNAME_CERTIFICATES as readonly string[]).includes(value)
}
