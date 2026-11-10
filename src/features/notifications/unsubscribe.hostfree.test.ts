import { assertEquals } from '@std/assert'
import { encryptSecret } from '../../lib/secrets/data-encryption.ts'
import { deriveEncryptionSecretsConfig, parseSecretsEnv } from '../../lib/secrets/secrets.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'
import {
  openUnsubscribeToken,
  planUnsubscribe,
  sealUnsubscribeToken,
  UNSUBSCRIBE_API_PREFIX,
  UNSUBSCRIBE_TOKEN_TTL_MS,
  type UnsubscribeChannel,
  type UnsubscribeClaims,
  unsubscribeClaims,
  unsubscribePageUrl,
  unsubscribeUrl,
} from './unsubscribe.ts'
import type { PreferenceScopeKey } from './fanout-records.ts'
import { type EventScope, type PreferenceRow, resolveLevel } from './resolve.ts'
import { CLIENT_API_PREFIX } from '../../app/surfaces.ts'
import { notificationMailHeaders } from '../email/templates.ts'
import { parseEmailJob } from '../../lib/email/mailer/parse-email-job.ts'

const test = Deno.test.bind(Deno)

async function keys() {
  return await deriveEncryptionSecretsConfig(
    parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`, 'deno'),
    'data-encryption'
  )
}

const USER = '00000000-0000-7000-8000-000000000001'
const ORG = '00000000-0000-7000-8000-000000000002'
const PROJECT = '00000000-0000-7000-8000-000000000003'
const ENVIRONMENT = '00000000-0000-7000-8000-000000000004'
const SERVICE = '00000000-0000-7000-8000-000000000005'
const SERVER = '00000000-0000-7000-8000-000000000006'
const OTHER_ORG = '00000000-0000-7000-8000-000000000007'
const ACCOUNT_CHANNEL = '00000000-0000-7000-8000-000000000008'
const OTHER_CHANNEL = '00000000-0000-7000-8000-000000000009'

const CLAIMS = unsubscribeClaims({
  userId: USER,
  organizationId: ORG,
  projectId: PROJECT,
  categoryCode: 'servers',
})
const NOW = Date.parse('2026-11-06T12:00:00Z')

/** The account email channel, as the unsubscribe route finds it. */
const ACCOUNT: UnsubscribeChannel = { id: ACCOUNT_CHANNEL, isPrimary: true }

let nextRow = 0

/** One of the person's preference rows; every field not given is "any". */
function pref(over: Partial<PreferenceRow>): PreferenceRow {
  nextRow += 1
  return {
    id: `row-${nextRow}`,
    userId: USER,
    organizationId: null,
    projectId: null,
    environmentId: null,
    serviceId: null,
    serverId: null,
    destinationId: null,
    channelId: null,
    categoryCode: null,
    topicCode: null,
    kind: null,
    level: 'all',
    endsAt: null,
    ...over,
  }
}

function sameTuple(row: PreferenceRow, cap: PreferenceScopeKey): boolean {
  return (Object.keys(cap) as Array<keyof PreferenceScopeKey>).every((k) => row[k] === cap[k])
}

/** The rows after the database upserted every planned `none` row by its unique tuple. */
function afterUnsubscribe(
  rows: readonly PreferenceRow[],
  claims: UnsubscribeClaims,
  channel: UnsubscribeChannel = ACCOUNT
): PreferenceRow[] {
  const out = rows.map((row) => ({ ...row }))
  for (const cap of planUnsubscribe(rows, claims, channel, NOW)) {
    const existing = out.find((row) => sameTuple(row, cap))
    if (existing) {
      existing.level = 'none'
      existing.endsAt = null
    } else {
      out.push(pref({ ...cap, level: 'none' }))
    }
  }
  // Newest first, so a tie in the resolver would favour the rows that were
  // there before: the plan may not rely on row order.
  return out.toReversed()
}

/** A server-offline event in the organization's project, as the fan-out resolves it. */
const SERVER_OFFLINE: EventScope = {
  organizationId: ORG,
  projectId: PROJECT,
  environmentId: ENVIRONMENT,
  serviceId: SERVICE,
  serverId: SERVER,
  destinationId: null,
  topicCode: 'server.offline',
  categoryCode: 'servers',
}

/** The link in the email copy of that event to the account address. */
const MAIL_CLAIMS = unsubscribeClaims({
  userId: USER,
  organizationId: ORG,
  projectId: PROJECT,
  environmentId: ENVIRONMENT,
  serviceId: SERVICE,
  serverId: SERVER,
  topicCode: 'server.offline',
  categoryCode: 'servers',
})

/** The level the next email copy to the account address resolves to. */
function emailLevel(
  rows: readonly PreferenceRow[],
  scope: EventScope = SERVER_OFFLINE,
  channelId = ACCOUNT_CHANNEL
) {
  return resolveLevel(rows, scope, { kind: 'email', channelId }, NOW).level
}

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

test('a link from a build before the wider claims still opens', async () => {
  const secrets = await keys()
  const sealedBy = (claims: Record<string, unknown>) =>
    encryptSecret(
      secrets,
      'notification-unsubscribe.v1:' + JSON.stringify({ ...claims, exp: NOW + 60_000 })
    )
  // A single mail: person, organization, project, category, channel.
  const single = await sealedBy({ u: USER, o: ORG, p: PROJECT, c: 'servers', ch: null })
  assertEquals(await openUnsubscribeToken(secrets, single, NOW), CLAIMS)
  // A digest named no organization and no subject: it reads as "every email".
  const digest = await sealedBy({ u: USER, o: null, p: null, c: null, ch: null })
  assertEquals(
    await openUnsubscribeToken(secrets, digest, NOW),
    unsubscribeClaims({ userId: USER, everything: true })
  )
  // A scope id without its organization is refused.
  const orphan = await sealedBy({ u: USER, sr: SERVER, c: 'servers' })
  assertEquals(await openUnsubscribeToken(secrets, orphan, NOW), null)
})

test('the full claims survive the round trip and the link stays inside one header line', async () => {
  const secrets = await keys()
  const claims = { ...MAIL_CLAIMS, destinationId: OTHER_ORG, channelId: OTHER_CHANNEL }
  const token = await sealUnsubscribeToken(secrets, claims, NOW)
  assertEquals(await openUnsubscribeToken(secrets, token, NOW), claims)
  const header = `List-Unsubscribe: <${unsubscribeUrl('https://panel.example.com', token)}>`
  // RFC 5322 caps a line at 998 characters and a link cannot be folded.
  assertEquals(header.length < 998, true, `header is ${header.length} characters`)
})

test('a single mail turned on by an organization preset stops for that category only', () => {
  // The preset writes "email: all" for the organization.
  const rows = [pref({ organizationId: ORG, kind: 'email' })]
  assertEquals(emailLevel(rows), 'all')
  const after = afterUnsubscribe(rows, MAIL_CLAIMS)
  assertEquals(emailLevel(after), 'none')
  // Another category in the same organization still arrives.
  assertEquals(
    emailLevel(after, { ...SERVER_OFFLINE, topicCode: 'x.y', categoryCode: 'access' }),
    'all'
  )
  assertEquals(
    planUnsubscribe(rows, MAIL_CLAIMS, ACCOUNT, NOW).map((c) => [c.organizationId, c.categoryCode]),
    [[ORG, 'servers']]
  )
})

test('a single mail turned on by an organization topic row stops', () => {
  const rows = [
    pref({ kind: 'email', level: 'none' }),
    pref({ organizationId: ORG, topicCode: 'server.offline', kind: 'email' }),
  ]
  assertEquals(emailLevel(rows), 'all')
  // A category row at the same scope (what the link used to write) loses to the topic row.
  const stale = [
    ...rows,
    pref({ organizationId: ORG, categoryCode: 'servers', kind: 'email', level: 'none' }),
  ]
  assertEquals(emailLevel(stale), 'all')
  assertEquals(emailLevel(afterUnsubscribe(stale, MAIL_CLAIMS)), 'none')
  assertEquals(emailLevel(afterUnsubscribe(rows, MAIL_CLAIMS)), 'none')
})

test('a single mail turned on by a server row stops', () => {
  const rows = [pref({ organizationId: ORG, serverId: SERVER })]
  assertEquals(emailLevel(rows), 'all')
  const after = afterUnsubscribe(rows, MAIL_CLAIMS)
  assertEquals(emailLevel(after), 'none')
  // The row covered every kind: the bell for that server is untouched.
  assertEquals(
    resolveLevel(after, SERVER_OFFLINE, { kind: 'inbox', channelId: null }, NOW).level,
    'all'
  )
})

test('a single mail turned on by an environment row stops', () => {
  const rows = [
    pref({
      organizationId: ORG,
      projectId: PROJECT,
      categoryCode: 'servers',
      kind: 'email',
      level: 'none',
    }),
    pref({ organizationId: ORG, projectId: PROJECT, environmentId: ENVIRONMENT, kind: 'email' }),
  ]
  assertEquals(emailLevel(rows), 'all')
  assertEquals(emailLevel(afterUnsubscribe(rows, MAIL_CLAIMS)), 'none')
})

test('rows for the service and the server of one event are both turned off', () => {
  const rows = [
    pref({ organizationId: ORG, serviceId: SERVICE, kind: 'email' }),
    pref({ organizationId: ORG, serverId: SERVER, kind: 'email' }),
  ]
  assertEquals(emailLevel(afterUnsubscribe(rows, MAIL_CLAIMS)), 'none')
  assertEquals(emailLevel(afterUnsubscribe(rows.toReversed(), MAIL_CLAIMS)), 'none')
})

test('a row for one channel is turned off for that channel, and a mute that ends does not count', () => {
  const other: UnsubscribeChannel = { id: OTHER_CHANNEL, isPrimary: false }
  const claims = { ...MAIL_CLAIMS, channelId: OTHER_CHANNEL }
  const rows = [
    pref({ organizationId: ORG, kind: 'email' }),
    // A mute until tomorrow hides the row above today; the mail must stay off after it ends.
    pref({
      organizationId: ORG,
      projectId: PROJECT,
      kind: 'email',
      level: 'none',
      endsAt: new Date(NOW + 86_400_000).toISOString(),
    }),
  ]
  const after = afterUnsubscribe(rows, claims, other).filter((row) => row.endsAt === null)
  assertEquals(emailLevel(after, SERVER_OFFLINE, OTHER_CHANNEL), 'none')
  // The account address keeps its copy: only the channel in the link was named.
  assertEquals(emailLevel(after), 'all')
})

test('a digest link turns off every row that sends email, in every organization', () => {
  // The organization preset row that used to beat the digest link's one global row.
  const rows = [
    pref({ kind: 'inbox' }),
    pref({ organizationId: ORG, kind: 'email' }),
    pref({ organizationId: OTHER_ORG, projectId: PROJECT, topicCode: 'server.offline' }),
    pref({ organizationId: OTHER_ORG, kind: 'chat' }),
  ]
  const elsewhere = { ...SERVER_OFFLINE, organizationId: OTHER_ORG }
  assertEquals(emailLevel(rows), 'all')
  assertEquals(emailLevel(rows, elsewhere), 'all')
  const after = afterUnsubscribe(rows, unsubscribeClaims({ userId: USER, everything: true }))
  assertEquals(emailLevel(after), 'none')
  assertEquals(emailLevel(after, elsewhere), 'none')
  // The bell and chat rows are not email: left as they were.
  assertEquals(
    after
      .filter((row) => row.level === 'all')
      .map((row) => row.kind)
      .toSorted(),
    ['chat', 'inbox', null]
  )
})

test('with nothing sending the mail, the click still leaves one none row where it happened', () => {
  assertEquals(planUnsubscribe([], CLAIMS, ACCOUNT, NOW), [
    {
      organizationId: ORG,
      projectId: PROJECT,
      environmentId: null,
      serviceId: null,
      serverId: null,
      destinationId: null,
      topicCode: null,
      categoryCode: 'servers',
      kind: 'email',
      channelId: null,
    },
  ])
})

test('the unsubscribe path is the client API prefix', () => {
  assertEquals(UNSUBSCRIBE_API_PREFIX, CLIENT_API_PREFIX)
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
  // RFC 8058 needs HTTPS: a plain-http base URL gets no one-click pair.
  const plain = notificationMailHeaders({
    unsubscribeUrl: 'http://panel.example.com/api/client/v1/notification-unsubscribe/t',
    event: 'server.offline',
  })
  assertEquals(plain['List-Unsubscribe'], undefined)
  assertEquals(plain['List-Unsubscribe-Post'], undefined)
  assertEquals(plain['X-TurboPanel-Event'], 'server.offline')
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
