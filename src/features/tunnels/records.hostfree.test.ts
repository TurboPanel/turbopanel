import { assert, assertEquals } from '@std/assert'
import { decryptSecret } from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import {
  type BadgeRow,
  parseBadgeBody,
  parseCarrierBody,
  sealToken,
  toApiBadge,
} from './records.ts'
import { BADGE_CAPABILITIES, TUNNEL_PROVIDERS } from './vocabulary.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const TOKEN = 'cf-api-token-0123456789abcdefghijklmnopqrstuv'

test('a sealed token opens to the same text and the sealed text hides it', async () => {
  const secrets = await deriveEncryptionSecretsConfig(
    parseTestSecretsConfig('deno'),
    'data-encryption'
  )
  const sealed = await sealToken(secrets, TOKEN)
  assert(sealed.startsWith('tpsecret'))
  assert(!sealed.includes(TOKEN))
  assertEquals(await decryptSecret(secrets, sealed), TOKEN)
})

test('a badge as the API shows it has no token, no secret id and only the known capabilities', () => {
  const row: BadgeRow = {
    id: '00000000-0000-4000-8000-0000000000b1',
    createdAt: '2026-10-28T00:00:00.000Z',
    updatedAt: '2026-10-28T00:00:00.000Z',
    carrierId: '00000000-0000-4000-8000-0000000000c1',
    secretId: '00000000-0000-4000-8000-0000000000e1',
    label: 'Main',
    capabilities: {
      tunnels: true,
      dns: [{ id: 'z1', name: 'example.com', extra: 1 }, 'bad'],
      extra: true,
    },
    lastFour: TOKEN.slice(-4),
    lastCheckedAt: null,
    status: 'active',
  }
  const shown = toApiBadge(row)
  assertEquals(Object.keys(shown.capabilities), [...BADGE_CAPABILITIES])
  assertEquals(shown.capabilities, {
    tunnels: true,
    dns: [{ id: 'z1', name: 'example.com' }],
    certificates: [],
  })
  const json = JSON.stringify(shown)
  assert(!json.includes(TOKEN))
  assert(!json.includes(row.secretId))
  assertEquals(shown.lastFour, TOKEN.slice(-4))
})

test('a carrier body needs a known provider, a name and an account id', () => {
  const good = { provider: TUNNEL_PROVIDERS[0], name: ' Main ', externalAccountId: 'abc123' }
  const parsed = parseCarrierBody(good)
  assert(parsed.ok)
  assertEquals(parsed.value.name, 'Main')
  for (const bad of [
    { ...good, provider: 'other' },
    { ...good, name: '' },
    { ...good, externalAccountId: 'has space' },
    { ...good, externalAccountId: undefined },
  ]) {
    assertEquals(parseCarrierBody(bad).ok, false)
  }
})

test('a badge body needs a label and a plausible token', () => {
  assert(parseBadgeBody({ label: 'Main', token: TOKEN }).ok)
  for (const bad of [
    { label: '', token: TOKEN },
    { label: 'Main', token: 'short' },
    { label: 'Main', token: 'has a space in it' },
    { label: 'Main' },
  ]) {
    assertEquals(parseBadgeBody(bad).ok, false)
  }
})
