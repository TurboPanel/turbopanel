import { assertEquals, assertRejects } from '@std/assert'
import type { Forge } from './forge-records.ts'
import { fetchGithubAppMetadata } from './github-app-metadata.ts'
import { GithubAppTokenError, privateKeyPemToPkcs8Der } from './github-app-token.ts'

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

function githubApp(overrides: Partial<Forge> = {}): Forge {
  return {
    id: 'app-1',
    organizationId: null,
    provider: 'github',
    name: 'TurboPanel',
    baseUrl: 'https://github.com',
    apiUrl: null,
    externalAppId: '12345',
    appSlug: 'turbopanel',
    clientId: 'Iv1.abc',
    redirectUri: null,
    webhookRef: 'ref-1',
    webhookOrigin: null,
    isPublic: true,
    customGitUser: null,
    customGitPort: null,
    syncedAt: null,
    privateKeyPem: null,
    clientSecret: null,
    webhookSecret: null,
    ...overrides,
  }
}

function withFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
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

test('fetchGithubAppMetadata rejects a non-github app', async () => {
  await assertRejects(
    () => fetchGithubAppMetadata(githubApp({ provider: 'gitlab', name: 'gitlab-app' })),
    GithubAppTokenError,
    'is not a github app',
  )
})

test('fetchGithubAppMetadata rejects a missing private key', async () => {
  await assertRejects(
    () => fetchGithubAppMetadata(githubApp({ privateKeyPem: null })),
    GithubAppTokenError,
    'no private key configured',
  )
})

test('fetchGithubAppMetadata maps a full GET /app payload', async () => {
  const pem = await generatePkcs8Pem()
  assertEquals(privateKeyPemToPkcs8Der(pem).length > 0, true)
  await withFetch((url) => {
    assertEquals(url, 'https://api.github.com/app')
    return new Response(
      JSON.stringify({
        id: 99,
        name: ' Quiet Heron ',
        slug: 'quiet-heron',
        public: true,
        permissions: { contents: 'read', extra: 1, nested: { nope: true } },
        events: ['push', 12, 'check_run'],
      }),
      { status: 200 },
    )
  }, async () => {
    assertEquals(await fetchGithubAppMetadata(githubApp({ privateKeyPem: pem })), {
      externalAppId: '99',
      name: 'Quiet Heron',
      slug: 'quiet-heron',
      isPublic: true,
      permissions: { contents: 'read' },
      events: ['push', 'check_run'],
    })
  })
})

test('fetchGithubAppMetadata treats absent public and empty slug as unknown', async () => {
  const pem = await generatePkcs8Pem()
  await withFetch(() =>
    new Response(
      JSON.stringify({
        id: '42',
        name: 'Private App',
        slug: '',
        permissions: ['not-an-object'],
        events: { push: true },
      }),
      { status: 200 },
    ), async () => {
    assertEquals(await fetchGithubAppMetadata(githubApp({ privateKeyPem: pem })), {
      externalAppId: '42',
      name: 'Private App',
      slug: null,
      isPublic: null,
      permissions: {},
      events: [],
    })
  })
})

test('fetchGithubAppMetadata maps a network failure', async () => {
  const pem = await generatePkcs8Pem()
  const original = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('dns failure'))) as typeof fetch
  try {
    await assertRejects(
      () => fetchGithubAppMetadata(githubApp({ privateKeyPem: pem })),
      GithubAppTokenError,
      'github app lookup failed: dns failure',
    )
  } finally {
    globalThis.fetch = original
  }
})

test('fetchGithubAppMetadata maps a non-Error network failure', async () => {
  const pem = await generatePkcs8Pem()
  const original = globalThis.fetch
  globalThis.fetch = (() => Promise.reject('offline')) as typeof fetch
  try {
    await assertRejects(
      () => fetchGithubAppMetadata(githubApp({ privateKeyPem: pem })),
      GithubAppTokenError,
      'github app lookup failed: network error',
    )
  } finally {
    globalThis.fetch = original
  }
})

test('fetchGithubAppMetadata maps a non-OK GitHub response', async () => {
  const pem = await generatePkcs8Pem()
  await withFetch(() => new Response('nope', { status: 401 }), async () => {
    await assertRejects(
      () => fetchGithubAppMetadata(githubApp({ privateKeyPem: pem })),
      GithubAppTokenError,
      'github app lookup failed (401)',
    )
  })
})

test('fetchGithubAppMetadata rejects an empty or incomplete body', async () => {
  const pem = await generatePkcs8Pem()
  await withFetch(() => new Response('not-json', { status: 200 }), async () => {
    await assertRejects(
      () => fetchGithubAppMetadata(githubApp({ privateKeyPem: pem })),
      GithubAppTokenError,
      'returned no body',
    )
  })
  await withFetch(
    () => new Response(JSON.stringify({ id: null, name: 'x' }), { status: 200 }),
    async () => {
      await assertRejects(
        () => fetchGithubAppMetadata(githubApp({ privateKeyPem: pem })),
        GithubAppTokenError,
        'returned no id or name',
      )
    },
  )
  await withFetch(
    () => new Response(JSON.stringify({ id: 7, name: '   ' }), { status: 200 }),
    async () => {
      await assertRejects(
        () => fetchGithubAppMetadata(githubApp({ privateKeyPem: pem })),
        GithubAppTokenError,
        'returned no id or name',
      )
    },
  )
  await withFetch(
    () => new Response(JSON.stringify({ id: { value: 7 }, name: 'Quiet Heron' }), { status: 200 }),
    async () => {
      await assertRejects(
        () => fetchGithubAppMetadata(githubApp({ privateKeyPem: pem })),
        GithubAppTokenError,
        'returned no id or name',
      )
    },
  )
})
