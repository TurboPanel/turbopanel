import { assert, assertEquals } from '@std/assert'
import {
  getUpdateManifestRefusal,
  resetUpdateManifestCacheForTests as resetToPinnedKey,
  setUpdateManifestTrustKeyForTests,
  resolveUpdateManifest,
  seedUpdateManifestCacheForTests,
  setUpdateManifestProvider,
  setUpdateManifestRetryDelaysForTests,
} from './manifest.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const TRUNK_MANIFEST_URL = 'https://dl.trbp.nl/channels/trunk/manifest.json'
const RC_MANIFEST_URL =
  'https://github.com/TurboPanel/turbopaneld/releases/download/rc/manifest.json'
const RELEASE_MANIFEST_URL =
  'https://github.com/TurboPanel/turbopaneld/releases/latest/download/manifest.json'

const TEST_KEY = (await crypto.subtle.generateKey('Ed25519', true, [
  'sign',
  'verify',
])) as CryptoKeyPair
const OTHER_KEY = (await crypto.subtle.generateKey('Ed25519', true, [
  'sign',
  'verify',
])) as CryptoKeyPair

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Reset the cache and trust the test key (the pinned release key is not ours to sign with). */
async function resetUpdateManifestCacheForTests(): Promise<void> {
  resetToPinnedKey()
  setUpdateManifestTrustKeyForTests(hex(await crypto.subtle.exportKey('raw', TEST_KEY.publicKey)))
}

/** The same canonical form the daemon signs: sorted keys, no whitespace, no `signature`. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const rec = value as Record<string, unknown>
    const body = Object.keys(rec)
      .toSorted()
      .map((k) => `${JSON.stringify(k)}:${canonical(rec[k])}`)
    return `{${body.join(',')}}`
  }
  return JSON.stringify(value)
}

async function signBody(
  body: Record<string, unknown>,
  key: CryptoKeyPair = TEST_KEY
): Promise<string> {
  const sig = await crypto.subtle.sign(
    'Ed25519',
    key.privateKey,
    new TextEncoder().encode(canonical(body))
  )
  const value = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return JSON.stringify({ ...body, signature: { alg: 'ed25519', keyId: 'test', value } })
}

async function manifestBody(
  channel: string,
  commit = 'abc123',
  version?: string,
  builtAt = '2020-01-01T00:00:00.000Z'
): Promise<string> {
  return await signBody({
    commit,
    buildId: `build-${commit}`,
    builtAt,
    channel,
    ...(version ? { version } : {}),
  })
}

/** Install a fetch stub and return the URLs it was asked for. */
function stubFetch(handler: (url: string) => Response | Promise<Response>): {
  calls: string[]
  restore: () => void
} {
  const calls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    return Promise.resolve(handler(url))
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

test('resolveUpdateManifest reads the built-in rail with one fetch — no channels.json hop', async () => {
  await resetUpdateManifestCacheForTests()
  const stub = stubFetch(async (url) =>
    url === TRUNK_MANIFEST_URL
      ? new Response(await manifestBody('trunk'), { status: 200 })
      : new Response('missing', { status: 404 })
  )
  try {
    const manifest = await resolveUpdateManifest('trunk')
    assertEquals(manifest, {
      commit: 'abc123',
      buildId: 'build-abc123',
      builtAt: '2020-01-01T00:00:00.000Z',
      channel: 'trunk',
      manifestUrl: TRUNK_MANIFEST_URL,
    })
    assertEquals(stub.calls, [TRUNK_MANIFEST_URL])
  } finally {
    stub.restore()
    await resetUpdateManifestCacheForTests()
  }
})

test('resolveUpdateManifest follows rc and release to GitHub Releases', async () => {
  await resetUpdateManifestCacheForTests()
  const stub = stubFetch(async (url) => {
    if (url === RC_MANIFEST_URL) {
      return new Response(await manifestBody('rc', 'rc1'), { status: 200 })
    }
    if (url === RELEASE_MANIFEST_URL) {
      return new Response(await manifestBody('release', 'rel1', '0.1.1'), {
        status: 200,
      })
    }
    return new Response('missing', { status: 404 })
  })
  try {
    const rc = await resolveUpdateManifest('rc')
    assertEquals(rc?.commit, 'rc1')
    // Trunk-shaped manifests carry no version; release manifests name one.
    assertEquals('version' in (rc ?? {}), false)
    assertEquals((await resolveUpdateManifest('release'))?.commit, 'rel1')
    assertEquals((await resolveUpdateManifest('release'))?.version, '0.1.1')
    assertEquals((await resolveUpdateManifest('release'))?.manifestUrl, RELEASE_MANIFEST_URL)
    assertEquals(stub.calls, [RC_MANIFEST_URL, RELEASE_MANIFEST_URL])
  } finally {
    stub.restore()
    await resetUpdateManifestCacheForTests()
  }
})

test('resolveUpdateManifest is null for the reserved channel without fetching', async () => {
  await resetUpdateManifestCacheForTests()
  const stub = stubFetch(() => {
    throw new TypeError('must not fetch')
  })
  try {
    // canary is advertised now (the rolling GitHub pre-release); only edge
    // still has no built-in location.
    assertEquals(await resolveUpdateManifest('edge'), null)
    assertEquals(stub.calls, [])
  } finally {
    stub.restore()
    await resetUpdateManifestCacheForTests()
  }
})

test('resolveUpdateManifest coalesces concurrent lookups per channel', async () => {
  await resetUpdateManifestCacheForTests()
  const stub = stubFetch(
    async (url) =>
      new Response(await manifestBody(url === RC_MANIFEST_URL ? 'rc' : 'trunk'), {
        status: 200,
      })
  )
  try {
    const [first, second, rc] = await Promise.all([
      resolveUpdateManifest('trunk'),
      resolveUpdateManifest('trunk'),
      resolveUpdateManifest('rc'),
    ])
    assertEquals(first?.commit, 'abc123')
    assertEquals(second?.commit, 'abc123')
    assertEquals(rc?.channel, 'rc')
    assertEquals(stub.calls, [TRUNK_MANIFEST_URL, RC_MANIFEST_URL])
  } finally {
    stub.restore()
    await resetUpdateManifestCacheForTests()
  }
})

test('resolveUpdateManifest reuses the cached manifest within the TTL, per channel', async () => {
  await resetUpdateManifestCacheForTests()
  const stub = stubFetch(async () => new Response(await manifestBody('trunk'), { status: 200 }))
  try {
    await resolveUpdateManifest('trunk')
    await resolveUpdateManifest('trunk')
    assertEquals(stub.calls.length, 1)
    await resolveUpdateManifest('release')
    assertEquals(stub.calls.length, 2)
  } finally {
    stub.restore()
    await resetUpdateManifestCacheForTests()
  }
})

test('resolveUpdateManifest returns null when the manifest is unavailable', async () => {
  await resetUpdateManifestCacheForTests()
  const stub = stubFetch(() => new Response('nope', { status: 500 }))
  try {
    assertEquals(await resolveUpdateManifest('trunk'), null)
    // A release that does not exist yet (404 until the first promotion) is
    // the same "unknown" the page already degrades to.
    assertEquals(await resolveUpdateManifest('release'), null)
  } finally {
    stub.restore()
    await resetUpdateManifestCacheForTests()
  }
})

test('resolveUpdateManifest returns null for incomplete manifest fields', async () => {
  await resetUpdateManifestCacheForTests()
  const stub = stubFetch(
    async () => new Response(await signBody({ commit: 'only' }), { status: 200 })
  )
  try {
    assertEquals(await resolveUpdateManifest('trunk'), null)
  } finally {
    stub.restore()
    await resetUpdateManifestCacheForTests()
  }
})

test('resolveUpdateManifest returns null when fetch throws', async () => {
  await resetUpdateManifestCacheForTests()
  setUpdateManifestRetryDelaysForTests([0, 0])
  const stub = stubFetch(() => {
    throw new TypeError('network down')
  })
  try {
    assertEquals(await resolveUpdateManifest('trunk'), null)
    assertEquals(stub.calls.length, 3)
  } finally {
    stub.restore()
    await resetUpdateManifestCacheForTests()
  }
})

test('resolveUpdateManifest retries a resolver blip and still resolves the target', async () => {
  await resetUpdateManifestCacheForTests()
  setUpdateManifestRetryDelaysForTests([0, 0])
  let attempts = 0
  const body = await manifestBody('trunk')
  const stub = stubFetch(() => {
    attempts++
    if (attempts < 3) {
      throw new TypeError('error sending request: dns error: Temporary failure in name resolution')
    }
    return new Response(body, { status: 200 })
  })
  try {
    const target = await resolveUpdateManifest('trunk')
    assertEquals(target?.channel, 'trunk')
    assertEquals(stub.calls.length, 3)
  } finally {
    stub.restore()
    await resetUpdateManifestCacheForTests()
  }
})

test('resolveUpdateManifest retries a 503 once the answer clears', async () => {
  await resetUpdateManifestCacheForTests()
  setUpdateManifestRetryDelaysForTests([0])
  const body = await manifestBody('trunk')
  const stub = stubFetch(() =>
    stub.calls.length === 1
      ? new Response('busy', { status: 503 })
      : new Response(body, { status: 200 })
  )
  try {
    assertEquals((await resolveUpdateManifest('trunk'))?.channel, 'trunk')
    assertEquals(stub.calls.length, 2)
  } finally {
    stub.restore()
    await resetUpdateManifestCacheForTests()
  }
})

test('resolveUpdateManifest does not retry a 404', async () => {
  await resetUpdateManifestCacheForTests()
  setUpdateManifestRetryDelaysForTests([0, 0])
  const stub = stubFetch(() => new Response('missing', { status: 404 }))
  try {
    assertEquals(await resolveUpdateManifest('trunk'), null)
    assertEquals(stub.calls.length, 1)
  } finally {
    stub.restore()
    await resetUpdateManifestCacheForTests()
  }
})

test('seedUpdateManifestCacheForTests short-circuits the fetch path for its channel only', async () => {
  await resetUpdateManifestCacheForTests()
  seedUpdateManifestCacheForTests(
    {
      commit: 'seeded',
      buildId: 'b',
      builtAt: '2020-01-01T00:00:00.000Z',
      channel: 'trunk',
      manifestUrl: 'https://dl.trbp.nl/m.json',
    },
    'trunk'
  )
  const stub = stubFetch(() => new Response('missing', { status: 404 }))
  try {
    assertEquals((await resolveUpdateManifest('trunk'))?.commit, 'seeded')
    assertEquals(stub.calls, [])
    assertEquals(await resolveUpdateManifest('rc'), null)
    assertEquals(stub.calls, [RC_MANIFEST_URL])
  } finally {
    stub.restore()
    await resetUpdateManifestCacheForTests()
  }
})

test('resolveUpdateManifest defers to a registered provider for every channel', async () => {
  await resetUpdateManifestCacheForTests()
  const stub = stubFetch(() => {
    throw new TypeError('provider must bypass the rail fetch')
  })
  const target = {
    commit: 'abc+1',
    buildId: 'dev-abc+1',
    builtAt: '2026-01-01T00:00:00.000Z',
    channel: 'trunk',
    manifestUrl: '/repo/dist/manifest.json',
  }
  try {
    setUpdateManifestProvider(() => Promise.resolve(target))
    assertEquals(await resolveUpdateManifest('trunk'), target)
    assertEquals(await resolveUpdateManifest('release'), target)
    assertEquals(stub.calls, [])
  } finally {
    setUpdateManifestProvider(null)
    stub.restore()
    await resetUpdateManifestCacheForTests()
  }
})

test('resolveUpdateManifest keeps the daemon provider off the instance kind', async () => {
  await resetUpdateManifestCacheForTests()
  const instanceUrl = 'https://github.com/TurboPanel/turbopanel/releases/download/rc/manifest.json'
  const stub = stubFetch(async (url) =>
    url === instanceUrl
      ? new Response(await manifestBody('rc', 'inst1', '0.1.1'), { status: 200 })
      : new Response('missing', { status: 404 })
  )
  try {
    setUpdateManifestProvider(() =>
      Promise.resolve({
        commit: 'daemon-only',
        buildId: 'd',
        builtAt: '2020-01-01T00:00:00.000Z',
        channel: 'rc',
        manifestUrl: 'https://example.invalid/m.json',
      })
    )
    assertEquals((await resolveUpdateManifest('rc'))?.commit, 'daemon-only')
    assertEquals((await resolveUpdateManifest('rc', 'instance'))?.commit, 'inst1')
    assertEquals((await resolveUpdateManifest('rc', 'instance'))?.version, '0.1.1')
    assertEquals(await resolveUpdateManifest('trunk', 'instance'), null)
    assertEquals(stub.calls, [instanceUrl])
  } finally {
    setUpdateManifestProvider(null)
    stub.restore()
    await resetUpdateManifestCacheForTests()
  }
})

/** Resolve one trunk manifest body through a fresh cache; returns the target and refusal code. */
async function resolveTrunkBody(body: string) {
  await resetUpdateManifestCacheForTests()
  const stub = stubFetch(() => new Response(body, { status: 200 }))
  try {
    const target = await resolveUpdateManifest('trunk')
    return { target, code: getUpdateManifestRefusal('trunk')?.code ?? null, calls: stub.calls }
  } finally {
    stub.restore()
    resetToPinnedKey()
  }
}

test('an unsigned manifest is refused with manifest_unsigned', async () => {
  const body = JSON.stringify({
    commit: 'c',
    buildId: 'b',
    builtAt: '2020-01-01T00:00:00Z',
    channel: 'trunk',
  })
  const result = await resolveTrunkBody(body)
  assertEquals(result.target, null)
  assertEquals(result.code, 'manifest_unsigned')
  assertEquals(result.calls, [TRUNK_MANIFEST_URL])
})

test('a tampered manifest is refused with manifest_signature_invalid', async () => {
  const signed = JSON.parse(await manifestBody('trunk', 'good')) as Record<string, unknown>
  const result = await resolveTrunkBody(JSON.stringify({ ...signed, commit: 'evil' }))
  assertEquals(result.target, null)
  assertEquals(result.code, 'manifest_signature_invalid')
})

test('a manifest signed by another key is refused', async () => {
  const body = await signBody(
    { commit: 'c', buildId: 'b', builtAt: '2020-01-01T00:00:00Z', channel: 'trunk' },
    OTHER_KEY
  )
  assertEquals((await resolveTrunkBody(body)).code, 'manifest_signature_invalid')
})

test('a malformed signature is refused with manifest_signature_malformed', async () => {
  const signed = JSON.parse(await manifestBody('trunk')) as Record<string, unknown>
  const body = JSON.stringify({
    ...signed,
    signature: { alg: 'ed25519', keyId: 'x', value: 'AAAA' },
  })
  assertEquals((await resolveTrunkBody(body)).code, 'manifest_signature_malformed')
})

test('a non-object manifest body fails closed', async () => {
  assertEquals((await resolveTrunkBody('null')).target, null)
})

/** Each call moves the clock past the 30 s manifest cache so the next resolve fetches again. */
function makeClockAdvancer(): { next: () => void; restore: () => void } {
  const realNow = Date.now
  let offset = 0
  Date.now = () => realNow() + offset
  return {
    next: () => {
      offset += 60_000
    },
    restore: () => {
      Date.now = realNow
    },
  }
}

test('a replayed older signed manifest is refused, and a newer build is accepted again', async () => {
  await resetUpdateManifestCacheForTests()
  let body = await manifestBody('trunk', 'new', undefined, '2026-02-01T00:00:00.000Z')
  const stub = stubFetch(() => new Response(body, { status: 200 }))
  const clock = makeClockAdvancer()
  try {
    assertEquals((await resolveUpdateManifest('trunk'))?.commit, 'new')
    clock.next()
    body = await manifestBody('trunk', 'old', undefined, '2026-01-01T00:00:00.000Z')
    assertEquals(await resolveUpdateManifest('trunk'), null)
    assertEquals(getUpdateManifestRefusal('trunk')?.code, 'manifest_replayed')
    clock.next()
    body = await manifestBody('trunk', 'newer', undefined, '2026-03-01T00:00:00.000Z')
    assertEquals((await resolveUpdateManifest('trunk'))?.commit, 'newer')
    assertEquals(getUpdateManifestRefusal('trunk'), null)
  } finally {
    clock.restore()
    stub.restore()
    resetToPinnedKey()
  }
})

test('a replayed older release version is refused even with a newer build time', async () => {
  await resetUpdateManifestCacheForTests()
  let body = await manifestBody('release', 'r2', '0.2.0', '2026-02-01T00:00:00.000Z')
  const stub = stubFetch(() => new Response(body, { status: 200 }))
  const clock = makeClockAdvancer()
  try {
    assertEquals((await resolveUpdateManifest('release'))?.version, '0.2.0')
    clock.next()
    body = await manifestBody('release', 'r1', '0.1.9', '2026-03-01T00:00:00.000Z')
    assertEquals(await resolveUpdateManifest('release'), null)
    assertEquals(getUpdateManifestRefusal('release')?.code, 'manifest_replayed')
  } finally {
    clock.restore()
    stub.restore()
    resetToPinnedKey()
  }
})

test('the pinned release key verifies a real published release manifest, and rejects a one-field edit', async () => {
  const text = await Deno.readTextFile(
    new URL('./testdata/signed-release-manifest.json', import.meta.url)
  )
  const real = JSON.parse(text) as Record<string, unknown>
  const { verifyManifestSignature } = await import('./signing.ts')
  await verifyManifestSignature(real)
  let refused = ''
  try {
    await verifyManifestSignature({ ...real, commit: 'f'.repeat(40) })
  } catch (error) {
    refused = (error as { code?: string }).code ?? ''
  }
  assert(refused === 'manifest_signature_invalid')
})
