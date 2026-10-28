/**
 * Organization CA mint + leaf issue unit tests.
 */

import { assertEquals, assertRejects } from '@std/assert'
import { ecdsaDerToRaw, ecdsaRawToDer, encodeValidityTime, randomSerial } from './self-signed.ts'
import {
  buildBasicConstraintsExtension,
  buildKeyUsageExtension,
  extractSubjectNameDer,
  issueLeafCertificate,
  KEY_USAGE_CRL_SIGN,
  KEY_USAGE_DIGITAL_SIGNATURE,
  KEY_USAGE_KEY_CERT_SIGN,
  KEY_USAGE_KEY_ENCIPHERMENT,
  mintCertificateRequest,
  mintOrganizationCa,
  mintSelfSignedCertificate,
  ORGANIZATION_CA_LEAF_VALID_DAYS,
  ORGANIZATION_CA_ORG_NAME,
  ORGANIZATION_CA_ORG_UNIT,
  ORGANIZATION_CA_VALID_YEARS,
  parseCertificatePem,
  privateKeyMatchesCertificate,
  readAuthorityKeyIdentifier,
  readBasicConstraintsCa,
  readKeyUsageBits,
  readSubjectKeyIdentifier,
  verifyCertificateSignature,
} from './index.ts'
import { children, content, readNode, readOid } from './asn1.ts'
import { extractSpkiDer } from './self-signed.ts'
import { decodeFirstCertificate } from './pem.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('mintOrganizationCa produces CA:TRUE with keyCertSign keyUsage', async () => {
  const material = await mintOrganizationCa({ organizationId: 'Test Org CA' })
  const parsed = await parseCertificatePem(material.certificatePem)

  assertEquals(readBasicConstraintsCa(material.certificatePem), true)
  const keyUsage = readKeyUsageBits(material.certificatePem)
  assertEquals(keyUsage?.includes(KEY_USAGE_KEY_CERT_SIGN), true)
  assertEquals(keyUsage?.includes(KEY_USAGE_CRL_SIGN), true)
  assertEquals(parsed.subject.includes('Test Org CA'), true)
  assertEquals(parsed.issuer, parsed.subject)
  assertEquals(material.privateKeyPem.includes('BEGIN PRIVATE KEY'), true)
})

test('mintOrganizationCa subject is unique per organization', async () => {
  const orgId = '11111111-1111-4111-8111-111111111111'
  const material = await mintOrganizationCa({ organizationId: orgId })
  const parsed = await parseCertificatePem(material.certificatePem)
  assertEquals(
    parsed.subject,
    `O=${ORGANIZATION_CA_ORG_NAME}, OU=${ORGANIZATION_CA_ORG_UNIT}, CN=${orgId}`
  )
  assertEquals(parsed.issuer, parsed.subject)
})

test('mintOrganizationCa rejects a blank organizationId', async () => {
  await assertRejects(
    () => mintOrganizationCa({ organizationId: '  ' }),
    TypeError,
    'organizationId is required'
  )
})

test('issueLeafCertificate is signed by CA with CA:FALSE and SANs', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'Issuer Org CA' })
  const leaf = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    ['db.example.com', 'proxy.example.com'],
    { commonName: 'db.example.com' }
  )

  const caParsed = await parseCertificatePem(ca.certificatePem)
  const leafParsed = await parseCertificatePem(leaf.certificatePem)

  assertEquals(readBasicConstraintsCa(leaf.certificatePem), false)
  assertEquals(leafParsed.issuer, caParsed.subject)
  assertEquals(leafParsed.dnsNames.includes('db.example.com'), true)
  assertEquals(leafParsed.dnsNames.includes('proxy.example.com'), true)
  assertEquals(await verifyCertificateSignature(leaf.certificatePem, ca.certificatePem), true)
})

test('issueLeafCertificate embeds IP SANs for private listener verify-identity', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'Org CA IP SAN' })
  const leaf = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    ['managed-test', 'localhost'],
    {
      commonName: 'managed-test',
      ipAddresses: ['203.0.113.50', '203.0.113.50'],
    }
  )
  const parsed = await parseCertificatePem(leaf.certificatePem)
  assertEquals(parsed.dnsNames.includes('managed-test'), true)
  assertEquals(parsed.ipAddresses, ['203.0.113.50'])
})

test('issueLeafCertificate rejects empty dns names', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'org-empty-dns' })
  await assertRejects(
    () => issueLeafCertificate(ca.certificatePem, ca.privateKeyPem, []),
    TypeError,
    'at least one DNS name is required'
  )
})

test('ORGANIZATION_CA_LEAF_VALID_DAYS is the managed leaf default', () => {
  assertEquals(ORGANIZATION_CA_LEAF_VALID_DAYS, 90)
})

test('issueLeafCertificate honors validDays and includeClientAuth', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'org-leaf-opts' })
  const leaf = await issueLeafCertificate(
    ca.certificatePem,
    ca.privateKeyPem,
    ['leaf.example.com'],
    { validDays: 30, includeClientAuth: true, commonName: 'leaf.example.com' }
  )
  const parsed = await parseCertificatePem(leaf.certificatePem)
  const lifetimeMs = parsed.notAfter.getTime() - parsed.notBefore.getTime()
  // ~30 days (±1 day for UTCTIME second resolution / clock skew).
  assertEquals(lifetimeMs > 29 * 24 * 60 * 60 * 1000, true)
  assertEquals(lifetimeMs < 31 * 24 * 60 * 60 * 1000, true)
  assertEquals(await verifyCertificateSignature(leaf.certificatePem, ca.certificatePem), true)
})

test('issueLeafCertificate rejects invalid IP SANs', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'org-bad-ip' })
  await assertRejects(
    () =>
      issueLeafCertificate(ca.certificatePem, ca.privateKeyPem, ['db.example.com'], {
        ipAddresses: ['not-an-ip'],
      }),
    TypeError,
    'invalid IP address for SAN'
  )
})

test('issueLeafCertificate skips blank IP SAN entries', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'org-blank-ip' })
  const leaf = await issueLeafCertificate(ca.certificatePem, ca.privateKeyPem, ['db.example.com'], {
    ipAddresses: ['  ', '203.0.113.10', ''],
  })
  const parsed = await parseCertificatePem(leaf.certificatePem)
  assertEquals(parsed.ipAddresses, ['203.0.113.10'])
})

test('buildBasicConstraintsExtension and buildKeyUsageExtension encode DER', () => {
  const leafBc = buildBasicConstraintsExtension({ ca: false })
  const caBc = buildBasicConstraintsExtension({ ca: true })
  const caWithPath = buildBasicConstraintsExtension({ ca: true, pathLen: 0 })
  // Leaf and CA without pathLen are the same TLV shape (one BOOLEAN); pathLen
  // adds an INTEGER and grows the encoding.
  assertEquals(leafBc.length, caBc.length)
  assertEquals(caWithPath.length > caBc.length, true)
  assertEquals(leafBc[0], 0x30)
  assertEquals(caWithPath[0], 0x30)

  const usage = buildKeyUsageExtension([KEY_USAGE_DIGITAL_SIGNATURE, KEY_USAGE_KEY_ENCIPHERMENT])
  assertEquals(usage[0], 0x30)
  assertEquals(usage.length > 0, true)
})

test('buildKeyUsageExtension rejects empty and out-of-range bits', () => {
  try {
    buildKeyUsageExtension([])
    throw new TypeError('expected empty keyUsage to throw')
  } catch (error) {
    assertEquals(error instanceof TypeError, true)
    assertEquals((error as TypeError).message, 'at least one keyUsage bit is required')
  }
  try {
    buildKeyUsageExtension([16])
    throw new TypeError('expected out-of-range keyUsage to throw')
  } catch (error) {
    assertEquals(error instanceof TypeError, true)
    assertEquals((error as TypeError).message, 'keyUsage bit out of range: 16')
  }
})

test('extractSubjectNameDer and extractSpkiDer return non-empty TLVs', async () => {
  const material = await mintOrganizationCa({ organizationId: 'org-extract' })
  const subject = extractSubjectNameDer(material.certificatePem)
  const spki = extractSpkiDer(material.certificatePem)
  assertEquals(subject[0], 0x30)
  assertEquals(spki[0], 0x30)
  assertEquals(subject.length > 4, true)
  assertEquals(spki.length > 4, true)
})

test('verifyCertificateSignature rejects a leaf signed by a different CA', async () => {
  const caA = await mintOrganizationCa({ organizationId: 'org-a' })
  const caB = await mintOrganizationCa({ organizationId: 'org-b' })
  const leaf = await issueLeafCertificate(caA.certificatePem, caA.privateKeyPem, [
    'leaf.example.com',
  ])
  assertEquals(await verifyCertificateSignature(leaf.certificatePem, caB.certificatePem), false)
})

test('mintOrganizationCa honors custom validDays', async () => {
  const material = await mintOrganizationCa({
    organizationId: 'org-short-ca',
    validDays: 10,
  })
  const lifetimeMs = material.parsed.notAfter.getTime() - material.parsed.notBefore.getTime()
  assertEquals(lifetimeMs > 9 * 24 * 60 * 60 * 1000, true)
  assertEquals(lifetimeMs < 11 * 24 * 60 * 60 * 1000, true)
})

test('readBasicConstraintsCa is false for a self-signed leaf without CA:TRUE', async () => {
  const leaf = await mintSelfSignedCertificate(['solo.example.com'])
  // mintSelfSignedCertificate only embeds SAN — no basicConstraints extension.
  assertEquals(readBasicConstraintsCa(leaf.certificatePem), false)
  assertEquals(readKeyUsageBits(leaf.certificatePem), null)
})

test('randomSerial is always a positive, minimal DER integer (no leading zero, top bit clear)', () => {
  for (let i = 0; i < 50_000; i += 1) {
    const serial = randomSerial()
    assertEquals(serial.length, 8)
    // A leading 0x00 before a byte below 0x80 is non-minimal DER, which OpenSSL rejects.
    assertEquals(serial[0]! !== 0, true)
    assertEquals((serial[0]! & 0x80) === 0, true)
  }
})

/** Leftmost 160 bits of the SHA-256 of the subjectPublicKey BIT STRING contents (RFC 7093 key identifier). */
async function expectedKeyIdentifier(certificatePem: string): Promise<Uint8Array> {
  const spki = readNode(extractSpkiDer(certificatePem), 0)
  const bits = content(children(spki)[1]!).subarray(1)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bits.slice())).subarray(0, 20)
}

test('mintOrganizationCa carries the RFC 5280 subject key identifier', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'Ski Org CA' })
  assertEquals(
    readSubjectKeyIdentifier(ca.certificatePem),
    await expectedKeyIdentifier(ca.certificatePem)
  )
  assertEquals(readAuthorityKeyIdentifier(ca.certificatePem), null)
})

test('issueLeafCertificate carries its own SKI and an AKI equal to the CA SKI', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'Aki Org CA' })
  const leaf = await issueLeafCertificate(ca.certificatePem, ca.privateKeyPem, ['db.example.com'])
  assertEquals(
    readAuthorityKeyIdentifier(leaf.certificatePem),
    readSubjectKeyIdentifier(ca.certificatePem)
  )
  assertEquals(
    readSubjectKeyIdentifier(leaf.certificatePem),
    await expectedKeyIdentifier(leaf.certificatePem)
  )
  assertEquals(await verifyCertificateSignature(leaf.certificatePem, ca.certificatePem), true)
})

test('a leaf issued from a legacy CA without a key identifier still gets an AKI from the CA key', async () => {
  // A self-signed cert from the plain minter has no SKI, like Organization CAs minted before this change.
  const legacy = await mintSelfSignedCertificate(['legacy-ca.example.com'])
  assertEquals(readSubjectKeyIdentifier(legacy.certificatePem), null)
  const leaf = await issueLeafCertificate(legacy.certificatePem, legacy.privateKeyPem, [
    'db.example.com',
  ])
  assertEquals(
    readAuthorityKeyIdentifier(leaf.certificatePem),
    await expectedKeyIdentifier(legacy.certificatePem)
  )
})

/** Signature AlgorithmIdentifier TLVs: TBS `signature` and outer `signatureAlgorithm`. */
function signatureAlgorithmTlvs(certificatePem: string): { tbs: string; outer: string } {
  const der = decodeFirstCertificate(certificatePem)
  const cert = readNode(der, 0)
  const [tbs, outer] = children(cert)
  const tbsSig = children(tbs!)[2]!
  const hex = (node: typeof tbsSig) =>
    Array.from(der.subarray(node.contentOffset - node.headerLength, node.end), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('')
  return { tbs: hex(tbsSig), outer: hex(outer!) }
}

/** SubjectPublicKeyInfo algorithm OID and, for EC keys, the named curve OID. */
function spkiAlgorithm(certificatePem: string): { key: string; curve: string | null } {
  const spki = readNode(extractSpkiDer(certificatePem), 0)
  const [keyOid, params] = children(children(spki)[0]!)
  return { key: readOid(keyOid!), curve: params?.tag === 0x06 ? readOid(params) : null }
}

/** ecdsa-with-SHA384 with absent parameters (RFC 5758), never a NULL. */
const ECDSA_SHA384_ALG_ID_HEX = '300a06082a8648ce3d040303'
/** sha256WithRSAEncryption with NULL parameters. */
const SHA256_RSA_ALG_ID_HEX = '300d06092a864886f70d01010b0500'

test('mintOrganizationCa uses an ECDSA P-384 key and signs itself with ecdsa-with-SHA384', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'P384 Org CA' })
  assertEquals(spkiAlgorithm(ca.certificatePem), {
    key: '1.2.840.10045.2.1',
    curve: '1.3.132.0.34',
  })
  assertEquals(signatureAlgorithmTlvs(ca.certificatePem), {
    tbs: ECDSA_SHA384_ALG_ID_HEX,
    outer: ECDSA_SHA384_ALG_ID_HEX,
  })
  assertEquals(await verifyCertificateSignature(ca.certificatePem, ca.certificatePem), true)
  assertEquals(await privateKeyMatchesCertificate(ca.privateKeyPem, ca.parsed), true)
  assertEquals(readKeyUsageBits(ca.certificatePem), [KEY_USAGE_KEY_CERT_SIGN, KEY_USAGE_CRL_SIGN])
})

test('mintOrganizationCa defaults to a 15-calendar-year lifetime', async () => {
  assertEquals(ORGANIZATION_CA_VALID_YEARS, 15)
  const before = new Date()
  const ca = await mintOrganizationCa({ organizationId: 'fifteen-year-ca' })
  const expected = new Date(before)
  expected.setUTCFullYear(before.getUTCFullYear() + 15)
  const driftMs = ca.parsed.notAfter.getTime() - expected.getTime()
  // Whole-second encoding plus the time spent minting.
  assertEquals(driftMs > -1_000 && driftMs < 60_000, true)
})

test('encodeValidityTime switches from UTCTime to GeneralizedTime at 2050', () => {
  const decode = (bytes: Uint8Array) => ({
    tag: bytes[0],
    text: new TextDecoder().decode(content(readNode(bytes, 0))),
  })
  assertEquals(decode(encodeValidityTime(new Date('2041-10-15T12:34:56Z'))), {
    tag: 0x17,
    text: '411015123456Z',
  })
  assertEquals(decode(encodeValidityTime(new Date('2049-12-31T23:59:59Z'))), {
    tag: 0x17,
    text: '491231235959Z',
  })
  assertEquals(decode(encodeValidityTime(new Date('2050-01-01T00:00:00Z'))), {
    tag: 0x18,
    text: '20500101000000Z',
  })
  assertEquals(decode(encodeValidityTime(new Date('1949-12-31T23:59:59Z'))), {
    tag: 0x18,
    text: '19491231235959Z',
  })
  assertEquals(decode(encodeValidityTime(new Date('1950-01-01T00:00:00Z'))), {
    tag: 0x17,
    text: '500101000000Z',
  })
})

test('an Organization CA expiring after 2049 encodes and parses its notAfter as GeneralizedTime', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'far-future-ca', validDays: 40 * 366 })
  assertEquals(ca.parsed.notAfter.getUTCFullYear() >= 2066, true)
  const der = decodeFirstCertificate(ca.certificatePem)
  const tbs = children(readNode(der, 0))[0]!
  const [notBefore, notAfter] = children(children(tbs)[4]!)
  assertEquals(notBefore!.tag, 0x17)
  assertEquals(notAfter!.tag, 0x18)
  const leaf = await issueLeafCertificate(ca.certificatePem, ca.privateKeyPem, ['db.example.com'])
  assertEquals(await verifyCertificateSignature(leaf.certificatePem, ca.certificatePem), true)
})

test('a leaf from a P-384 Organization CA keeps an RSA key and carries ecdsa-with-SHA384', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'p384-leaf-ca' })
  const leaf = await issueLeafCertificate(ca.certificatePem, ca.privateKeyPem, ['db.example.com'], {
    includeClientAuth: true,
    ipAddresses: ['10.0.0.5'],
  })
  assertEquals(spkiAlgorithm(leaf.certificatePem), { key: '1.2.840.113549.1.1.1', curve: null })
  assertEquals(signatureAlgorithmTlvs(leaf.certificatePem), {
    tbs: ECDSA_SHA384_ALG_ID_HEX,
    outer: ECDSA_SHA384_ALG_ID_HEX,
  })
  assertEquals(await verifyCertificateSignature(leaf.certificatePem, ca.certificatePem), true)
  assertEquals(await privateKeyMatchesCertificate(leaf.privateKeyPem, leaf.parsed), true)
  const lifetimeDays =
    (leaf.parsed.notAfter.getTime() - leaf.parsed.notBefore.getTime()) / 86_400_000
  assertEquals(Math.round(lifetimeDays), ORGANIZATION_CA_LEAF_VALID_DAYS)
})

test('a leaf from an RSA issuer (Organization CAs minted before P-384) keeps sha256WithRSAEncryption', async () => {
  const legacy = await mintSelfSignedCertificate(['legacy-rsa-ca.example.com'])
  const leaf = await issueLeafCertificate(legacy.certificatePem, legacy.privateKeyPem, [
    'db.example.com',
  ])
  assertEquals(signatureAlgorithmTlvs(leaf.certificatePem), {
    tbs: SHA256_RSA_ALG_ID_HEX,
    outer: SHA256_RSA_ALG_ID_HEX,
  })
  assertEquals(await verifyCertificateSignature(leaf.certificatePem, legacy.certificatePem), true)
})

test('verifyCertificateSignature refuses a leaf checked against the other key type', async () => {
  const ecCa = await mintOrganizationCa({ organizationId: 'ec-ca' })
  const rsaCa = await mintSelfSignedCertificate(['rsa-ca.example.com'])
  const ecLeaf = await issueLeafCertificate(ecCa.certificatePem, ecCa.privateKeyPem, ['a.example'])
  const rsaLeaf = await issueLeafCertificate(rsaCa.certificatePem, rsaCa.privateKeyPem, [
    'b.example',
  ])
  assertEquals(await verifyCertificateSignature(ecLeaf.certificatePem, rsaCa.certificatePem), false)
  assertEquals(await verifyCertificateSignature(rsaLeaf.certificatePem, ecCa.certificatePem), false)
})

test('issueLeafCertificate refuses a CA key that does not match the CA certificate type', async () => {
  const ecCa = await mintOrganizationCa({ organizationId: 'mismatch-ca' })
  const rsaCa = await mintSelfSignedCertificate(['rsa-ca.example.com'])
  await assertRejects(
    () => issueLeafCertificate(ecCa.certificatePem, rsaCa.privateKeyPem, ['a.example']),
    TypeError,
    'must be EC'
  )
})

test('ecdsaRawToDer encodes minimal INTEGERs and ecdsaDerToRaw restores the fixed width', () => {
  const r = new Uint8Array(48).fill(0x11)
  r[0] = 0x00
  r[1] = 0x00
  r[2] = 0x7f
  const s = new Uint8Array(48).fill(0x22)
  s[0] = 0x80
  const raw = new Uint8Array([...r, ...s])
  const der = ecdsaRawToDer(raw)
  const [rNode, sNode] = children(readNode(der, 0))
  // Leading zero bytes stripped; a high bit gets one 0x00 so the INTEGER stays positive.
  assertEquals(content(rNode!).length, 46)
  assertEquals(content(rNode!)[0], 0x7f)
  assertEquals(content(sNode!).length, 49)
  assertEquals(content(sNode!)[0], 0x00)
  assertEquals(ecdsaDerToRaw(der, 48), raw)
  assertEquals(ecdsaDerToRaw(der, 32), null)
  assertEquals(ecdsaDerToRaw(Uint8Array.of(0x30, 0x00), 48), null)
  assertEquals(ecdsaDerToRaw(Uint8Array.of(0x04, 0x00), 48), null)
})

test('mintCertificateRequest signs a PKCS#10 request that lists every name', async () => {
  const { csrPem, privateKeyPem } = await mintCertificateRequest(['Example.com', '*.example.com'])
  assertEquals(csrPem.startsWith('-----BEGIN CERTIFICATE REQUEST-----'), true)
  assertEquals(privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----'), true)
  const body = csrPem.replace(/-----[A-Z ]+-----|\s/g, '')
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
  const [info, algorithm, signature] = children(readNode(der, 0))
  // version 0, subject, public key, then the [0] attributes carrying the names.
  const [version, subject, spki, attributes] = children(info!)
  assertEquals(content(version!), Uint8Array.of(0))
  assertEquals(attributes!.tag, 0xa0)
  // [0] holds one Attribute { extensionRequest, SET { SEQUENCE OF Extension } }.
  const [attribute] = children(attributes!)
  const [attributeOid, attributeValues] = children(attribute!)
  assertEquals(readOid(attributeOid!), '1.2.840.113549.1.9.14')
  const [extensionList] = children(attributeValues!)
  const [sanExtension] = children(extensionList!)
  assertEquals(readOid(children(sanExtension!)[0]!), '2.5.29.17')
  const text = new TextDecoder().decode(der)
  assertEquals(text.includes('example.com'), true)
  assertEquals(text.includes('*.example.com'), true)
  assertEquals(readOid(children(algorithm!)[0]!), '1.2.840.10045.4.3.2')
  // Verify the request signature with the public key it carries.
  const key = await crypto.subtle.importKey(
    'spki',
    der.subarray(spki!.contentOffset - spki!.headerLength, spki!.end),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  )
  const raw = ecdsaDerToRaw(content(signature!).subarray(1), 32)
  assertEquals(raw === null, false)
  const signed = der.subarray(info!.contentOffset - info!.headerLength, info!.end)
  assertEquals(
    await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      Uint8Array.from(raw!),
      Uint8Array.from(signed)
    ),
    true
  )
  // CN is the first name, lower-cased; the subject carries nothing else.
  assertEquals(new TextDecoder().decode(content(subject!)).includes('example.com'), true)
})

test('mintCertificateRequest makes a new key each time and rejects an empty list', async () => {
  const a = await mintCertificateRequest(['a.example.com'])
  const b = await mintCertificateRequest(['a.example.com'])
  assertEquals(a.privateKeyPem === b.privateKeyPem, false)
  await assertRejects(() => mintCertificateRequest(['  ']), TypeError)
})
