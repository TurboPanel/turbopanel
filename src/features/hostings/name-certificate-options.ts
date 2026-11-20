/**
 * The certificate choices offered for one served name, and which one a name
 * that has not been touched starts with. Pure: the caller gathers the facts
 * (doorways, bind, organization setting, covering library rows).
 *
 * Defaults, per untouched name:
 * - carried by a tunnel only (fronted): Origin, else self-signed with a reason
 * - carried by a tunnel and also directly on a datacenter address: Let's
 *   Encrypt via DNS, else self-signed
 * - direct, with a DNS token that covers the zone: Let's Encrypt via DNS
 * - otherwise Let's Encrypt via HTTP when the organization allows it, the bind
 *   is public and the name can be issued, else self-signed
 */

import type { HostingBindScope } from './hosting-options.ts'
import type { HostnameCertificate } from './name-certificate-vocabulary.ts'
import { hostnameUnsupportedReason } from './hosting-certificate.ts'

/** How a name is reached. */
export type NameReach =
  /** Only through a tunnel (the Cloudflare edge fronts it). */
  | 'tunnel'
  /** Through a tunnel and also directly on the row's own address. */
  | 'tunnel_and_direct'
  /** Not carried by any tunnel. */
  | 'direct'

/** A library certificate that covers the name. */
export type CoveringCertificate = { id: string; label: string }

export type NameOptionFacts = {
  hostname: string
  reach: NameReach
  bind: HostingBindScope
  /** The site speaks HTTP; other protocols never get a certificate choice that needs a web check. */
  isHttp: boolean
  /** The organization turned Let's Encrypt on. */
  acmeEnabled: boolean
  /** A stored DNS token covers the name's zone and a serving daemon can order over DNS. */
  dnsIssuance: boolean
  /** Why the DNS check cannot be used, in plain words (shown on the disabled option). */
  dnsUnavailableReason?: string
  /** Library certificates (other than managed Let's Encrypt and origin rows) that cover the name. */
  covering: readonly CoveringCertificate[]
}

/**
 * Whether ordering over DNS is offered. One gate for every reader of the table
 * (the choice list and the default a name moves to), so they never disagree.
 * It arrives with the relay; until then it is never offered.
 */
export const DNS_ISSUANCE_FACTS: Pick<NameOptionFacts, 'dnsIssuance' | 'dnsUnavailableReason'> = {
  dnsIssuance: false,
  dnsUnavailableReason: 'ordering over DNS is not available yet',
}

export type NameCertificateOption = {
  certificate: HostnameCertificate
  /** Set for `library` options: the row this option pins. */
  tlsId?: string
  label?: string
  available: boolean
  /** Why a disabled option is disabled. */
  reason?: string
}

export type NameCertificateOptions = {
  default: HostnameCertificate
  options: NameCertificateOption[]
}

function httpReason(facts: NameOptionFacts): string | null {
  if (!facts.acmeEnabled) return "Let's Encrypt is not turned on for this organization"
  if (!facts.isHttp) return 'only web sites can use a public certificate'
  if (facts.bind !== 'public') return 'the site is not on a public address'
  return hostnameUnsupportedReason(facts.hostname)
}

function originReason(facts: NameOptionFacts): string | null {
  return facts.reach === 'direct' ? 'no tunnel carries this name' : null
}

function dnsReason(facts: NameOptionFacts): string | null {
  if (facts.dnsIssuance) return null
  return facts.dnsUnavailableReason ?? 'no stored DNS token covers this name'
}

function pickDefault(
  facts: NameOptionFacts,
  http: string | null,
  origin: string | null,
  dns: string | null
): HostnameCertificate {
  if (facts.reach === 'tunnel') return origin === null ? 'cloudflare_origin' : 'self_signed'
  if (facts.reach === 'tunnel_and_direct') return dns === null ? 'letsencrypt_dns' : 'self_signed'
  if (dns === null) return 'letsencrypt_dns'
  return http === null ? 'letsencrypt_http' : 'self_signed'
}

/** Every choice for one name with its availability, and the default. */
export function nameCertificateOptions(facts: NameOptionFacts): NameCertificateOptions {
  const http = httpReason(facts)
  const origin = originReason(facts)
  const dns = dnsReason(facts)
  const entry = (
    certificate: HostnameCertificate,
    reason: string | null
  ): NameCertificateOption => ({
    certificate,
    available: reason === null,
    ...(reason === null ? {} : { reason }),
  })
  return {
    default: pickDefault(facts, http, origin, dns),
    options: [
      entry('cloudflare_origin', origin),
      entry('letsencrypt_dns', dns),
      entry('letsencrypt_http', http),
      entry('self_signed', null),
      ...facts.covering.map((cert): NameCertificateOption => ({
        certificate: 'library',
        tlsId: cert.id,
        label: cert.label,
        available: true,
      })),
    ],
  }
}
