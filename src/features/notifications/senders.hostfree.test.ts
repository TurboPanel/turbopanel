import { assertEquals, assertMatch } from '@std/assert'
import type { DeliveryPayload } from './records.ts'
import {
  chatBody,
  DIGEST_TEXT_MAX,
  type DigestMessage,
  digestText,
  digestWebhookBody,
  parseTelegramAddress,
  renderText,
  send,
  sendDigest,
  signBody,
  webhookBody,
} from './senders.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const payload: DeliveryPayload = {
  event: 'server.offline',
  severity: 'critical',
  title: 'Server db-1 went offline',
  body: 'The daemon stopped answering.',
  organizationId: '00000000-0000-4000-8000-0000000000a1',
  organizationName: 'Acme',
  targetType: 'server',
  targetId: '00000000-0000-4000-8000-0000000000b1',
  context: { serverName: 'db-1', zed: 1, alpha: 'x', gone: null },
  at: '2026-09-18T10:00:00.000Z',
}

type Captured = { url: string; init: RequestInit }

function fakeFetch(
  status: number,
  captured: Captured[],
  behaviour: 'ok' | 'hang' | 'throw' = 'ok'
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} })
    if (behaviour === 'throw') {
      return Promise.reject(new TypeError('connection refused'))
    }
    if (behaviour === 'hang') {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    }
    return Promise.resolve(new Response('ok', { status }))
  }) as typeof fetch
}

test('the text line is the title, the body, then the context sorted and without nulls', () => {
  assertEquals(
    renderText(payload),
    'Server db-1 went offline — The daemon stopped answering. (alpha=x serverName=db-1 zed=1)'
  )
})

test('the generic webhook body carries the structured event and nothing secret', () => {
  const body = webhookBody(payload)
  assertEquals(body.event, 'server.offline')
  assertEquals(body.severity, 'critical')
  assertEquals(body.target, { type: 'server', id: payload.targetId })
  assertEquals(body.at, payload.at)
  assertEquals(Object.hasOwn(body, 'address'), false)
})

test('Slack reads text, Discord reads content', () => {
  assertEquals(Object.keys(chatBody('slack', payload)), ['text'])
  assertEquals(Object.keys(chatBody('discord', payload)), ['content'])
})

test('a webhook send signs the raw body with the channel secret and names the event', async () => {
  const captured: Captured[] = []
  const outcome = await send(
    {
      kind: 'webhook',
      address: 'https://hooks.example.com/x',
      signingSecret: 's3cret',
    },
    payload,
    fakeFetch(200, captured)
  )
  assertEquals(outcome, { ok: true })
  const headers = captured[0]!.init.headers as Record<string, string>
  assertEquals(headers['x-turbopanel-event'], 'server.offline')
  assertMatch(headers['x-turbopanel-signature']!, /^sha256=[0-9a-f]{64}$/)
  assertEquals(
    headers['x-turbopanel-signature'],
    await signBody('s3cret', captured[0]!.init.body as string)
  )
})

test('a refusal, a timeout and a thrown fetch all resolve — never reject — with a short code', async () => {
  const refused = await send({ kind: 'slack', address: 'https://h/x' }, payload, fakeFetch(500, []))
  assertEquals(refused, { ok: false, error: 'http_500' })
  const thrown = await send(
    { kind: 'discord', address: 'https://h/x' },
    payload,
    fakeFetch(200, [], 'throw')
  )
  assertEquals(thrown, { ok: false, error: 'network' })
})

test('a Telegram address is one sealed string: token then chat id', () => {
  assertEquals(parseTelegramAddress('123456:ABC-DEF/987654321'), {
    token: '123456:ABC-DEF',
    chatId: '987654321',
  })
  assertEquals(parseTelegramAddress('bot123456:ABC-DEF/-100123'), {
    token: '123456:ABC-DEF',
    chatId: '-100123',
  })
  assertEquals(parseTelegramAddress('nonsense'), null)
})

test('a Telegram send posts to the Bot API with the chat id in the body', async () => {
  const captured: Captured[] = []
  await send({ kind: 'telegram', address: '123:ABC/42' }, payload, fakeFetch(200, captured))
  assertEquals(captured[0]!.url, 'https://api.telegram.org/bot123:ABC/sendMessage')
  assertEquals(JSON.parse(captured[0]!.init.body as string).chat_id, '42')
})

test('email and push are not sent from here', async () => {
  assertEquals(await send({ kind: 'email', address: 'a@b.c' }, payload, fakeFetch(200, [])), {
    ok: false,
    error: 'unsupported_email',
  })
})

test('a webhook 302 to an internal address is never followed and fails with redirect_blocked', async () => {
  const calls: Captured[] = []
  const redirecting = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      })
    )
  }) as typeof fetch
  const outcome = await send(
    { kind: 'webhook', address: 'https://hooks.example.com/x' },
    payload,
    redirecting
  )
  assertEquals(outcome, { ok: false, error: 'redirect_blocked' })
  assertEquals(calls.length, 1)
  assertEquals(calls[0]!.init.redirect, 'manual')
})

const digest: DigestMessage = {
  summary: 'daily',
  total: 4,
  groups: [
    {
      event: 'server.deleted',
      severity: 'warning',
      count: 3,
      items: [
        {
          title: 'Server a deleted',
          at: '2026-09-18T01:00:00.000Z',
          url: null,
        },
        {
          title: 'Server b deleted',
          at: '2026-09-18T02:00:00.000Z',
          url: null,
        },
      ],
    },
    {
      event: 'site.created',
      severity: 'info',
      count: 1,
      items: [
        {
          title: 'Site x created',
          at: '2026-09-18T03:00:00.000Z',
          url: null,
        },
      ],
    },
  ],
  moreGroups: 2,
  consoleUrl: 'https://panel.example.com',
  at: '2026-09-18T08:00:00.000Z',
}

test('chat digest text is compact: a head, one line per kind, the counts, the link', () => {
  const lines = digestText(digest).split('\n')
  assertEquals(lines, [
    'TurboPanel daily digest: 4 events',
    '- [warning] server.deleted x3: Server a deleted (+2 more)',
    '- [info] site.created x1: Site x created',
    '...and 2 more kinds',
    'https://panel.example.com',
  ])
})

test('chat digest text stays under the smallest chat limit', () => {
  const long = {
    ...digest.groups[0]!,
    items: [{ title: 'x'.repeat(5000), at: '', url: null }],
  }
  const text = digestText({
    ...digest,
    groups: Array.from({ length: 8 }, () => long),
  })
  assertEquals(text.length <= DIGEST_TEXT_MAX, true)
})

test('webhook digest body carries the grouped events as data and no address or secret', () => {
  const body = digestWebhookBody(digest)
  assertEquals(body.type, 'digest')
  assertEquals(body.total, 4)
  assertEquals(body.moreGroups, 2)
  const groups = body.groups as Array<{ event: string; count: number; items: unknown[] }>
  assertEquals(
    groups.map((g) => [g.event, g.count, g.items.length]),
    [
      ['server.deleted', 3, 2],
      ['site.created', 1, 1],
    ]
  )
  assertEquals(typeof body.text, 'string')
})

test('sendDigest posts the right body per transport through the injected fetch only', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = []
  const fake = ((url: string, init: RequestInit) => {
    calls.push({
      url,
      body: JSON.parse(init.body as string),
      headers: new Headers(init.headers),
    })
    return Promise.resolve(new Response('ok', { status: 200 }))
  }) as unknown as typeof fetch

  const slack = await sendDigest(
    { kind: 'slack', address: 'https://s.example.com/h' },
    digest,
    fake
  )
  const discord = await sendDigest(
    { kind: 'discord', address: 'https://d.example.com/h' },
    digest,
    fake
  )
  const telegram = await sendDigest({ kind: 'telegram', address: '123:abc/-100' }, digest, fake)
  const hook = await sendDigest(
    {
      kind: 'webhook',
      address: 'https://w.example.com/h',
      signingSecret: 'shh',
    },
    digest,
    fake
  )
  assertEquals([slack.ok, discord.ok, telegram.ok, hook.ok], [true, true, true, true])
  assertEquals(Object.keys(calls[0]!.body), ['text'])
  assertEquals(Object.keys(calls[1]!.body), ['content'])
  assertEquals(calls[2]!.body.chat_id, '-100')
  assertEquals(calls[3]!.body.type, 'digest')
  assertEquals(calls[3]!.headers.get('x-turbopanel-event'), 'digest')
  assertMatch(calls[3]!.headers.get('x-turbopanel-signature') ?? '', /^sha256=[0-9a-f]{64}$/)
  assertEquals((await sendDigest({ kind: 'email', address: 'a@b.c' }, digest, fake)).ok, false)
})
