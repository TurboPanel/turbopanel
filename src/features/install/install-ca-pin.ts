/**
 * Expected certificate authority fingerprints for a self-hosted install
 * command (`TURBOPANEL_INSTANCE_CA_FINGERPRINT`).
 *
 * When the command bootstraps over insecure TLS, the installer downloads the
 * Platform CA bundle and, for a private upload, the issuer that signed the
 * leaf. Without an expected value it would keep whatever answered that
 * unverified request. The command carries the SHA-256 of every certificate
 * those documents hold, the same way cluster join tools carry a CA hash, and
 * the installer refuses a document with any certificate outside that list.
 *
 * Format: SHA-256 of the certificate DER, lowercase hex, no colons. That is
 * `openssl x509 -fingerprint -sha256` with the colons removed, and what the
 * daemon already compares. Several values are joined with commas so a CA
 * rotation window (current plus retired CA in one bundle) still installs.
 */

import { decodePemBlock, splitCertificateChain } from '../../lib/tls/pem.ts'

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/

/** Returned when a command would bootstrap insecure TLS with nothing to pin. */
export const INSTALL_CA_PIN_UNAVAILABLE =
  'The Platform CA certificate could not be read, so the install command cannot say which certificate authority new servers should trust. Check that the control plane certificates are in place, then try again.'

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** True when `value` is one fingerprint in the pinned format. */
export function isInstallCaFingerprint(value: string): boolean {
  return FINGERPRINT_PATTERN.test(value)
}

/**
 * SHA-256 fingerprint of every certificate in `pem`. Empty when the document
 * holds no certificate or any block cannot be decoded: a partial list would
 * pin a bundle the installer then refuses, so the caller treats it as none.
 */
export async function certificateFingerprints(pem: string): Promise<string[]> {
  let ders: Uint8Array[]
  try {
    ders = splitCertificateChain(pem).map((block) => decodePemBlock(block, 'CERTIFICATE'))
  } catch {
    return []
  }
  return await Promise.all(
    ders.map(async (der) => {
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(der))
      return bytesToHex(new Uint8Array(digest))
    })
  )
}

/**
 * Fingerprints of every certificate in the trust documents the installer may
 * fetch over insecure TLS, de-duplicated and in first-seen order. A missing
 * document contributes nothing. A present document that cannot be
 * fingerprinted makes the whole list empty, so the command is refused
 * instead of pinning only part of what the installer will download.
 */
export async function installCaFingerprints(
  documents: readonly (string | null | undefined)[]
): Promise<string[]> {
  const present = documents.filter((pem): pem is string => Boolean(pem))
  const perDocument = await Promise.all(present.map((pem) => certificateFingerprints(pem)))
  if (perDocument.some((fingerprints) => fingerprints.length === 0)) return []
  return [...new Set(perDocument.flat())]
}
