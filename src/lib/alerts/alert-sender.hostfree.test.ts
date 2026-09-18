/**
 * The sender's one hard contract: it never fails the thing it reports on.
 */

import { assertEquals } from '@std/assert'
import {
  ALERT_DELIVERY_TIMEOUT_MS,
  type Alert,
  alertPayload,
  createWebhookAlertSender,
  NOOP_ALERT_SENDER,
} from './alert-sender.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const OFFLINE: Alert = {
  kind: 'server.offline',
  text: 'Server abc stopped answering and has been marked offline',
  detail: { serverId: 'abc' },
}

function okResponse(): Response {
  return new Response('ok', { status: 200 })
}

test('the payload carries a text field every common webhook reads', () => {
  const payload = alertPayload(OFFLINE)
  assertEquals(
    payload.text,
    'Server abc stopped answering and has been marked offline (serverId=abc)',
  )
  assertEquals(payload.kind, 'server.offline')
  assertEquals(payload.detail, { serverId: 'abc' })
})

test('detail keys are sorted and empty values are left out of the text', () => {
  const payload = alertPayload({
    kind: 'fleet.mass_disconnect',
    text: 'Mass disconnect',
    detail: { connectedBefore: 8, staleCount: 5, ratio: null, note: undefined },
  })
  assertEquals(payload.text, 'Mass disconnect (connectedBefore=8 staleCount=5)')
})

test('an alert with no detail is sent as its bare text', () => {
  assertEquals(
    alertPayload({ kind: 'server.offline', text: 'Something' }).text,
    'Something',
  )
})

test('the sender posts JSON to the configured URL', async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  const send = createWebhookAlertSender(
    'https://hooks.example.com/services/T/B/XXX',
    (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      })
      return Promise.resolve(okResponse())
    },
  )
  await send(OFFLINE)
  assertEquals(calls.length, 1)
  assertEquals(calls[0].url, 'https://hooks.example.com/services/T/B/XXX')
  assertEquals(
    (calls[0].body as { kind: string }).kind,
    'server.offline',
  )
})

test('a webhook that rejects the post does not reject the caller', async () => {
  // An unreachable Slack must not stop the sweep from marking servers
  // offline — that is the failure alerting exists to prevent.
  const send = createWebhookAlertSender(
    'https://hooks.example.com/dead',
    () => Promise.resolve(new Response('no', { status: 500 })),
  )
  await send(OFFLINE)
})

test('a fetch that throws does not reject the caller', async () => {
  const send = createWebhookAlertSender(
    'https://hooks.example.com/dead',
    () => Promise.reject(new Error('ECONNREFUSED')),
  )
  await send(OFFLINE)
})

test('the delivery is bounded by an abort signal', async () => {
  let seenSignal: AbortSignal | undefined
  const send = createWebhookAlertSender(
    'https://hooks.example.com/slow',
    (_input, init) => {
      seenSignal = init?.signal ?? undefined
      return Promise.resolve(okResponse())
    },
  )
  await send(OFFLINE)
  assertEquals(seenSignal instanceof AbortSignal, true)
  assertEquals(ALERT_DELIVERY_TIMEOUT_MS > 0, true)
})

test('the no-op sender is what an unconfigured instance uses', async () => {
  await NOOP_ALERT_SENDER(OFFLINE)
})

test('a permission-denied delivery says it is the allowlist, not the network', async () => {
  // The compiled self-hosted binary runs under a fixed --allow-net allowlist
  // that cannot name a host the operator configures later. "Requires net
  // access" on its own sends someone looking at their firewall.
  // compatLogWarn writes straight to Deno.stderr under Deno, not console.
  const lines: string[] = []
  const decoder = new TextDecoder()
  const originalWriteSync = Deno.stderr.writeSync.bind(Deno.stderr)
  Deno.stderr.writeSync = (bytes: Uint8Array) => {
    lines.push(decoder.decode(bytes))
    return bytes.length
  }
  try {
    const send = createWebhookAlertSender(
      'https://hooks.example.com/x',
      () => Promise.reject(new Deno.errors.PermissionDenied('Requires net access')),
    )
    await send(OFFLINE)
  } finally {
    Deno.stderr.writeSync = originalWriteSync
  }
  assertEquals(lines.length, 1)
  assertEquals(lines[0].includes('--allow-net allowlist'), true)
  assertEquals(lines[0].includes('https://hooks.example.com'), true)
})
