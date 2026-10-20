/**
 * Throwaway certificates and keys in the exact shapes Caddy's certificate
 * store writes, made with the openssl command line at test time so a test
 * proves the code against a real writer and not against this repo's own
 * encoder: ECDSA keys as SEC1 (`BEGIN EC PRIVATE KEY`), RSA keys as PKCS#1
 * (`BEGIN RSA PRIVATE KEY`), and the `.crt` as the leaf followed by its issuer.
 */

import { join } from '@std/path'

export type CaddyKeyKind =
  | 'ec-p256'
  | 'ec-p384'
  | 'ec-p521'
  | 'rsa-pkcs1'
  | 'ec-p256-pkcs8'
  /** A curve Caddy never writes; used to prove it is refused. */
  | 'ec-secp256k1'

export type CaddyPair = {
  /** Leaf first, then the issuing CA, as a Caddy `.crt` holds them. */
  certificatePem: string
  /** The key as the writer stores it. */
  privateKeyPem: string
}

async function openssl(args: string[]): Promise<string> {
  const out = await new Deno.Command('openssl', {
    args,
    stdout: 'piped',
    stderr: 'piped',
  }).output()
  if (!out.success) {
    throw new Error(`openssl ${args[0]} failed: ${new TextDecoder().decode(out.stderr)}`)
  }
  return new TextDecoder().decode(out.stdout)
}

async function writeKey(kind: CaddyKeyKind, path: string): Promise<void> {
  switch (kind) {
    case 'ec-p256':
      await openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', path])
      return
    case 'ec-secp256k1':
      await openssl(['ecparam', '-name', 'secp256k1', '-genkey', '-noout', '-out', path])
      return
    case 'ec-p384':
      await openssl(['ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', path])
      return
    case 'ec-p521':
      await openssl(['ecparam', '-name', 'secp521r1', '-genkey', '-noout', '-out', path])
      return
    case 'ec-p256-pkcs8': {
      const sec1 = `${path}.sec1`
      await openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', sec1])
      await openssl(['pkcs8', '-topk8', '-nocrypt', '-in', sec1, '-out', path])
      return
    }
    case 'rsa-pkcs1':
      try {
        await openssl(['genrsa', '-traditional', '-out', path, '2048'])
      } catch {
        // Older openssl (and LibreSSL) already writes PKCS#1 and has no flag.
        await openssl(['genrsa', '-out', path, '2048'])
      }
  }
}

/** A leaf for `hostnames` signed by a throwaway CA, with its key in the form `kind` names. */
export async function makeCaddyPair(
  kind: CaddyKeyKind,
  hostnames: string[],
  days = 90
): Promise<CaddyPair> {
  const dir = await Deno.makeTempDir({ prefix: 'caddy-fixture-' })
  try {
    const caKey = join(dir, 'ca.key')
    const caCrt = join(dir, 'ca.crt')
    await openssl([
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      caKey,
      '-out',
      caCrt,
      '-days',
      '365',
      '-subj',
      '/CN=Test Issuing CA',
    ])
    const key = join(dir, 'leaf.key')
    await writeKey(kind, key)
    const csr = join(dir, 'leaf.csr')
    await openssl(['req', '-new', '-key', key, '-out', csr, '-subj', `/CN=${hostnames[0]}`])
    const ext = join(dir, 'ext.cnf')
    await Deno.writeTextFile(
      ext,
      `subjectAltName=${hostnames.map((h) => `DNS:${h}`).join(',')}\nbasicConstraints=CA:FALSE\n`
    )
    const crt = join(dir, 'leaf.crt')
    await openssl([
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      caCrt,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-out',
      crt,
      '-days',
      String(days),
      '-extfile',
      ext,
    ])
    const leaf = await Deno.readTextFile(crt)
    const ca = await Deno.readTextFile(caCrt)
    return {
      certificatePem: `${leaf.trim()}\n${ca.trim()}\n`,
      privateKeyPem: await Deno.readTextFile(key),
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}
