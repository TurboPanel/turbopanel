/**
 * Coverage for the GitHub App manifest.
 *
 * Everything asserted here is **creation-only** on GitHub's side: the manifest
 * is the one chance to set the webhook URL, the visibility, and the permission
 * set. An existing App keeps whatever it was born with until every installation
 * manually accepts new permissions, so a regression here is not something an
 * operator can correct from the console.
 */

import { assertEquals, assertRejects } from '@std/assert'
import {
  buildGithubAppManifest,
  convertGithubAppManifest,
  githubAppCreateUrl,
  GithubManifestError,
  GITHUB_MANIFEST_EVENTS,
} from './github-manifest.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const base = {
  name: 'turbopanel-quiet-heron-4f2a91',
  publicUrl: 'https://panel.example.com',
  webhookUrl: 'https://panel.example.com/webhook/github',
  redirectUrl: 'https://panel.example.com/api/client/v1/forges/github/manifest/callback',
  setupUrl: 'https://panel.example.com/api/client/v1/repositories/github/callback',
}

test('visibility tracks the instance-wide toggle', () => {
  // A private App can only be installed on the account that owns it, so a
  // shared one has to be public — and an org's own one should not be.
  assertEquals(buildGithubAppManifest({ ...base, publicApp: true }).public, true)
  assertEquals(buildGithubAppManifest({ ...base, publicApp: false }).public, false)
})

test('the setup url is distinct from the redirect url', () => {
  const manifest = buildGithubAppManifest({ ...base, publicApp: false })
  // `redirect_url` only covers the one-shot manifest conversion. Without a
  // separate `setup_url` an install finishes on GitHub with no redirect, the
  // source callback never fires, and no installation row is ever written — the
  // App would be installed while the console showed no connected account.
  assertEquals(manifest.setup_url, base.setupUrl)
  assertEquals(manifest.redirect_url, base.redirectUrl)
  assertEquals(manifest.setup_url === manifest.redirect_url, false)
  // And it has to re-fire when the repository selection changes, since that is
  // the only signal that new repositories became reachable.
  assertEquals(manifest.setup_on_update, true)
})

test('pull-request access is read-only unless asked for', () => {
  const readOnly = buildGithubAppManifest({ ...base, publicApp: false })
  assertEquals(readOnly.default_permissions.pull_requests, 'read')
  assertEquals(readOnly.default_events.includes('pull_request'), false)

  const writable = buildGithubAppManifest({
    ...base,
    publicApp: false,
    pullRequestAccess: 'write',
  })
  assertEquals(writable.default_permissions.pull_requests, 'write')
  // Permission and subscription move together: subscribing without the write
  // permission delivers events the instance cannot act on.
  assertEquals(writable.default_events.includes('pull_request'), true)
})

test('everything except pull requests stays read-only', () => {
  const manifest = buildGithubAppManifest({
    ...base,
    publicApp: true,
    pullRequestAccess: 'write',
  })
  for (const key of ['contents', 'metadata', 'checks']) {
    assertEquals(manifest.default_permissions[key], 'read', `${key} must stay read`)
  }
})

test('installation events are never listed as default events', () => {
  // GitHub rejects a manifest that names them ("Default events unsupported")
  // even though it delivers them to every App anyway. Naming one here fails
  // App creation outright, after the operator has already left for GitHub.
  for (
    const manifest of [
      buildGithubAppManifest({ ...base, publicApp: false }),
      buildGithubAppManifest({ ...base, publicApp: true, pullRequestAccess: 'write' }),
    ]
  ) {
    assertEquals(manifest.default_events.includes('installation'), false)
    assertEquals(manifest.default_events.includes('installation_repositories'), false)
  }
  assertEquals(GITHUB_MANIFEST_EVENTS.includes('installation' as never), false)
})

test('the webhook url is carried through untouched', () => {
  // Whatever origin and path the wizard resolved is what GitHub stores, and
  // nothing revisits it afterwards.
  const manifest = buildGithubAppManifest({
    ...base,
    webhookUrl: 'https://hooks.example.com/webhook/github/ref-1',
    publicApp: false,
  })
  assertEquals(manifest.hook_attributes.url, 'https://hooks.example.com/webhook/github/ref-1')
  assertEquals(manifest.hook_attributes.active, true)
})

test('an org-owned App is created under that organization on GitHub', () => {
  assertEquals(
    githubAppCreateUrl('https://github.com', 'st8', 'acme'),
    'https://github.com/organizations/acme/settings/apps/new?state=st8',
  )
  // No login means the acting user's personal account.
  assertEquals(
    githubAppCreateUrl('https://github.com', 'st8'),
    'https://github.com/settings/apps/new?state=st8',
  )
  // Enterprise lives on its own origin, and a trailing slash is not a
  // different one.
  assertEquals(
    githubAppCreateUrl('https://github.acme.test/', 'st8', 'acme'),
    'https://github.acme.test/organizations/acme/settings/apps/new?state=st8',
  )
  assertEquals(
    githubAppCreateUrl('https://github.acme.test///', 'st8'),
    'https://github.acme.test/settings/apps/new?state=st8',
  )
})

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

test('GithubManifestError records an optional status', () => {
  const error = new GithubManifestError('boom', 422)
  assertEquals(error.name, 'GithubManifestError')
  assertEquals(error.status, 422)
})

test('convertGithubAppManifest posts the one-shot code and maps credentials', async () => {
  await withFetch((url, init) => {
    assertEquals(url, 'https://api.github.com/app-manifests/tmp%2Fcode/conversions')
    assertEquals(init?.method, 'POST')
    return new Response(
      JSON.stringify({
        id: 88,
        slug: 'quiet-heron',
        client_id: 'Iv1.abc',
        client_secret: 'secret',
        pem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
        webhook_secret: 'hook',
      }),
      { status: 201 },
    )
  }, async () => {
    assertEquals(
      await convertGithubAppManifest('https://api.github.com', 'tmp/code'),
      {
        externalAppId: '88',
        appSlug: 'quiet-heron',
        clientId: 'Iv1.abc',
        clientSecret: 'secret',
        privateKeyPem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
        webhookSecret: 'hook',
      },
    )
  })
})

test('convertGithubAppManifest treats empty optional strings as absent', async () => {
  await withFetch(
    () =>
      new Response(
        JSON.stringify({
          id: '9',
          slug: '',
          client_id: '',
          pem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
        }),
        { status: 200 },
      ),
    async () => {
      assertEquals(
        await convertGithubAppManifest('https://api.github.com', 'code'),
        {
          externalAppId: '9',
          appSlug: null,
          clientId: null,
          clientSecret: null,
          privateKeyPem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
          webhookSecret: null,
        },
      )
    },
  )
})

test('convertGithubAppManifest maps transport and HTTP failures', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (() => Promise.reject(new Error('reset'))) as typeof fetch
  try {
    await assertRejects(
      () => convertGithubAppManifest('https://api.github.com', 'code'),
      GithubManifestError,
      'github manifest conversion failed: reset',
    )
  } finally {
    globalThis.fetch = original
  }

  globalThis.fetch = (() => Promise.reject('offline')) as typeof fetch
  try {
    await assertRejects(
      () => convertGithubAppManifest('https://api.github.com', 'code'),
      GithubManifestError,
      'github manifest conversion failed: network error',
    )
  } finally {
    globalThis.fetch = original
  }

  await withFetch(() => new Response('nope', { status: 404 }), async () => {
    await assertRejects(
      () => convertGithubAppManifest('https://api.github.com', 'code'),
      GithubManifestError,
      'github manifest conversion failed (404)',
    )
  })
})

test('convertGithubAppManifest rejects an empty or incomplete body', async () => {
  await withFetch(() => new Response('not-json', { status: 200 }), async () => {
    await assertRejects(
      () => convertGithubAppManifest('https://api.github.com', 'code'),
      GithubManifestError,
      'returned no body',
    )
  })
  await withFetch(
    () => new Response(JSON.stringify({ id: null, pem: 'x' }), { status: 200 }),
    async () => {
      await assertRejects(
        () => convertGithubAppManifest('https://api.github.com', 'code'),
        GithubManifestError,
        'returned no app id or private key',
      )
    },
  )
  await withFetch(
    () => new Response(JSON.stringify({ id: 1, pem: '' }), { status: 200 }),
    async () => {
      await assertRejects(
        () => convertGithubAppManifest('https://api.github.com', 'code'),
        GithubManifestError,
        'returned no app id or private key',
      )
    },
  )
  // An object id must not stringify to "[object Object]".
  await withFetch(
    () =>
      new Response(
        JSON.stringify({ id: { value: 1 }, pem: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----' }),
        { status: 200 },
      ),
    async () => {
      await assertRejects(
        () => convertGithubAppManifest('https://api.github.com', 'code'),
        GithubManifestError,
        'returned no app id or private key',
      )
    },
  )
})
