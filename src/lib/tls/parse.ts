/**
 * X.509 certificate parsing (Workers + Deno). Extracts DNS SANs, validity,
 * subject/issuer, SPKI, and SHA-256 fingerprint of the leaf DER.
 */

import {
  Asn1Error,
  children,
  content,
  expectTag,
  readNode,
  readOid,
  readTime,
  readUtf8OrPrintable,
  type Asn1Node,
} from './asn1.ts'
import { decodeFirstCertificate, PemError } from './pem.ts'
import type { ParsedCertificate } from './types.ts'

const OID_COMMON_NAME = '2.5.4.3'
const OID_SUBJECT_ALT_NAME = '2.5.29.17'

export class CertificateParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CertificateParseError'
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return bytesToHex(new Uint8Array(digest))
}

function readNameString(nameNode: Asn1Node): string {
  // Name ::= SEQUENCE OF RelativeDistinguishedName
  // RDN ::= SET OF AttributeTypeAndValue
  const parts: string[] = []
  for (const rdn of children(nameNode)) {
    for (const atv of children(rdn)) {
      const atvChildren = children(atv)
      if (atvChildren.length < 2) continue
      const oid = readOid(atvChildren[0]!)
      const value = readUtf8OrPrintable(atvChildren[1]!)
      if (oid === OID_COMMON_NAME) {
        parts.push(`CN=${value}`)
      } else {
        parts.push(`${oid}=${value}`)
      }
    }
  }
  return parts.join(', ')
}

function extractCommonName(nameNode: Asn1Node): string | null {
  for (const rdn of children(nameNode)) {
    for (const atv of children(rdn)) {
      const atvChildren = children(atv)
      if (atvChildren.length < 2) continue
      if (readOid(atvChildren[0]!) === OID_COMMON_NAME) {
        return readUtf8OrPrintable(atvChildren[1]!).toLowerCase()
      }
    }
  }
  return null
}

/** Resolve the SAN OCTET STRING, skipping an optional critical BOOLEAN. */
function sanOctetString(extChildren: Asn1Node[]): Asn1Node {
  let valueNode = extChildren[1]!
  if (valueNode.tag === 0x01) {
    valueNode = extChildren[2]!
  }
  expectTag(valueNode, 0x04, 'SAN OCTET STRING')
  return valueNode
}

function dnsNamesFromGeneralNames(sanSeq: Asn1Node): string[] {
  const names: string[] = []
  for (const general of children(sanSeq)) {
    // dNSName [2] IA5String
    if (general.tag !== 0x82) continue
    const dns = new TextDecoder().decode(content(general)).toLowerCase()
    if (dns.length > 0) names.push(dns)
  }
  return names
}

function parseSanDnsNames(extensionsNode: Asn1Node): string[] {
  const names: string[] = []
  for (const ext of children(extensionsNode)) {
    const extChildren = children(ext)
    if (extChildren.length < 2) continue
    if (readOid(extChildren[0]!) !== OID_SUBJECT_ALT_NAME) continue
    const valueNode = sanOctetString(extChildren)
    const sanSeq = readNode(content(valueNode), 0)
    expectTag(sanSeq, 0x30, 'GeneralNames')
    names.push(...dnsNamesFromGeneralNames(sanSeq))
  }
  return names
}

function decodeLeafDer(pem: string): Uint8Array {
  try {
    return decodeFirstCertificate(pem)
  } catch (err) {
    if (err instanceof PemError) {
      throw new CertificateParseError(err.message)
    }
    throw err
  }
}

function uniquePreservingOrder(names: string[]): string[] {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    unique.push(name)
  }
  return unique
}

function dnsNamesFromTbs(tbsChildren: Asn1Node[], fieldStart: number): string[] {
  for (let i = fieldStart; i < tbsChildren.length; i += 1) {
    const node = tbsChildren[i]!
    if (node.tag !== 0xa3) continue
    const extSeq = children(node)[0]
    if (extSeq) return parseSanDnsNames(extSeq)
  }
  return []
}

function resolveDnsNames(sanNames: string[], cn: string | null): string[] {
  if (sanNames.length > 0) return uniquePreservingOrder(sanNames)
  if (cn && !cn.includes('=')) return [cn]
  return []
}

function wrapAsn1ParseError(err: unknown): never {
  if (err instanceof CertificateParseError) throw err
  if (err instanceof Asn1Error) {
    throw new CertificateParseError(err.message)
  }
  throw new CertificateParseError(
    err instanceof Error ? err.message : 'failed to parse certificate',
  )
}

function spkiTlv(leafDer: Uint8Array, spkiNode: Asn1Node): Uint8Array {
  return leafDer.subarray(
    spkiNode.contentOffset - spkiNode.headerLength,
    spkiNode.end,
  )
}

async function parseLeafCertificate(leafDer: Uint8Array): Promise<ParsedCertificate> {
  const cert = readNode(leafDer, 0)
  expectTag(cert, 0x30, 'Certificate')
  const certChildren = children(cert)
  if (certChildren.length < 1) {
    throw new CertificateParseError('empty certificate')
  }
  const tbs = certChildren[0]!
  expectTag(tbs, 0x30, 'TBSCertificate')
  const tbsChildren = children(tbs)

  // TBSCertificate fields (optional [0] version):
  // version?, serial, signature, issuer, validity, subject, subjectPublicKeyInfo, …
  let idx = 0
  if (tbsChildren[0]?.tag === 0xa0) idx = 1
  if (tbsChildren.length < idx + 6) {
    throw new CertificateParseError('truncated TBSCertificate')
  }
  const issuerNode = tbsChildren[idx + 2]!
  const validityNode = tbsChildren[idx + 3]!
  const subjectNode = tbsChildren[idx + 4]!
  const spkiNode = tbsChildren[idx + 5]!

  expectTag(validityNode, 0x30, 'Validity')
  const validityChildren = children(validityNode)
  if (validityChildren.length < 2) {
    throw new CertificateParseError('invalid Validity')
  }
  const notBefore = readTime(validityChildren[0]!)
  const notAfter = readTime(validityChildren[1]!)

  const subject = readNameString(subjectNode)
  const issuer = readNameString(issuerNode)
  const cn = extractCommonName(subjectNode)
  const unique = resolveDnsNames(dnsNamesFromTbs(tbsChildren, idx + 6), cn)

  return {
    dnsNames: unique,
    hasWildcard: unique.some((n) => n.startsWith('*.')),
    notBefore,
    notAfter,
    fingerprintSha256: await sha256Hex(leafDer),
    subject,
    issuer,
    leafDer,
    spkiDer: spkiTlv(leafDer, spkiNode),
  }
}

/**
 * Parse the leaf certificate from a PEM chain (first CERTIFICATE block).
 */
export async function parseCertificatePem(pem: string): Promise<ParsedCertificate> {
  const leafDer = decodeLeafDer(pem)
  try {
    return await parseLeafCertificate(leafDer)
  } catch (err) {
    wrapAsn1ParseError(err)
  }
}
