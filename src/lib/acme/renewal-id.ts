/**
 * The identifier ACME Renewal Information (RFC 9773) uses for a certificate:
 * the base64url authority key identifier, a dot, and the base64url serial
 * number, both as they appear in the certificate.
 */
import { base64urlEncode } from '../encoding/base64url.ts'
import { children, content, readNode } from '../tls/asn1.ts'
import { decodeFirstCertificate } from '../tls/pem.ts'
import { readAuthorityKeyIdentifier } from '../tls/self-signed.ts'

/** The serial number's DER integer bytes, with the sign byte kept as in the certificate. */
function serialBytes(certificatePem: string): Uint8Array | null {
  const certificate = readNode(decodeFirstCertificate(certificatePem))
  const tbs = children(certificate)[0]
  const fields = tbs ? children(tbs) : []
  // The first field is the explicit version when present; the serial follows it.
  const serial = fields[0]?.tag === 0xa0 ? fields[1] : fields[0]
  return serial?.tag === 0x02 ? content(serial) : null
}

/** The renewal-information identifier of a leaf certificate, or null when it lacks the fields. */
export function renewalCertId(certificatePem: string): string | null {
  try {
    const aki = readAuthorityKeyIdentifier(certificatePem)
    const serial = serialBytes(certificatePem)
    if (!aki || !serial) return null
    // RFC 9773 wants the serial without a leading sign byte.
    const trimmed = serial[0] === 0 && serial.length > 1 ? serial.slice(1) : serial
    return `${base64urlEncode(aki)}.${base64urlEncode(trimmed)}`
  } catch {
    return null
  }
}
