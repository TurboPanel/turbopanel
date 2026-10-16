/**
 * Independent checks on the P-384 Organization CA: the runtime's own X.509
 * verifier, the `openssl` command (skipped when it is not installed), and a
 * real TLS handshake from a strict client to a server holding a leaf the CA
 * signed. Nothing here uses this package's own signature check.
 */

import { assertEquals, assertRejects, assertStringIncludes } from '@std/assert'
import { join } from '@std/path'
import { X509Certificate } from 'node:crypto'
import { concatenateOrganizationCaTrustBundle } from '../../features/tls/organization-ca.ts'
import { issueLeafCertificate, mintOrganizationCa } from './index.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG_ID = '019a0000-0000-7000-8000-000000000001'

function hasOpenssl(): boolean {
  try {
    return new Deno.Command('openssl', {
      args: ['version'],
      stdout: 'null',
      stderr: 'null',
    }).outputSync().success
  } catch {
    return false
  }
}

const OPENSSL = hasOpenssl()

async function openssl(args: string[]): Promise<{ ok: boolean; out: string }> {
  const result = await new Deno.Command('openssl', {
    args,
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
  return { ok: result.success, out: decode(result.stdout) + decode(result.stderr) }
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: 'tp-org-ca-' })
  try {
    await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

async function mintChain() {
  const ca = await mintOrganizationCa({ organizationId: ORG_ID })
  const leaf = await issueLeafCertificate(ca.certificatePem, ca.privateKeyPem, ['localhost'], {
    commonName: 'managed-interop',
    includeClientAuth: true,
    ipAddresses: ['127.0.0.1'],
  })
  return { ca, leaf }
}

test('node:crypto verifies the P-384 Organization CA and the leaf it signed', async () => {
  const { ca, leaf } = await mintChain()
  const caCert = new X509Certificate(ca.certificatePem)
  const leafCert = new X509Certificate(leaf.certificatePem)

  assertEquals(caCert.ca, true)
  assertEquals(caCert.publicKey.asymmetricKeyType, 'ec')
  assertEquals(caCert.publicKey.asymmetricKeyDetails?.namedCurve, 'secp384r1')
  assertEquals(caCert.checkIssued(caCert), true)
  assertEquals(caCert.verify(caCert.publicKey), true)
  assertEquals(new Date(caCert.validTo).getUTCFullYear(), new Date().getUTCFullYear() + 15)

  assertEquals(leafCert.ca, false)
  assertEquals(leafCert.publicKey.asymmetricKeyType, 'rsa')
  assertEquals(leafCert.checkIssued(caCert), true)
  assertEquals(leafCert.verify(caCert.publicKey), true)

  const otherCa = await mintOrganizationCa({ organizationId: ORG_ID })
  assertEquals(leafCert.verify(new X509Certificate(otherCa.certificatePem).publicKey), false)
})

test({
  name: 'openssl verify -x509_strict accepts the chain and x509 -text shows the CA contents',
  ignore: !OPENSSL,
  fn: async () => {
    const { ca, leaf } = await mintChain()
    await withTempDir(async (dir) => {
      const caPath = join(dir, 'ca.pem')
      const leafPath = join(dir, 'leaf.pem')
      await Deno.writeTextFile(caPath, ca.certificatePem)
      await Deno.writeTextFile(leafPath, leaf.certificatePem)

      const verifyLeaf = await openssl(['verify', '-x509_strict', '-CAfile', caPath, leafPath])
      assertEquals(verifyLeaf.ok, true, verifyLeaf.out)
      const verifyCa = await openssl(['verify', '-x509_strict', '-CAfile', caPath, caPath])
      assertEquals(verifyCa.ok, true, verifyCa.out)

      // `oneline,-space_eq` prints `O=TurboPanel, OU=...` on every openssl
      // release (older ones default to `O = TurboPanel`); whitespace runs are
      // collapsed because indentation differs between releases too.
      const caText = await openssl([
        'x509',
        '-noout',
        '-text',
        '-nameopt',
        'oneline,-space_eq',
        '-in',
        caPath,
      ])
      assertEquals(caText.ok, true, caText.out)
      const text = caText.out.replaceAll(/\s+/g, ' ')
      assertStringIncludes(text, 'Signature Algorithm: ecdsa-with-SHA384')
      assertStringIncludes(text, 'Public-Key: (384 bit)')
      assertStringIncludes(text, 'ASN1 OID: secp384r1')
      assertStringIncludes(text, `Issuer: O=TurboPanel, OU=Organization CA, CN=${ORG_ID}`)
      assertStringIncludes(text, `Subject: O=TurboPanel, OU=Organization CA, CN=${ORG_ID}`)
      assertStringIncludes(text, 'X509v3 Basic Constraints: critical CA:TRUE, pathlen:0')
      assertStringIncludes(text, 'X509v3 Key Usage: critical Certificate Sign, CRL Sign')
      assertStringIncludes(text, 'X509v3 Subject Key Identifier')

      const leafText = await openssl(['x509', '-noout', '-text', '-in', leafPath])
      assertStringIncludes(leafText.out, 'Signature Algorithm: ecdsa-with-SHA384')
      assertStringIncludes(leafText.out, 'Public-Key: (2048 bit)')
    })
  },
})

test({
  name: 'an overlap bundle of a pre-change RSA Organization CA and a new P-384 one trusts leaves from both',
  ignore: !OPENSSL,
  fn: async () => {
    await withTempDir(async (dir) => {
      // The shape every Organization CA had before P-384: RSA 2048, 10 years.
      const rsaCaPath = join(dir, 'rsa-ca.pem')
      const rsaKeyPath = join(dir, 'rsa-ca.key')
      const made = await openssl([
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-sha256',
        '-days',
        '3650',
        '-nodes',
        '-keyout',
        rsaKeyPath,
        '-out',
        rsaCaPath,
        '-subj',
        `/O=TurboPanel/OU=Organization CA/CN=${ORG_ID}`,
        '-addext',
        'basicConstraints=critical,CA:TRUE,pathlen:0',
        '-addext',
        'keyUsage=critical,keyCertSign,cRLSign',
        '-addext',
        'subjectKeyIdentifier=hash',
      ])
      assertEquals(made.ok, true, made.out)
      const rsaCaPem = await Deno.readTextFile(rsaCaPath)
      const rsaLeaf = await issueLeafCertificate(rsaCaPem, await Deno.readTextFile(rsaKeyPath), [
        'localhost',
      ])
      const { ca: ecCa, leaf: ecLeaf } = await mintChain()

      const bundlePath = join(dir, 'bundle.pem')
      await Deno.writeTextFile(
        bundlePath,
        concatenateOrganizationCaTrustBundle([
          { certificatePem: rsaCaPem, caState: 'retired', caGeneration: 1 },
          { certificatePem: ecCa.certificatePem, caState: 'active', caGeneration: 2 },
        ])
      )
      for (const [name, pem] of [
        ['rsa-leaf.pem', rsaLeaf.certificatePem],
        ['ec-leaf.pem', ecLeaf.certificatePem],
      ] as const) {
        const path = join(dir, name)
        await Deno.writeTextFile(path, pem)
        const verified = await openssl(['verify', '-x509_strict', '-CAfile', bundlePath, path])
        assertEquals(verified.ok, true, `${name}: ${verified.out}`)
      }
      const rsaLeafText = await openssl([
        'x509',
        '-noout',
        '-text',
        '-in',
        join(dir, 'rsa-leaf.pem'),
      ])
      assertStringIncludes(rsaLeafText.out, 'Signature Algorithm: sha256WithRSAEncryption')
    })
  },
})

async function freePort(): Promise<number> {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 })
  const { port } = listener.addr as Deno.NetAddr
  listener.close()
  return port
}

async function waitForListener(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const conn = await Deno.connect({ hostname: '127.0.0.1', port })
      conn.close()
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error(`nothing listening on ${port}`)
}

async function handshake(port: number, caPem: string): Promise<void> {
  const conn = await Deno.connectTls({ hostname: 'localhost', port, caCerts: [caPem] })
  try {
    await conn.handshake()
  } finally {
    conn.close()
  }
}

test({
  name: 'a TLS client that trusts only the P-384 Organization CA completes a verified handshake',
  ignore: !OPENSSL,
  fn: async () => {
    const { ca, leaf } = await mintChain()
    await withTempDir(async (dir) => {
      const certPath = join(dir, 'leaf.pem')
      const keyPath = join(dir, 'leaf.key')
      await Deno.writeTextFile(certPath, leaf.certificatePem)
      await Deno.writeTextFile(keyPath, leaf.privateKeyPem)
      const port = await freePort()
      const server = new Deno.Command('openssl', {
        args: [
          's_server',
          '-quiet',
          '-accept',
          `127.0.0.1:${port}`,
          '-cert',
          certPath,
          '-key',
          keyPath,
        ],
        stdin: 'piped',
        stdout: 'null',
        stderr: 'null',
      }).spawn()
      try {
        await waitForListener(port)
        // Verifies the chain and the `localhost` name against the CA alone.
        await handshake(port, ca.certificatePem)
        const otherCa = await mintOrganizationCa({ organizationId: ORG_ID })
        await assertRejects(() => handshake(port, otherCa.certificatePem))
      } finally {
        server.kill()
        await server.stdin.close().catch(() => undefined)
        await server.status
      }
    })
  },
})
