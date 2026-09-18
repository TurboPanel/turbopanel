/**
 * The webhook URL is both a credential and an SSRF vector; these are the two
 * properties the settings module owes.
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db.ts'
import {
  ALERT_WEBHOOK_URL_KEY,
  AlertWebhookUrlError,
  assertAlertWebhookUrlAllowed,
  describeAlertWebhook,
  getAlertWebhookUrl,
  HOSTED_ALERT_WEBHOOK_POLICY,
  SELF_HOSTED_ALERT_WEBHOOK_POLICY,
} from './alert-webhook-settings.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function readingDb(value: unknown): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(value === undefined ? [] : [{ value }]),
        }),
      }),
    }),
  } as unknown as Db
}

test('a plausible incoming-webhook URL is accepted', async () => {
  assertEquals(
    await assertAlertWebhookUrlAllowed(
      '  https://hooks.slack.com/services/T000/B000/XXXX  ',
    ),
    'https://hooks.slack.com/services/T000/B000/XXXX',
  )
})

test('the URL cannot point back inside the box', async () => {
  // The same gate a forge base URL passes: an admin-typed URL that is fetched
  // server-side is an SSRF vector, and the control plane's own Postgres,
  // RabbitMQ and Redis are all one hop away.
  const refusals: Array<[string, string]> = [
    ['http://hooks.example.com/x', 'scheme_not_https'],
    ['https://user:pw@hooks.example.com/x', 'credentials_in_url'],
    ['https://localhost/x', 'reserved_host'],
    ['https://postgres/x', 'reserved_host'],
    ['https://metadata.internal/x', 'reserved_host'],
    ['https://127.0.0.1/x', 'address_not_public'],
    ['https://[::1]/x', 'address_not_public'],
    ['https://169.254.169.254/latest/meta-data', 'address_not_public'],
    ['https://10.0.0.5/x', 'address_not_public'],
    ['not a url', 'malformed'],
  ]
  for (const [url, reason] of refusals) {
    const error = await assertRejects(
      () => assertAlertWebhookUrlAllowed(url),
      AlertWebhookUrlError,
    )
    assertEquals(error.reason, reason, url)
  }
})

test('a self-hosted instance may point the webhook at its own LAN', async () => {
  // Decided 2026-09-18: a hosted instance cannot reach a private address at
  // all, so the public-only rule only ever bit self-hosted operators — whose
  // Alertmanager sits next to the control plane more often than not.
  for (
    const url of [
      'https://10.0.0.5/alerts',
      'https://alertmanager/api/v2/alerts',
      'https://alerts.local/hook',
      'https://[::1]/hook',
    ]
  ) {
    assertEquals(
      await assertAlertWebhookUrlAllowed(url, SELF_HOSTED_ALERT_WEBHOOK_POLICY),
      url,
    )
  }
  // The hosted policy is the default, and it is what a Workers instance passes.
  const error = await assertRejects(
    () => assertAlertWebhookUrlAllowed('https://10.0.0.5/alerts', HOSTED_ALERT_WEBHOOK_POLICY),
    AlertWebhookUrlError,
  )
  assertEquals(error.reason, 'address_not_public')
  // Scheme and credentials are not the address rule and stay on both.
  const plain = await assertRejects(
    () => assertAlertWebhookUrlAllowed('http://10.0.0.5/alerts', SELF_HOSTED_ALERT_WEBHOOK_POLICY),
    AlertWebhookUrlError,
  )
  assertEquals(plain.reason, 'scheme_not_https')
})

test('what a settings panel renders is the origin, never the path', () => {
  // The path IS the secret in every common webhook scheme, so returning the
  // whole URL would make every admin who can open the page a credential holder.
  assertEquals(
    describeAlertWebhook('https://hooks.slack.com/services/T000/B000/XXXX'),
    { configured: true, origin: 'https://hooks.slack.com' },
  )
  assertEquals(describeAlertWebhook(null), { configured: false, origin: null })
  assertEquals(describeAlertWebhook('garbage'), {
    configured: true,
    origin: null,
  })
})

test('no row means no webhook, and neither does an unreadable one', async () => {
  assertEquals(await getAlertWebhookUrl(readingDb(undefined), undefined), null)
  assertEquals(await getAlertWebhookUrl(readingDb(''), undefined), null)
  assertEquals(await getAlertWebhookUrl(readingDb(42), undefined), null)
  // A sealed value with no key to open it: no alerts, not a failed sweep.
  assertEquals(
    await getAlertWebhookUrl(readingDb('tpsecret.v1.aaaa'), undefined),
    null,
  )
})

test('an unsealed legacy value is still readable', async () => {
  assertEquals(
    await getAlertWebhookUrl(readingDb('https://hooks.example.com/x'), undefined),
    'https://hooks.example.com/x',
  )
})

test('the setting key is stable', () => {
  assertEquals(ALERT_WEBHOOK_URL_KEY, 'ALERT_WEBHOOK_URL')
})
