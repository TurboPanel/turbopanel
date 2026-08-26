/**
 * Body-grammar coverage for the git-app write surfaces.
 *
 * The three-state rule (absent / null / value) is what lets a settings form
 * save a rename without re-pasting a sealed key, so it is worth pinning.
 */

import { assertEquals } from '@std/assert'
import {
  githubManifestUiReturnPath,
  providerInstallUiReturnPath,
  parseGitAppCreateBody,
  parseGitAppPatchBody,
  serializeGitApp,
} from './routes-helpers.ts'
import type { GitAppSummary } from '../../lib/git/git-app-records.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('manifest callback returns the operator to the console, not JSON', () => {
  // A freshly created app lands on its own screen, because "install
  // repositories" is the operator's actual next step — not the list.
  assertEquals(
    githubManifestUiReturnPath('org-1', { created: 'app-9' }),
    '/org-1/projects/git-sources/app-9?created=app-9',
  )
  // With nothing created there is no detail screen to land on.
  assertEquals(
    githubManifestUiReturnPath(null, { error: 'conversion_failed' }),
    '/admin/git?error=conversion_failed',
  )
})

test('provider install redirects land on the app, never on an API path', () => {
  assertEquals(
    providerInstallUiReturnPath('org-1', 'app-9', { installed: 'inst-1' }),
    '/org-1/projects/git-sources/app-9?installed=inst-1',
  )
  // A failure before the app is known still has to leave the API surface.
  assertEquals(
    providerInstallUiReturnPath('org-1', null, { error: 'state_invalid' }),
    '/org-1/projects/git-sources?error=state_invalid',
  )
  assertEquals(
    providerInstallUiReturnPath(null, 'app-9', { error: 'claimed' }),
    '/admin/git/app-9?error=claimed',
  )
})

test('create takes its organization from the scope, never the body', () => {
  const parsed = parseGitAppCreateBody(
    {
      provider: 'github',
      name: 'TurboPanel',
      externalAppId: '1234',
      // A caller trying to plant the row in another tenant.
      organizationId: 'someone-else',
    },
    'org-1',
  )
  assertEquals(parsed?.organizationId, 'org-1')
})

test('create rejects a missing or unknown provider', () => {
  assertEquals(parseGitAppCreateBody({ name: 'x', externalAppId: '1' }, null), null)
  assertEquals(
    parseGitAppCreateBody(
      { provider: 'bitbucket', name: 'x', externalAppId: '1' },
      null,
    ),
    null,
  )
})

test('patch distinguishes absent, null, and a value', () => {
  const parsed = parseGitAppPatchBody({ name: 'Renamed', clientId: null })
  assertEquals(parsed, { name: 'Renamed', clientId: null })
  // `privateKeyPem` was not mentioned, so it must not appear at all — an
  // undefined key is what tells the record layer to keep the sealed envelope.
  assertEquals(parsed && 'privateKeyPem' in parsed, false)
})

test('an empty string is rejected rather than treated as a clear', () => {
  // Otherwise a form that submitted a blank private-key box would silently
  // wipe a key the operator was never shown.
  assertEquals(parseGitAppPatchBody({ privateKeyPem: '' }), null)
  assertEquals(parseGitAppPatchBody({ webhookSecret: '   ' }), null)
  assertEquals(parseGitAppPatchBody({ name: '' }), null)
  // Clearing is still available — you just have to mean it.
  assertEquals(parseGitAppPatchBody({ privateKeyPem: null }), { privateKeyPem: null })
})

test('patch refuses to move an app between tenants or providers', () => {
  assertEquals(parseGitAppPatchBody({ provider: 'gitlab' }), null)
  assertEquals(parseGitAppPatchBody({ organizationId: 'other' }), null)
})

test('patch rejects a non-string where a string is expected', () => {
  assertEquals(parseGitAppPatchBody({ clientId: 42 }), null)
  assertEquals(parseGitAppPatchBody(null), null)
  assertEquals(parseGitAppPatchBody([]), null)
})

const app: GitAppSummary = {
  id: 'app-1',
  organizationId: null,
  provider: 'github',
  name: 'TurboPanel',
  baseUrl: 'https://github.com',
  apiUrl: null,
  externalAppId: '1234',
  appSlug: null,
  clientId: null,
  redirectUri: null,
  webhookRef: 'ref-1',
  webhookOrigin: null,
  isPublic: false,
  customGitUser: null,
  customGitPort: null,
  syncedAt: null,
  hasPrivateKey: true,
  hasClientSecret: false,
  hasWebhookSecret: true,
}

test('serialize marks an instance-wide app read-only only for an org viewer', () => {
  const forOrg = serializeGitApp(app, {
    publicOrigin: 'https://panel.example.com',
    viewerOrganizationId: 'org-1',
  })
  assertEquals(forOrg.readOnly, true)
  // github.com: the clean path, with no internal id in it.
  assertEquals(forOrg.webhookUrl, 'https://panel.example.com/webhook/github')

  // The same row is editable through the admin surface.
  const forAdmin = serializeGitApp(app, {
    publicOrigin: 'https://panel.example.com',
    viewerOrganizationId: null,
  })
  assertEquals(forAdmin.readOnly, false)
})

test('an org-owned app is writable by its owner', () => {
  const owned = serializeGitApp(
    { ...app, organizationId: 'org-1' },
    { publicOrigin: null, viewerOrganizationId: 'org-1' },
  )
  assertEquals(owned.readOnly, false)
  // No public origin yet: the path is still known, the absolute URL is not.
  assertEquals(owned.webhookUrl, null)
  assertEquals(owned.webhookPath, '/webhook/github')
})

test('a self-hosted app carries its ref; the app origin beats the instance default', () => {
  const enterprise = serializeGitApp(
    {
      ...app,
      baseUrl: 'https://github.acme.test',
      webhookOrigin: 'https://hooks.example.com',
    },
    { publicOrigin: 'https://panel.example.com', viewerOrganizationId: null },
  )
  // GitHub Enterprise ships on its own cadence, so the App-id header is not a
  // safe single point of failure there — the ref stays in the path.
  assertEquals(enterprise.webhookPath, '/webhook/github/ref-1')
  // And the origin is the one the provider was actually given at registration,
  // not whichever public URL happens to sort first today.
  assertEquals(enterprise.webhookUrl, 'https://hooks.example.com/webhook/github/ref-1')
})
