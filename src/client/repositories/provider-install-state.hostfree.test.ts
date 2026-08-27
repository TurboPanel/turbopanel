import { assertEquals } from '@std/assert'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  GITHUB_INSTALL_STATE_PURPOSE,
  GITHUB_INSTALL_STATE_TTL_MS,
  GITHUB_MANIFEST_STATE_PURPOSE,
  INSTALL_STATE_PURPOSES,
  INSTALL_STATE_TTL_MS,
  signGithubInstallState,
  signGithubManifestState,
  signGitlabConnectState,
  signProviderInstallState,
  verifyGithubInstallState,
  verifyGithubManifestState,
  verifyGitlabConnectState,
  verifyProviderInstallState,
} from './provider-install-state.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ORG_ID = '550e8400-e29b-41d4-a716-446655440000'
const APP_ID = '22222222-2222-4222-8222-222222222222'
const CLAIMS = { organizationId: ORG_ID, appId: APP_ID }
const NOW_MS = Date.parse('2026-01-15T12:00:00.000Z')

test('sign/verify round-trips github and gitlab install state', async () => {
  const secrets = parseTestSecretsConfig()
  const github = await signGithubInstallState(secrets, CLAIMS, NOW_MS)
  assertEquals(github.startsWith('tpinstall.v1.'), true)
  assertEquals(await verifyGithubInstallState(secrets, github, NOW_MS), CLAIMS)

  const gitlab = await signGitlabConnectState(secrets, CLAIMS, NOW_MS)
  assertEquals(await verifyGitlabConnectState(secrets, gitlab, NOW_MS), CLAIMS)
})

test('provider install state is not interchangeable across HKDF purposes', async () => {
  const secrets = parseTestSecretsConfig()
  const github = await signProviderInstallState(secrets, 'github', CLAIMS, NOW_MS)
  const gitlab = await signProviderInstallState(secrets, 'gitlab', CLAIMS, NOW_MS)

  assertEquals(
    await verifyProviderInstallState(secrets, 'gitlab', github, NOW_MS),
    null,
  )
  assertEquals(
    await verifyProviderInstallState(secrets, 'github', gitlab, NOW_MS),
    null,
  )
})

test('verifyProviderInstallState rejects expired, malformed, and unsigned state', async () => {
  const secrets = parseTestSecretsConfig()
  const state = await signProviderInstallState(secrets, 'github', CLAIMS, NOW_MS)

  assertEquals(
    await verifyProviderInstallState(
      secrets,
      'github',
      state,
      NOW_MS + INSTALL_STATE_TTL_MS + 1,
    ),
    null,
  )
  assertEquals(
    await verifyProviderInstallState(secrets, 'github', 'not-an-envelope', NOW_MS),
    null,
  )
  assertEquals(
    await verifyProviderInstallState(
      secrets,
      'github',
      'tpinstall.v1.not-base64.also-not',
      NOW_MS,
    ),
    null,
  )

  const parts = state.split('.')
  parts[3] = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  assertEquals(
    await verifyProviderInstallState(secrets, 'github', parts.join('.'), NOW_MS),
    null,
  )
})

test('install-state purposes stay distinct and share the ten-minute TTL', () => {
  assertEquals(INSTALL_STATE_PURPOSES.github, 'github-app-install-state')
  assertEquals(INSTALL_STATE_PURPOSES.gitlab, 'gitlab-oauth-connect-state')
  assertEquals(GITHUB_INSTALL_STATE_PURPOSE, INSTALL_STATE_PURPOSES.github)
  assertEquals(GITHUB_MANIFEST_STATE_PURPOSE, 'github-app-manifest-state')
  assertEquals(GITHUB_INSTALL_STATE_TTL_MS, INSTALL_STATE_TTL_MS)
})

test('sign/verify round-trips a GitHub manifest state including optional fields', async () => {
  const secrets = parseTestSecretsConfig()
  const claims = {
    organizationId: ORG_ID,
    webhookRef: 'ref-1',
    baseUrl: 'https://github.com',
    name: 'TurboPanel',
    webhookOrigin: 'https://panel.example',
    apiUrl: 'https://api.github.com',
    isPublic: true,
    pullRequestAccess: 'write' as const,
    customGitUser: 'git',
    customGitPort: 2222,
  }
  const state = await signGithubManifestState(secrets, claims, NOW_MS)
  assertEquals(state.startsWith('tpinstall.v1.'), true)
  assertEquals(await verifyGithubManifestState(secrets, state, NOW_MS), claims)
})

test('manifest state treats a null organization as the instance-wide admin flow', async () => {
  const secrets = parseTestSecretsConfig()
  const state = await signGithubManifestState(
    secrets,
    {
      organizationId: null,
      webhookRef: 'ref-admin',
      baseUrl: 'https://github.com',
      name: 'Instance',
    },
    NOW_MS,
  )
  assertEquals(await verifyGithubManifestState(secrets, state, NOW_MS), {
    organizationId: null,
    webhookRef: 'ref-admin',
    baseUrl: 'https://github.com',
    name: 'Instance',
    webhookOrigin: null,
    apiUrl: null,
    isPublic: false,
    pullRequestAccess: 'read',
    customGitUser: null,
    customGitPort: null,
  })
})

test('verifyGithubManifestState rejects expired, malformed, and unsigned state', async () => {
  const secrets = parseTestSecretsConfig()
  const state = await signGithubManifestState(
    secrets,
    { organizationId: ORG_ID, webhookRef: 'r', baseUrl: 'https://github.com', name: 'App' },
    NOW_MS,
  )

  assertEquals(
    await verifyGithubManifestState(secrets, state, NOW_MS + INSTALL_STATE_TTL_MS + 1),
    null,
  )
  assertEquals(await verifyGithubManifestState(secrets, 'not-an-envelope', NOW_MS), null)
  assertEquals(
    await verifyGithubManifestState(secrets, 'tpinstall.v1.not-base64.also-not', NOW_MS),
    null,
  )

  const parts = state.split('.')
  parts[3] = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  assertEquals(await verifyGithubManifestState(secrets, parts.join('.'), NOW_MS), null)
})

test('verifyGithubManifestState rejects empty required fields', async () => {
  const secrets = parseTestSecretsConfig()
  const emptyName = await signGithubManifestState(
    secrets,
    { organizationId: ORG_ID, webhookRef: 'r', baseUrl: 'https://github.com', name: '' },
    NOW_MS,
  )
  assertEquals(await verifyGithubManifestState(secrets, emptyName, NOW_MS), null)

  const emptyRef = await signGithubManifestState(
    secrets,
    { organizationId: ORG_ID, webhookRef: '', baseUrl: 'https://github.com', name: 'App' },
    NOW_MS,
  )
  assertEquals(await verifyGithubManifestState(secrets, emptyRef, NOW_MS), null)
})

test('signGithubManifestState defaults nowMs so a freshly signed state verifies', async () => {
  const secrets = parseTestSecretsConfig()
  const state = await signGithubManifestState(secrets, {
    organizationId: ORG_ID,
    webhookRef: 'fresh',
    baseUrl: 'https://github.com',
    name: 'Fresh',
  })
  const claims = await verifyGithubManifestState(secrets, state)
  assertEquals(claims?.name, 'Fresh')
  assertEquals(claims?.pullRequestAccess, 'read')
})
