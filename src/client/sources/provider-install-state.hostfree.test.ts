import { assertEquals } from '@std/assert'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  INSTALL_STATE_TTL_MS,
  signGithubInstallState,
  signGitlabConnectState,
  signProviderInstallState,
  verifyGithubInstallState,
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
