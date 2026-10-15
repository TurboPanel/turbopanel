import { describe, expect, it } from 'vitest'
import {
  issueLeafCertificate,
  mintOrganizationCa,
  privateKeyMatchesCertificate,
  verifyCertificateSignature,
} from './index.ts'

// The Organization CA is minted on Workers too (GET /tls/ca, rotation), so the
// P-384 key generation, PKCS#8 export and ECDSA signing must work in the Workers runtime.
describe('Organization CA (Workers Web Crypto)', () => {
  it('mints a P-384 Organization CA and signs a leaf with it', async () => {
    const ca = await mintOrganizationCa({ organizationId: '019a0000-0000-7000-8000-000000000002' })
    expect(ca.privateKeyPem).toContain('BEGIN PRIVATE KEY')
    expect(await privateKeyMatchesCertificate(ca.privateKeyPem, ca.parsed)).toBe(true)
    expect(ca.parsed.notAfter.getUTCFullYear()).toBe(new Date().getUTCFullYear() + 15)

    const leaf = await issueLeafCertificate(ca.certificatePem, ca.privateKeyPem, ['db.example.com'])
    expect(await verifyCertificateSignature(leaf.certificatePem, ca.certificatePem)).toBe(true)
  })
})
