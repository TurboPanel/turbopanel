/**
 * The webhook URL is both a credential and an SSRF vector; these are the two
 * properties the settings module owes.
 */

import { assertEquals, assertRejects } from '@std/assert'
import type { Db } from '../../db/connection.ts'
import {
  ALERT_WEBHOOK_URL_KEY,
  AlertWebhookUrlError,
  assertAlertWebhookUrlAllowed,
  describeAlertWebhook,
  getAlertWebhookUrl,
  ALERT_WEBHOOK_POLICY,
  adoptLegacyAlertWebhook,
  setOperatorWebhookUrl,
} from './alert-webhook-settings.ts'
import { deriveEncryptionSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'

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
    await assertAlertWebhookUrlAllowed('  https://hooks.slack.com/services/T000/B000/XXXX  '),
    'https://hooks.slack.com/services/T000/B000/XXXX'
  )
})

test('scheme and credentials are refused; the address is not', async () => {
  // The forge gate refuses private addresses because a forge URL is fetched
  // with the App's credentials attached. A notification target carries none
  // and its response goes nowhere, so only the scheme and userinfo rules
  // apply here — the strict address gate is exercised through the option
  // in the LAN test below.
  const refusals: Array<[string, string]> = [
    ['http://hooks.example.com/x', 'scheme_not_https'],
    ['https://user:pw@hooks.example.com/x', 'credentials_in_url'],
    ['not a url', 'malformed'],
  ]
  for (const [url, reason] of refusals) {
    const error = await assertRejects(() => assertAlertWebhookUrlAllowed(url), AlertWebhookUrlError)
    assertEquals(error.reason, reason, url)
  }
})

test('the webhook may point at a LAN address on every runtime', async () => {
  // Decided 2026-09-18, "allow everywhere, no exceptions": the rule used to
  // follow the runtime, and a hosted instance cannot reach a private address
  // anyway, so refusing it there bought nothing but a second rule to explain.
  for (const url of [
    'https://10.0.0.5/alerts',
    'https://alertmanager/api/v2/alerts',
    'https://alerts.local/hook',
    'https://[::1]/hook',
  ]) {
    assertEquals(await assertAlertWebhookUrlAllowed(url), url)
    assertEquals(await assertAlertWebhookUrlAllowed(url, ALERT_WEBHOOK_POLICY), url)
  }
  // Scheme and credentials are not the address rule and stay.
  const plain = await assertRejects(
    () => assertAlertWebhookUrlAllowed('http://10.0.0.5/alerts'),
    AlertWebhookUrlError
  )
  assertEquals(plain.reason, 'scheme_not_https')
  const creds = await assertRejects(
    () => assertAlertWebhookUrlAllowed('https://u:p@10.0.0.5/alerts'),
    AlertWebhookUrlError
  )
  assertEquals(creds.reason, 'credentials_in_url')
  // The strict gate is still reachable through the option, for the forge
  // callers that keep it.
  const strict = await assertRejects(
    () => assertAlertWebhookUrlAllowed('https://10.0.0.5/alerts', { allowPrivateTargets: false }),
    AlertWebhookUrlError
  )
  assertEquals(strict.reason, 'address_not_public')
})

test('what a settings panel renders is the origin, never the path', () => {
  // The path IS the secret in every common webhook scheme, so returning the
  // whole URL would make every admin who can open the page a credential holder.
  assertEquals(describeAlertWebhook('https://hooks.slack.com/services/T000/B000/XXXX'), {
    configured: true,
    origin: 'https://hooks.slack.com',
  })
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
  assertEquals(await getAlertWebhookUrl(readingDb('tpsecret.v1.aaaa'), undefined), null)
})

test('an unsealed legacy value is still readable', async () => {
  assertEquals(
    await getAlertWebhookUrl(readingDb('https://hooks.example.com/x'), undefined),
    'https://hooks.example.com/x'
  )
})

test('the setting key is stable', () => {
  assertEquals(ALERT_WEBHOOK_URL_KEY, 'ALERT_WEBHOOK_URL')
})

/** A db double whose every read is empty and which records the first insert's values. */
function recordingDb(inserted: Array<Record<string, unknown>>): Db {
  const chain: unknown = new Proxy(() => undefined, {
    get: (_t, prop) => {
      if (prop === 'then') return (resolve: (v: unknown) => void) => resolve([])
      return () => chain
    },
  })
  const db = {
    select: () => chain,
    delete: () => chain,
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    insert: () => ({
      values: (values: Record<string, unknown> | Array<Record<string, unknown>>) => {
        if (!Array.isArray(values)) inserted.push(values)
        return { returning: () => Promise.resolve([{ ...values, id: 'c1' }]) }
      },
    }),
  }
  return db as unknown as Db
}

test('a new operator webhook is created hearing every organization', async () => {
  const secrets = await deriveEncryptionSecretsConfig(parseTestSecretsConfig(), 'data-encryption')
  const inserted: Array<Record<string, unknown>> = []
  await setOperatorWebhookUrl(recordingDb(inserted), secrets, 'https://hooks.example.com/x')
  assertEquals(inserted.length, 1)
  assertEquals(inserted[0].scope, 'instance')
  assertEquals(inserted[0].isAllOrganizationsNotified, true)
})

test('an existing operator webhook with the switch off is switched on before routing', async () => {
  const updates: Array<Record<string, unknown>> = []
  const row = {
    id: 'c1',
    scope: 'instance',
    organizationId: null,
    userId: null,
    kind: 'webhook',
    label: 'Operator alert webhook',
    address: 'x',
    signingSecret: null,
    verifiedAt: null,
    disabledAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    digestCadence: null,
    quietStartMinute: null,
    quietEndMinute: null,
    isPrimary: false,
    isAllOrganizationsNotified: false,
  }
  let reads = 0
  const chain: unknown = new Proxy(() => undefined, {
    get: (_t, prop) => {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve(reads++ === 0 ? [row] : [])
      }
      return () => chain
    },
  })
  const db = {
    select: () => chain,
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values)
        return { where: () => Promise.resolve() }
      },
    }),
  } as unknown as Db
  const channel = await adoptLegacyAlertWebhook(db, undefined)
  assertEquals(updates, [{ isAllOrganizationsNotified: true }])
  assertEquals(channel?.allOrganizations, true)
})
