import { assertEquals } from '@std/assert'
import { encryptSecret } from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig, parseSecretsEnv } from '../../lib/secrets/secrets.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import {
  openUnsubscribeToken,
  sealUnsubscribeToken,
  UNSUBSCRIBE_TOKEN_TTL_MS,
  unsubscribePageUrl,
  unsubscribeUrl,
} from './unsubscribe.ts'
import { notificationMailHeaders } from '../email/templates.ts'
import { parseEmailJob } from '../../lib/email/mailer/parse-email-job.ts'

const test = Deno.test.bind(Deno)

async function keys() {
  return await deriveEncryptionSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'data-encryption'
  )
}

const CLAIMS = {
  userId: '00000000-0000-7000-8000-000000000001',
  organizationId: '00000000-0000-7000-8000-000000000002',
  projectId: '00000000-0000-7000-8000-000000000003',
  categoryCode: 'servers',
  channelId: null,
}
const NOW = Date.parse('2026-11-06T12:00:00Z')

test('a sealed token opens to its claims until it expires', async () => {
  const secrets = await keys()
  const token = await sealUnsubscribeToken(secrets, CLAIMS, NOW)
  assertEquals(await openUnsubscribeToken(secrets, token, NOW + 1000), CLAIMS)
  assertEquals(await openUnsubscribeToken(secrets, token, NOW + UNSUBSCRIBE_TOKEN_TTL_MS + 1), null)
})

test('an altered token, another sealed value or garbage opens to nothing', async () => {
  const secrets = await keys()
  const token = await sealUnsubscribeToken(secrets, CLAIMS, NOW)
  const flipped = token.slice(0, -2) + (token.endsWith('A') ? 'BB' : 'AA')
  assertEquals(await openUnsubscribeToken(secrets, flipped, NOW), null)
  // A value sealed with the same key but without the domain tag is not a token.
  const other = await encryptSecret(secrets, JSON.stringify({ u: CLAIMS.userId, exp: NOW + 1 }))
  assertEquals(await openUnsubscribeToken(secrets, other, NOW), null)
  assertEquals(await openUnsubscribeToken(secrets, 'not-a-token', NOW), null)
})

test('links point at the API one-click route and the web page', () => {
  assertEquals(
    unsubscribeUrl('https://panel.example.com/', 'a.b'),
    'https://panel.example.com/api/client/v1/notification-unsubscribe/a.b'
  )
  assertEquals(
    unsubscribePageUrl('https://panel.example.com', 'a b'),
    'https://panel.example.com/account/unsubscribe?token=a%20b'
  )
})

test('a personal copy carries the RFC 8058 pair and the filtering headers', () => {
  const headers = notificationMailHeaders({
    unsubscribeUrl: 'https://panel.example.com/api/client/v1/notification-unsubscribe/t',
    organizationId: 'org-1',
    projectId: 'p-1',
    event: 'server.offline',
    reason: 'preference',
  })
  assertEquals(
    headers['List-Unsubscribe'],
    '<https://panel.example.com/api/client/v1/notification-unsubscribe/t>'
  )
  assertEquals(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')
  assertEquals(headers['List-Id'], '<org-1.notifications.turbopanel>')
  assertEquals(headers['X-TurboPanel-Project'], 'p-1')
  assertEquals(headers['X-TurboPanel-Event'], 'server.offline')
  assertEquals(headers['X-TurboPanel-Reason'], 'preference')
  // A shared channel's copy: no unsubscribe pair, header values stay on one line.
  const shared = notificationMailHeaders({ event: 'a\r\nb', reason: 'organization-channel' })
  assertEquals(shared['List-Unsubscribe'], undefined)
  assertEquals(shared['X-TurboPanel-Event'], 'a  b')
})

test('a queued notification job parses with or without the new mail fields', () => {
  const base = {
    type: 'notification',
    to: 'a@example.com',
    from: 'n@example.com',
    event: 'server.offline',
    severity: 'critical',
    title: 't',
    body: null,
    details: [],
    organizationName: null,
    consoleUrl: null,
    at: '2026-11-06T12:00:00Z',
  }
  assertEquals(parseEmailJob(base)?.type, 'notification')
  const withMail = parseEmailJob({ ...base, mail: { unsubscribeUrl: 'https://x/u', reason: null } })
  assertEquals((withMail as { mail?: unknown }).mail, {
    unsubscribeUrl: 'https://x/u',
    reason: null,
  })
  assertEquals(parseEmailJob({ ...base, mail: { unsubscribeUrl: 5 } }), null)
})
