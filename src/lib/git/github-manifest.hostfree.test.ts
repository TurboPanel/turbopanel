/**
 * Coverage for the GitHub App manifest.
 *
 * Everything asserted here is **creation-only** on GitHub's side: the manifest
 * is the one chance to set the webhook URL, the visibility, and the permission
 * set. An existing App keeps whatever it was born with until every installation
 * manually accepts new permissions, so a regression here is not something an
 * operator can correct from the console.
 */

import { assertEquals } from '@std/assert'
import {
  buildGithubAppManifest,
  githubAppCreateUrl,
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
  redirectUrl: 'https://panel.example.com/api/client/v1/git/apps/github/manifest/callback',
  setupUrl: 'https://panel.example.com/api/client/v1/sources/github/callback',
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
})
