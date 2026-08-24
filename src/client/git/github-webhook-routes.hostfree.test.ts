/**
 * Route-gate coverage for the GitHub webhook surface.
 *
 * Host-free: the only database work these paths reach before answering is the
 * single `setting` read behind `getGithubAppConfig`, which is stubbed here.
 * The point of these cases is the *order* of the gate — an unconfigured App and
 * an unsigned delivery must both be refused before anything is written.
 */

import { assertEquals } from '@std/assert'
import { Hono } from 'hono'
import type { AppEnv } from '../../app.ts'
import type { Db } from '../../db.ts'
import { GITHUB_WEBHOOK_PATH } from '../../surfaces.ts'
import { deriveEncryptionSecretsConfig } from '../authn/secrets.ts'
import { encryptSecret } from '../authn/data-encryption.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { GITHUB_APP_SETTING_KEY } from '../../lib/git/github-app-config.ts'
import {
  GITHUB_WEBHOOK_MAX_BODY_BYTES,
  registerGithubWebhookRoutes,
  successfulCheckSha,
} from './github-webhook-routes.ts'
import {
  sourceWatchesBranch,
  type TriggerSummary,
  triggerSummaryNeedsRetry,
} from '../sources/webhook-trigger.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const encoder = new TextEncoder()

/** Minimal `select().from().where().limit()` chain returning one settings row. */
function stubSettingDb(rows: Array<{ key: string; value: unknown }>): Db {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  } as unknown as Db
}

async function buildApp(opts: {
  webhookSecret?: string | null
  rateLimited?: boolean
}) {
  const secretsConfig = parseTestSecretsConfig('deno')
  const dataEncryptionSecrets = await deriveEncryptionSecretsConfig(
    secretsConfig,
    'data-encryption',
  )

  const rows = opts.webhookSecret === undefined ? [] : [{
    key: GITHUB_APP_SETTING_KEY,
    value: {
      appId: '1234',
      privateKeyEnvelope: await encryptSecret(dataEncryptionSecrets, 'pem-placeholder'),
      ...(opts.webhookSecret === null ? {} : {
        webhookSecretEnvelope: await encryptSecret(
          dataEncryptionSecrets,
          opts.webhookSecret,
        ),
      }),
    },
  }]

  const app = new Hono<AppEnv>()
  app.use('*', (c, next) => {
    c.set('db', stubSettingDb(rows))
    c.set('dataEncryptionSecrets', dataEncryptionSecrets)
    return next()
  })
  registerGithubWebhookRoutes(app, {
    runtime: 'deno',
    ...(opts.rateLimited === undefined ? {} : {
      rateLimiter: { limit: () => Promise.resolve({ success: !opts.rateLimited }) },
    }),
  })
  return app
}

async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    { name: 'HMAC' },
    key,
    encoder.encode(body) as BufferSource,
  )
  const hex = [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `sha256=${hex}`
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://instance${GITHUB_WEBHOOK_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

test('rate limit is spent before any App config read', async () => {
  const app = await buildApp({ rateLimited: true })
  const res = await app.request(post('{}'))
  assertEquals(res.status, 429)
})

test('an unconfigured App refuses rather than accepting unsigned deliveries', async () => {
  const app = await buildApp({})
  const res = await app.request(post('{}', { 'x-github-event': 'push' }))
  assertEquals(res.status, 503)
  assertEquals(await res.json(), { error: 'github_app_not_configured' })
})

test('a configured App with no webhook secret still refuses', async () => {
  const app = await buildApp({ webhookSecret: null })
  const res = await app.request(post('{}', { 'x-github-event': 'push' }))
  assertEquals(res.status, 503)
})

test('a missing or wrong signature is 401 before the delivery is claimed', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })

  const unsigned = await app.request(post('{}', { 'x-github-event': 'push' }))
  assertEquals(unsigned.status, 401)

  const wrong = await app.request(post('{}', {
    'x-github-event': 'push',
    'x-hub-signature-256': `sha256=${'a'.repeat(64)}`,
  }))
  assertEquals(wrong.status, 401)
})

test('a signed delivery missing its event or id headers is a bad request', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const body = '{}'
  const signature = await signBody('shh', body)

  const noEvent = await app.request(post(body, {
    'x-hub-signature-256': signature,
    'x-github-delivery': crypto.randomUUID(),
  }))
  assertEquals(noEvent.status, 400)

  const noDelivery = await app.request(post(body, {
    'x-hub-signature-256': signature,
    'x-github-event': 'push',
  }))
  assertEquals(noDelivery.status, 400)
})

test('an oversized declared body is refused before it is buffered', async () => {
  const app = await buildApp({ webhookSecret: 'shh' })
  const res = await app.request(post('{}', {
    'x-github-event': 'push',
    'content-length': String(GITHUB_WEBHOOK_MAX_BODY_BYTES + 1),
  }))
  assertEquals(res.status, 413)
})

test('successfulCheckSha reads only completed successful suites', () => {
  assertEquals(
    successfulCheckSha('check_suite', {
      check_suite: { status: 'completed', conclusion: 'success', head_sha: 'a'.repeat(40) },
    }),
    'a'.repeat(40),
  )
  assertEquals(
    successfulCheckSha('check_suite', {
      check_suite: { status: 'completed', conclusion: 'failure', head_sha: 'a'.repeat(40) },
    }),
    null,
  )
  assertEquals(
    successfulCheckSha('check_suite', {
      check_suite: { status: 'in_progress', conclusion: null, head_sha: 'a'.repeat(40) },
    }),
    null,
  )
  assertEquals(successfulCheckSha('check_suite', {}), null)
})

test('successfulCheckSha releases a check_run only once its suite is green', () => {
  // The suite has concluded successfully: every run in it finished green, so
  // this last run is a valid all-checks-passed signal. The SHA nests one level
  // down, on the suite.
  assertEquals(
    successfulCheckSha('check_run', {
      check_run: {
        status: 'completed',
        conclusion: 'success',
        check_suite: {
          status: 'completed',
          conclusion: 'success',
          head_sha: 'b'.repeat(40),
        },
      },
    }),
    'b'.repeat(40),
  )
  // One green job while the rest of the suite is still running must not release
  // a `checks_passed` deploy.
  assertEquals(
    successfulCheckSha('check_run', {
      check_run: {
        status: 'completed',
        conclusion: 'success',
        head_sha: 'b'.repeat(40),
        check_suite: { status: 'in_progress', conclusion: null, head_sha: 'b'.repeat(40) },
      },
    }),
    null,
  )
  // Nor may one that passed inside a suite that ended up failing.
  assertEquals(
    successfulCheckSha('check_run', {
      check_run: {
        status: 'completed',
        conclusion: 'success',
        head_sha: 'b'.repeat(40),
        check_suite: { status: 'completed', conclusion: 'failure', head_sha: 'b'.repeat(40) },
      },
    }),
    null,
  )
  // A run with no suite at all carries no all-checks-green claim.
  assertEquals(
    successfulCheckSha('check_run', {
      check_run: { status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40) },
    }),
    null,
  )
  assertEquals(
    successfulCheckSha('check_run', {
      check_run: {
        status: 'completed',
        conclusion: 'failure',
        check_suite: { status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40) },
      },
    }),
    null,
  )
})

test('triggerSummaryNeedsRetry asks for a redelivery only on instance faults', () => {
  const summary = (over: Partial<TriggerSummary>): TriggerSummary => ({
    matchedSources: 1,
    queued: 0,
    skipped: 0,
    failed: 0,
    outcomes: [],
    ...over,
  })

  // A queue that was down will be up on the retry: the commit is recoverable
  // only if GitHub is told to come back.
  assertEquals(triggerSummaryNeedsRetry(summary({ failed: 1 })), true)
  // Everything else looks identical on a retry, so 5xx would only loop.
  assertEquals(triggerSummaryNeedsRetry(summary({ skipped: 3 })), false)
  assertEquals(triggerSummaryNeedsRetry(summary({ queued: 2 })), false)
  assertEquals(triggerSummaryNeedsRetry(summary({ queued: 1, failed: 1 })), true)
})

test('sourceWatchesBranch: a blank default branch watches every branch', () => {
  assertEquals(sourceWatchesBranch('main', 'main'), true)
  assertEquals(sourceWatchesBranch('main', 'develop'), false)
  assertEquals(sourceWatchesBranch(' main ', 'main'), true)
  assertEquals(sourceWatchesBranch(null, 'anything'), true)
  assertEquals(sourceWatchesBranch('   ', 'anything'), true)
})
