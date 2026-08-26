import { assertEquals, assertRejects, assertThrows } from '@std/assert'
import { deriveEncryptionSecretsConfig } from '../../client/authn/secrets.ts'
import { encryptSecret } from '../../client/authn/data-encryption.ts'
import type { Db } from '../../db.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { gitProviderInstallation } from '../db/schema.ts'
import {
  GITHUB_API_ACCEPT,
  GITHUB_API_BASE,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
  GithubAppTokenError,
  exchangeInstallationTokenAt,
  githubApiHeaders,
  mintGithubInstallationToken,
  privateKeyPemToPkcs8Der,
  signGithubAppJwt,
} from './github-app-token.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

async function generatePkcs8Pem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)
  const bytes = new Uint8Array(pkcs8)
  let binary = ''
  for (const byte of bytes) binary += String.fromCodePoint(byte)
  const body = btoa(binary).replaceAll(/(.{64})/g, '$1\n').trim()
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`
}

test('privateKeyPemToPkcs8Der accepts PKCS#8 PEM blocks', async () => {
  const pem = await generatePkcs8Pem()
  const der = privateKeyPemToPkcs8Der(pem)
  assertEquals(der.length > 0, true)
  assertEquals(der[0], 0x30)
})

test('privateKeyPemToPkcs8Der rejects invalid PEM', () => {
  assertThrows(
    () => privateKeyPemToPkcs8Der('not a pem'),
    GithubAppTokenError,
    'not a PEM block',
  )
  assertThrows(
    () => privateKeyPemToPkcs8Der('-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----'),
    GithubAppTokenError,
    'unsupported github app private key PEM label',
  )
})

test('githubApiHeaders sets the GitHub REST contract', () => {
  const headers = githubApiHeaders('ghs_testtoken', 'Bearer') as Record<string, string>
  assertEquals(headers.authorization, 'Bearer ghs_testtoken')
  assertEquals(headers.accept, GITHUB_API_ACCEPT)
  assertEquals(headers['x-github-api-version'], GITHUB_API_VERSION)
  assertEquals(headers['user-agent'], GITHUB_USER_AGENT)
})

test('signGithubAppJwt produces a three-part RS256 JWT', async () => {
  const pem = await generatePkcs8Pem()
  const nowMs = Date.parse('2030-06-15T12:00:00.000Z')
  const jwt = await signGithubAppJwt('12345', pem, nowMs)
  const parts = jwt.split('.')
  assertEquals(parts.length, 3)
  const header = JSON.parse(atob(parts[0]!.replaceAll('-', '+').replaceAll('_', '/')))
  const payload = JSON.parse(atob(parts[1]!.replaceAll('-', '+').replaceAll('_', '/')))
  assertEquals(header.alg, 'RS256')
  assertEquals(header.typ, 'JWT')
  assertEquals(payload.iss, '12345')
  assertEquals(typeof payload.iat, 'number')
  assertEquals(typeof payload.exp, 'number')
  assertEquals(payload.exp > payload.iat, true)
})

test('signGithubAppJwt rejects a blank app id', async () => {
  const pem = await generatePkcs8Pem()
  await assertRejects(
    () => signGithubAppJwt('  ', pem),
    GithubAppTokenError,
    'github app id is not configured',
  )
})

test('privateKeyPemToPkcs8Der rejects an empty PEM body', () => {
  assertThrows(
    () =>
      privateKeyPemToPkcs8Der(
        '-----BEGIN PRIVATE KEY-----\n\n-----END PRIVATE KEY-----',
      ),
    GithubAppTokenError,
    'PEM body is empty',
  )
})

test('privateKeyPemToPkcs8Der rejects invalid base64', () => {
  assertThrows(
    () =>
      privateKeyPemToPkcs8Der(
        '-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----',
      ),
    GithubAppTokenError,
    'not valid base64',
  )
})

test('signGithubAppJwt rejects a PEM that is not an RSA key', async () => {
  await assertRejects(
    () =>
      signGithubAppJwt(
        '1',
        '-----BEGIN PRIVATE KEY-----\nYWJjZA==\n-----END PRIVATE KEY-----\n',
      ),
    GithubAppTokenError,
    'could not be imported',
  )
})

function readDerLength(
  bytes: Uint8Array,
  offset: number,
): { length: number; header: number } {
  const first = bytes[offset]
  if (first === undefined) throw new TypeError('truncated DER length')
  if (first < 0x80) return { length: first, header: 1 }
  const count = first & 0x7f
  let length = 0
  for (let i = 0; i < count; i += 1) {
    const next = bytes[offset + 1 + i]
    if (next === undefined) throw new TypeError('truncated DER long-form length')
    length = (length << 8) | next
  }
  return { length, header: 1 + count }
}

/** Unwrap Web Crypto PKCS#8 so we can round-trip GitHub's PKCS#1 PEM form. */
function pkcs8DerToPkcs1Pem(pkcs8: Uint8Array): string {
  if (pkcs8[0] !== 0x30) throw new TypeError('PKCS#8 is not a SEQUENCE')
  const seq = readDerLength(pkcs8, 1)
  let i = 1 + seq.header
  i += 3
  if (pkcs8[i] !== 0x30) throw new TypeError('expected algorithm SEQUENCE')
  const alg = readDerLength(pkcs8, i + 1)
  i += 1 + alg.header + alg.length
  if (pkcs8[i] !== 0x04) throw new TypeError('expected OCTET STRING')
  const oct = readDerLength(pkcs8, i + 1)
  i += 1 + oct.header
  const pkcs1 = pkcs8.subarray(i, i + oct.length)
  let binary = ''
  for (const byte of pkcs1) binary += String.fromCodePoint(byte)
  const body = btoa(binary).replaceAll(/(.{64})/g, '$1\n').trim()
  return `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----\n`
}

test('signGithubAppJwt accepts GitHub PKCS#1 RSA PRIVATE KEY PEM', async () => {
  const pkcs8Pem = await generatePkcs8Pem()
  const pkcs1Pem = pkcs8DerToPkcs1Pem(privateKeyPemToPkcs8Der(pkcs8Pem))
  const jwt = await signGithubAppJwt('99', pkcs1Pem)
  assertEquals(jwt.split('.').length, 3)
})

function withFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response> | never,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    return Promise.resolve(handler(url, init))
  }) as typeof fetch
  return fn().finally(() => {
    globalThis.fetch = original
  })
}

test('githubApiHeaders uses the token scheme for installation tokens', () => {
  const headers = githubApiHeaders('ghs_install', 'token') as Record<string, string>
  assertEquals(headers.authorization, 'token ghs_install')
})

test('exchangeInstallationTokenAt returns the token and GitHub expiry', async () => {
  await withFetch((url, init) => {
    assertEquals(
      url,
      `${GITHUB_API_BASE}/app/installations/42%2F99/access_tokens`,
    )
    assertEquals(init?.method, 'POST')
    const headers = init?.headers as Record<string, string>
    assertEquals(headers.authorization, 'Bearer app-jwt')
    return new Response(
      JSON.stringify({ token: 'ghs_live', expires_at: '2030-01-01T00:00:00Z' }),
      { status: 200 },
    )
  }, async () => {
    const result = await exchangeInstallationTokenAt(GITHUB_API_BASE, 'app-jwt', '42/99')
    assertEquals(result, {
      token: 'ghs_live',
      expiresAt: '2030-01-01T00:00:00Z',
      apiBase: GITHUB_API_BASE,
    })
  })
})

test('exchangeInstallationTokenAt synthesizes expiry when GitHub omits it', async () => {
  await withFetch(
    () => new Response(JSON.stringify({ token: 'ghs_noexp' }), { status: 200 }),
    async () => {
      const result = await exchangeInstallationTokenAt(GITHUB_API_BASE, 'jwt', '1')
      assertEquals(result.token, 'ghs_noexp')
      assertEquals(Number.isNaN(Date.parse(result.expiresAt)), false)
    },
  )
})

test('exchangeInstallationTokenAt maps GitHub error bodies', async () => {
  await withFetch(
    () =>
      new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }),
    async () => {
      const error = await assertRejects(
        () => exchangeInstallationTokenAt(GITHUB_API_BASE, 'jwt', '1'),
        GithubAppTokenError,
        'Bad credentials',
      )
      assertEquals(error instanceof GithubAppTokenError, true)
      if (!(error instanceof GithubAppTokenError)) {
        throw new TypeError('expected GithubAppTokenError')
      }
      assertEquals(error.status, 401)
    },
  )
})

test('exchangeInstallationTokenAt falls back when the error body is not JSON', async () => {
  await withFetch(
    () => new Response('plain failure', { status: 502 }),
    async () => {
      await assertRejects(
        () => exchangeInstallationTokenAt(GITHUB_API_BASE, 'jwt', '1'),
        GithubAppTokenError,
        'github request failed (502)',
      )
    },
  )
})

test('exchangeInstallationTokenAt falls back when the error body is empty', async () => {
  await withFetch(
    () => new Response('', { status: 503 }),
    async () => {
      await assertRejects(
        () => exchangeInstallationTokenAt(GITHUB_API_BASE, 'jwt', '1'),
        GithubAppTokenError,
        'github request failed (503)',
      )
    },
  )
})

test('exchangeInstallationTokenAt rejects a payload with no token', async () => {
  await withFetch(
    () => new Response(JSON.stringify({ expires_at: '2030-01-01T00:00:00Z' }), { status: 201 }),
    async () => {
      await assertRejects(
        () => exchangeInstallationTokenAt(GITHUB_API_BASE, 'jwt', '1'),
        GithubAppTokenError,
        'returned no token',
      )
    },
  )
})

test('exchangeInstallationTokenAt wraps network failures', async () => {
  await withFetch(
    () => {
      throw new Error('dns failed')
    },
    async () => {
      await assertRejects(
        () => exchangeInstallationTokenAt(GITHUB_API_BASE, 'jwt', '1'),
        GithubAppTokenError,
        'dns failed',
      )
    },
  )
})

test('exchangeInstallationTokenAt wraps non-Error network failures', async () => {
  await withFetch(
    () => {
      throw 'offline'
    },
    async () => {
      await assertRejects(
        () => exchangeInstallationTokenAt(GITHUB_API_BASE, 'jwt', '1'),
        GithubAppTokenError,
        'network error',
      )
    },
  )
})

/**
 * Two shapes of read now matter: the bare installation row, and the
 * installation-joined-to-its-app that replaced the old singleton setting
 * lookup. The join is distinguished by `innerJoin` being called at all.
 */
function gitDb(opts: {
  app?: Record<string, unknown> | null
  installation?: Record<string, unknown> | null
}): Db {
  const joined = () => ({
    where: () => ({
      limit: () => Promise.resolve(opts.app ? [{ app: opts.app }] : []),
    }),
  })
  return {
    select: () => ({
      from: (table: unknown) => ({
        innerJoin: joined,
        where: () => ({
          limit: () => {
            if (table === gitProviderInstallation) {
              return Promise.resolve(opts.installation ? [opts.installation] : [])
            }
            return Promise.resolve([])
          },
        }),
      }),
    }),
  } as unknown as Db
}

async function sealedApp(privateKeyPem: string, baseUrl = 'https://github.com') {
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
  return {
    secrets,
    app: {
      id: 'app-1',
      organizationId: null,
      provider: 'github',
      name: 'TurboPanel',
      baseUrl,
      apiUrl: null,
      externalAppId: '12345',
      appSlug: null,
      clientId: null,
      redirectUri: null,
      webhookRef: 'ref-1',
      webhookTokenHash: null,
      credentials: {
        privateKeyEnvelope: await encryptSecret(secrets, privateKeyPem),
      },
    },
  }
}

test('mintGithubInstallationToken exchanges a JWT for the installation token', async () => {
  const pem = await generatePkcs8Pem()
  const { secrets, app } = await sealedApp(pem)
  const db = gitDb({
    app,
    installation: {
      provider: 'github',
      externalInstallationId: '88',
      suspendedAt: null,
    },
  })

  await withFetch((url) => {
    assertEquals(url.includes('/app/installations/88/access_tokens'), true)
    return new Response(
      JSON.stringify({ token: 'ghs_minted', expires_at: '2031-01-01T00:00:00Z' }),
      { status: 201 },
    )
  }, async () => {
    const token = await mintGithubInstallationToken(db, secrets, 'install-1')
    assertEquals(token, {
      token: 'ghs_minted',
      expiresAt: '2031-01-01T00:00:00Z',
      apiBase: GITHUB_API_BASE,
    })
  })
})

test('mintGithubInstallationToken rejects a missing App config', async () => {
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption',
  )
  await assertRejects(
    () =>
      mintGithubInstallationToken(
        gitDb({
          installation: {
            provider: 'github',
            externalInstallationId: '88',
            suspendedAt: null,
          },
        }),
        secrets,
        'install-1',
      ),
    GithubAppTokenError,
    'github app is not configured',
  )
})

test('mintGithubInstallationToken rejects a missing installation', async () => {
  const pem = await generatePkcs8Pem()
  const { secrets, app } = await sealedApp(pem)
  await assertRejects(
    () =>
      mintGithubInstallationToken(
        gitDb({ app, installation: null }),
        secrets,
        'missing',
      ),
    GithubAppTokenError,
    'installation not found',
  )
})

test('mintGithubInstallationToken rejects a non-github installation', async () => {
  const pem = await generatePkcs8Pem()
  const { secrets, app } = await sealedApp(pem)
  await assertRejects(
    () =>
      mintGithubInstallationToken(
        gitDb({
          app,
          installation: {
            provider: 'gitlab',
            externalInstallationId: '1',
            suspendedAt: null,
          },
        }),
        secrets,
        'install-1',
      ),
    GithubAppTokenError,
    'unsupported installation provider "gitlab"',
  )
})

test('mintGithubInstallationToken rejects a suspended installation', async () => {
  const pem = await generatePkcs8Pem()
  const { secrets, app } = await sealedApp(pem)
  const error = await assertRejects(
    () =>
      mintGithubInstallationToken(
        gitDb({
          app,
          installation: {
            provider: 'github',
            externalInstallationId: '1',
            suspendedAt: '2030-01-01T00:00:00.000Z',
          },
        }),
        secrets,
        'install-1',
      ),
    GithubAppTokenError,
    'installation is suspended',
  )
  if (!(error instanceof GithubAppTokenError)) {
    throw new TypeError('expected GithubAppTokenError')
  }
  assertEquals(error.status, 409)
})
