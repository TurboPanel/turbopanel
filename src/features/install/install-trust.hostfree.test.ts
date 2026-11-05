import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { instanceHostname, instanceUploadedCertificate } from '../../db/schema.ts'
import { issueLeafCertificate, mintOrganizationCa } from '../../lib/tls/self-signed.ts'
import {
  privateUploadedTrustMaterial,
  privateUploadedTrustUnavailable,
  type PublicTlsAnswer,
  type PublicTlsProbe,
  resolveInstallOriginTls,
  uploadedHostnameTrust,
  uploadedTrustUnchecked,
} from './install-trust.ts'

const test = Deno.test.bind(Deno)

const HOST = 'private.example.com'
const ORIGIN = `https://${HOST}:8443`

/** The two tables the trust check reads, answered from memory. */
function memoryDb(certPem: string): Db {
  const hostnames = [
    {
      id: 'host-1',
      host: ORIGIN,
      source: 'uploaded',
      uploadedCertId: 'cert-1',
      acmeLastAttemptAt: null,
      acmeLastError: null,
      notAfter: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]
  const certificates = [{ id: 'cert-1', certPem }]
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === instanceHostname) return Promise.resolve(hostnames)
          if (table === instanceUploadedCertificate) return Promise.resolve(certificates)
          return Promise.resolve([])
        },
      }),
    }),
  } as unknown as Db
}

/** Each test signs its own leaf, so the trust cache never answers across tests. */
async function chain(id: string) {
  const ca = await mintOrganizationCa({ organizationId: `install-trust-${id}` })
  const other = await mintOrganizationCa({ organizationId: `install-trust-${id}-other` })
  const leaf = await issueLeafCertificate(ca.certificatePem, ca.privateKeyPem, [HOST])
  return {
    leaf: leaf.certificatePem.trim(),
    issuer: ca.certificatePem.trim(),
    unrelated: other.certificatePem.trim(),
  }
}

function answers(answer: PublicTlsAnswer): PublicTlsProbe {
  return () => Promise.resolve(answer)
}

const denied: PublicTlsProbe = () =>
  Promise.reject(new Deno.errors.PermissionDenied('Permission denied (os error 13)'))

test('the issuer check is in memory: the signing issuer is found, an unrelated one is not', async () => {
  const { leaf, issuer, unrelated } = await chain('memory')
  assertEquals(await privateUploadedTrustMaterial(`${leaf}\n${issuer}\n`, HOST), `${issuer}\n`)
  assertEquals(await privateUploadedTrustMaterial(`${leaf}\n${unrelated}\n`, HOST), null)
  assertEquals(await privateUploadedTrustMaterial(`${leaf}\n${leaf}\n`, HOST), null)
})

test('a broken certificate block is no issuer, never a throw', async () => {
  const { leaf } = await chain('broken')
  const broken = '-----BEGIN CERTIFICATE-----\n!!not base64!!\n-----END CERTIFICATE-----'
  assertEquals(await privateUploadedTrustMaterial(`${leaf}\n${broken}\n`, HOST), null)
  assertEquals(await privateUploadedTrustMaterial(broken, HOST), null)
})

test('the probe dials the host name and port of the uploaded address', async () => {
  const seen: [string, number][] = []
  const probe: PublicTlsProbe = (name, port) => {
    seen.push([name, port])
    return Promise.resolve('public')
  }
  assertEquals(await uploadedHostnameTrust(ORIGIN, probe), 'public')
  assertEquals(await uploadedHostnameTrust('https://plain.example.com', probe), 'public')
  assertEquals(seen, [
    [HOST, 8443],
    ['plain.example.com', 443],
  ])
})

test('a probe that throws, or no probe at all, reads as unavailable', async () => {
  assertEquals(await uploadedHostnameTrust(ORIGIN, denied), 'unavailable')
  assertEquals(await uploadedHostnameTrust(ORIGIN, null), 'unavailable')
})

test('a publicly trusted upload installs with system trust and no pinned issuer', async () => {
  const { leaf, issuer } = await chain('public')
  const db = memoryDb(`${leaf}\n${issuer}\n`)
  const result = await resolveInstallOriginTls(db, ORIGIN, {}, true, {
    probePublicTls: answers('public'),
  })
  assertEquals(result, { ok: true, insecureTls: false, caFingerprints: [] })
})

test('a private upload with its issuer installs and pins that issuer', async () => {
  const { leaf, issuer } = await chain('pinned')
  const db = memoryDb(`${leaf}\n${issuer}\n`)
  const result = await resolveInstallOriginTls(db, ORIGIN, {}, true, {
    probePublicTls: answers('private'),
  })
  assertEquals(result.ok, true)
  if (!result.ok) throw new TypeError('expected the private upload to install')
  assertEquals(result.insecureTls, true)
  assertEquals(result.caFingerprints.length, 1)
})

test('a private upload without its issuer is refused with the upload-the-issuer message', async () => {
  const { leaf, unrelated } = await chain('missing')
  const db = memoryDb(`${leaf}\n${unrelated}\n`)
  const result = await resolveInstallOriginTls(db, ORIGIN, {}, true, {
    probePublicTls: answers('private'),
  })
  assertEquals(result, { ok: false, error: privateUploadedTrustUnavailable(HOST) })
})

test('a certificate that cannot be checked is a clear refusal, never a throw', async () => {
  const { leaf, issuer } = await chain('unchecked')
  const db = memoryDb(`${leaf}\n${issuer}\n`)
  for (const probePublicTls of [denied, answers('unavailable'), null]) {
    const result = await resolveInstallOriginTls(db, ORIGIN, {}, true, { probePublicTls })
    assertEquals(result, { ok: false, error: uploadedTrustUnchecked(HOST) })
  }
})
