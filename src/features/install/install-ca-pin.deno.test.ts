import { assertEquals } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import { instanceHostname, instanceUploadedCertificate } from '../../db/schema.ts'
import { issueLeafCertificate, mintOrganizationCa } from '../../lib/tls/self-signed.ts'
import {
  certificateFingerprints,
  installCaFingerprints,
  isInstallCaFingerprint,
} from './install-ca-pin.ts'
import { resolveInstallOriginTls } from './install-trust.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function opensslFingerprint(pem: string): Promise<string | null> {
  const dir = await Deno.makeTempDir({ prefix: 'tp-ca-pin-' })
  try {
    const path = `${dir}/ca.pem`
    await Deno.writeTextFile(path, pem)
    const out = await new Deno.Command('openssl', {
      args: ['x509', '-in', path, '-noout', '-fingerprint', '-sha256'],
      stdout: 'piped',
      stderr: 'null',
    }).output()
    if (!out.success) return null
    const text = new TextDecoder().decode(out.stdout).trim()
    return text.replace(/^.*=/, '').replaceAll(':', '').toLowerCase()
  } catch {
    return null
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

function hostnameRow(host: string, source: string, uploadedCertId: string | null) {
  return {
    id: crypto.randomUUID(),
    host,
    source,
    uploadedCertId,
    acmeLastAttemptAt: null,
    acmeLastError: null,
    notAfter: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

/**
 * Stored hostnames always include a Let's Encrypt name so no legacy
 * public-URL migration runs.
 */
function memoryInstallDb(
  extra: Record<string, unknown>[] = [],
  certificates: Record<string, unknown>[] = []
): Db {
  const rows = [hostnameRow('https://acme.example.com:8443', 'lets-encrypt', null), ...extra]
  return {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              if (table === instanceHostname) return Promise.resolve(rows)
              if (table === instanceUploadedCertificate) return Promise.resolve(certificates)
              return Promise.resolve([])
            },
          }
        },
      }
    },
  } as unknown as Db
}

async function opensslAvailable(): Promise<boolean> {
  try {
    const out = await new Deno.Command('openssl', {
      args: ['version'],
      stdout: 'null',
      stderr: 'null',
    }).output()
    return out.success
  } catch {
    return false
  }
}

const HAS_OPENSSL = await opensslAvailable()

test('certificate fingerprints are 64 lowercase hex digits', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'install-ca-pin' })
  const [fingerprint] = await certificateFingerprints(ca.certificatePem)
  assertEquals(isInstallCaFingerprint(fingerprint ?? ''), true)
})

test({
  // Skipped, and reported as ignored, where openssl is not installed.
  name: 'certificate fingerprints match openssl with the colons removed (needs openssl)',
  ignore: !HAS_OPENSSL,
  fn: async () => {
    const ca = await mintOrganizationCa({ organizationId: 'install-ca-pin' })
    const [fingerprint] = await certificateFingerprints(ca.certificatePem)
    assertEquals(fingerprint, await opensslFingerprint(ca.certificatePem))
  },
})

test('every certificate in a bundle is fingerprinted once, in order', async () => {
  const current = await mintOrganizationCa({ organizationId: 'install-ca-pin-current' })
  const retired = await mintOrganizationCa({ organizationId: 'install-ca-pin-retired' })
  const bundle = `${current.certificatePem}\n${retired.certificatePem}`
  const [currentFp] = await certificateFingerprints(current.certificatePem)
  const [retiredFp] = await certificateFingerprints(retired.certificatePem)
  assertEquals(await installCaFingerprints([bundle, retired.certificatePem, null]), [
    currentFp,
    retiredFp,
  ])
  assertEquals(await certificateFingerprints('not a certificate'), [])
  assertEquals(isInstallCaFingerprint('AB:CD'), false)
})

test('an insecure-TLS origin carries the fingerprints of the Platform CA bundle', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'install-ca-pin-origin' })
  const [expected] = await certificateFingerprints(ca.certificatePem)
  const db = memoryInstallDb()
  const origin = 'https://10.0.0.5'

  const pinned = await resolveInstallOriginTls(db, origin, {}, false, {
    readPlatformCaPem: () => Promise.resolve(ca.certificatePem),
  })
  assertEquals(pinned, { ok: true, insecureTls: true, caFingerprints: [expected] })

  const unreadable = await resolveInstallOriginTls(db, origin, {}, false, {
    readPlatformCaPem: () => Promise.reject(new Deno.errors.NotFound('ca-bundle.pem')),
  })
  assertEquals(unreadable, { ok: true, insecureTls: true, caFingerprints: [] })

  const publicName = await resolveInstallOriginTls(db, 'https://acme.example.com:8443', {}, true, {
    readPlatformCaPem: () => Promise.resolve(ca.certificatePem),
  })
  assertEquals(publicName, { ok: true, insecureTls: false, caFingerprints: [] })
})

test('a private upload also pins the issuer the installer stores', async () => {
  const platform = await mintOrganizationCa({ organizationId: 'install-ca-pin-platform' })
  const issuer = await mintOrganizationCa({ organizationId: 'install-ca-pin-issuer' })
  const leaf = await issueLeafCertificate(issuer.certificatePem, issuer.privateKeyPem, [
    'private.example.com',
  ])
  const origin = 'https://private.example.com:8443'
  const db = memoryInstallDb(
    [hostnameRow(origin, 'uploaded', 'cert-private')],
    [{ id: 'cert-private', certPem: `${leaf.certificatePem}\n${issuer.certificatePem}` }]
  )
  const [platformFp] = await certificateFingerprints(platform.certificatePem)
  const [issuerFp] = await certificateFingerprints(issuer.certificatePem)
  const prepared = await resolveInstallOriginTls(db, origin, {}, true, {
    readPlatformCaPem: () => Promise.resolve(platform.certificatePem),
  })
  assertEquals(prepared, {
    ok: true,
    insecureTls: true,
    caFingerprints: [platformFp, issuerFp],
  })
})

test('an undecodable certificate block yields no fingerprints instead of throwing', async () => {
  const ca = await mintOrganizationCa({ organizationId: 'install-ca-pin-broken' })
  const broken = '-----BEGIN CERTIFICATE-----\n!!not base64!!\n-----END CERTIFICATE-----\n'
  assertEquals(await certificateFingerprints(`${ca.certificatePem}\n${broken}`), [])
  assertEquals(await installCaFingerprints([ca.certificatePem, broken]), [])
  assertEquals((await installCaFingerprints([ca.certificatePem, null])).length, 1)
})
