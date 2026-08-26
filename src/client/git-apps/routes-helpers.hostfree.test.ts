/**
 * Body-grammar coverage for the git-app write surfaces.
 *
 * The three-state rule (absent / null / value) is what lets a settings form
 * save a rename without re-pasting a sealed key, so it is worth pinning.
 */

import { assertEquals } from '@std/assert'
import {
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
  assertEquals(
    forOrg.webhookUrl,
    'https://panel.example.com/api/git/v1/github/webhook/ref-1',
  )

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
  assertEquals(owned.webhookPath, '/api/git/v1/github/webhook/ref-1')
})
