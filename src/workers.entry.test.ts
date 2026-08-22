/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Thin Workers-pool smoke suite for `src/workers.ts` entry handlers
 * (`fetch` / `queue` / `scheduled`). Exercises env doubles only — never a
 * live Hyperdrive pool. Keep this file in `vitest.config.ts` `test.include`
 * (explicit enumeration); do **not** add it to `scripts/test-coverage.sh`.
 */
import { env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from './db.ts'
import { HEALTH_PATH } from './surfaces.ts'
import {
  resetWorkersBindingWarningsForTests,
  setWorkersDbFactoryForTests,
} from './workers-bindings.ts'
import workers, { resetWorkerAppCachesForTests } from './workers.ts'
import { resetContainerLogStoreSelectionWarningsForTests } from './lib/container-logs/store-selection.ts'

function mockDb(label: string): Db {
  return {
    label,
    $client: {
      end: () => Promise.resolve(),
    },
  } as unknown as Db
}

function fakeExecutionContext(): ExecutionContext & {
  waitUntilPromises: Promise<unknown>[]
} {
  const waitUntilPromises: Promise<unknown>[] = []
  return {
    waitUntilPromises,
    waitUntil(promise: Promise<unknown>) {
      waitUntilPromises.push(promise)
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext & { waitUntilPromises: Promise<unknown>[] }
}

function workersTestEnv(overrides?: Partial<CloudflareBindings>): CloudflareBindings {
  return { ...env, ...overrides } as unknown as CloudflareBindings
}

function fakeQueueMessage(body: unknown): Message<unknown> & {
  acked: boolean
  retried: boolean
} {
  const state = { acked: false, retried: false }
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(),
    body,
    attempts: 1,
    ack() {
      state.acked = true
    },
    retry() {
      state.retried = true
    },
    get acked() {
      return state.acked
    },
    get retried() {
      return state.retried
    },
  } as Message<unknown> & { acked: boolean; retried: boolean }
}

function fakeMessageBatch(
  messages: Message<unknown>[],
): MessageBatch<unknown> & { retriedAll: boolean } {
  let retriedAll = false
  return {
    queue: 'daemon-commands-test',
    messages,
    metadata: {
      metrics: {
        backlogCount: 0,
        backlogBytes: 0,
      },
    },
    retryAll() {
      retriedAll = true
    },
    ackAll() {},
    get retriedAll() {
      return retriedAll
    },
  } as unknown as MessageBatch<unknown> & { retriedAll: boolean }
}

beforeEach(() => {
  resetWorkerAppCachesForTests()
  resetWorkersBindingWarningsForTests()
  resetContainerLogStoreSelectionWarningsForTests()
  // Avoid live Hyperdrive sockets — entry smoke uses doubles only.
  setWorkersDbFactoryForTests(() => undefined)
})

afterEach(() => {
  resetWorkerAppCachesForTests()
  setWorkersDbFactoryForTests(null)
  resetWorkersBindingWarningsForTests()
  resetContainerLogStoreSelectionWarningsForTests()
})

/** Capture `console.warn` for the duration of one call. */
async function captureWarnings(run: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '))
  }
  try {
    await run()
  } finally {
    console.warn = original
  }
  return warnings
}

describe('workers.ts entry handlers', () => {
  it('fetch serves /api/health after init and closes per-request DB handles', async () => {
    const ctx = fakeExecutionContext()
    const response = await workers.fetch(
      new Request(`https://panel.example.com${HEALTH_PATH}`),
      workersTestEnv(),
      ctx,
    )
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean }
    expect(body.ok).toBe(true)
    expect(ctx.waitUntilPromises.length).toBeGreaterThanOrEqual(1)
    await Promise.all(ctx.waitUntilPromises)
  }, 30_000)

  it('fetch applies signup force and dev-surface env branches', async () => {
    resetWorkerAppCachesForTests()
    const ctx = fakeExecutionContext()
    const testEnv = workersTestEnv({
      TURBOPANEL_DEV_SURFACE: '1',
      // Non-string binding — stringBindingEnv must still surface the force.
      TURBOPANEL_IS_SIGNUP_ENABLED: true as unknown as string,
    })

    const response = await workers.fetch(
      new Request(`https://panel.example.com${HEALTH_PATH}`),
      testEnv,
      ctx,
    )
    expect(response.status).toBe(200)
    await Promise.all(ctx.waitUntilPromises)
  }, 30_000)

  // Container logs are default-off and their Pipelines binding is only added to
  // wrangler.jsonc once the Stream exists, so the disabled fallback — not the
  // Cloudflare store — is the steady state on every deployed env.
  it('fetch resolves a container-log store without a CONTAINER_LOGS binding', async () => {
    const ctx = fakeExecutionContext()
    const warnings = await captureWarnings(async () => {
      const response = await workers.fetch(
        new Request(`https://panel.example.com${HEALTH_PATH}`),
        workersTestEnv(),
        ctx,
      )
      expect(response.status).toBe(200)
    })
    // Default-off means no misconfiguration warning: this is the expected state.
    expect(warnings.filter((line) => line.includes('container logs'))).toEqual([])
    await Promise.all(ctx.waitUntilPromises)
  }, 30_000)

  it('fetch warns once when container logs are enabled but unconfigured', async () => {
    const ctx = fakeExecutionContext()
    const warnings = await captureWarnings(async () => {
      const response = await workers.fetch(
        new Request(`https://panel.example.com${HEALTH_PATH}`),
        workersTestEnv({ TURBOPANEL_CONTAINER_LOGS_ENABLED: '1' }),
        ctx,
      )
      // The request still succeeds — an unconfigured backend degrades to the
      // disabled no-op store, it never fails a request.
      expect(response.status).toBe(200)
    })
    expect(
      warnings.filter((line) => line.includes('container logs are enabled on Workers')),
    ).toHaveLength(1)
    await Promise.all(ctx.waitUntilPromises)
  }, 30_000)

  it('fetch selects the Pipelines store when the binding and R2 SQL config are complete', async () => {
    const sends: unknown[][] = []
    const ctx = fakeExecutionContext()
    const warnings = await captureWarnings(async () => {
      const response = await workers.fetch(
        new Request(`https://panel.example.com${HEALTH_PATH}`),
        workersTestEnv({
          TURBOPANEL_CONTAINER_LOGS_ENABLED: 'true',
          CLOUDFLARE_ACCOUNT_ID: 'acct-entry-test',
          TURBOPANEL_CONTAINER_LOGS_R2_SQL_API_TOKEN: 'token-entry-test',
          TURBOPANEL_CONTAINER_LOGS_R2_SQL_BUCKET: 'entry-test-container-logs',
          CONTAINER_LOGS: {
            send(records: unknown[]) {
              sends.push(records)
              return Promise.resolve()
            },
          } as unknown as CloudflareBindings['CONTAINER_LOGS'],
        }),
        ctx,
      )
      expect(response.status).toBe(200)
    })
    expect(warnings.filter((line) => line.includes('container logs'))).toEqual([])
    // Resolving the store must never write: ingest only happens on real events.
    expect(sends).toEqual([])
    await Promise.all(ctx.waitUntilPromises)
  }, 30_000)

  it('scheduled runs offline sweep waitUntil (no-db early return)', async () => {
    const ctx = fakeExecutionContext()
    await workers.scheduled(
      {
        scheduledTime: Date.now(),
        cron: '* * * * *',
        noRetry() {},
      },
      workersTestEnv(),
      ctx,
    )
    expect(ctx.waitUntilPromises).toHaveLength(1)
    await Promise.all(ctx.waitUntilPromises)
  }, 30_000)

  it('queue retries the batch when no DB client is available', async () => {
    setWorkersDbFactoryForTests(() => undefined)
    const batch = fakeMessageBatch([
      fakeQueueMessage({ commandId: 'cmd-1' }),
    ])
    await workers.queue(batch, workersTestEnv())
    expect(batch.retriedAll).toBe(true)
  }, 30_000)

  it('queue acks permanent envelope parse failures', async () => {
    setWorkersDbFactoryForTests(() => mockDb('queue-permanent'))
    const msg = fakeQueueMessage({ not: 'a-command-envelope' })
    const batch = fakeMessageBatch([msg])
    await workers.queue(batch, workersTestEnv())
    expect(msg.acked).toBe(true)
    expect(msg.retried).toBe(false)
    expect(batch.retriedAll).toBe(false)
  }, 30_000)

  it('queue retries transient process failures', async () => {
    // Drizzle/sql touches throw a classifier-matched infrastructure error; allow
    // `$client.end` so the entry `finally` can still close the handle.
    const transientDb = new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === '$client') {
          return { end: () => Promise.resolve() }
        }
        throw new Error('network timeout contacting postgres')
      },
      apply() {
        throw new Error('network timeout contacting postgres')
      },
    }) as unknown as Db
    setWorkersDbFactoryForTests(() => transientDb)

    const msg = fakeQueueMessage({
      commandId: crypto.randomUUID(),
      serverId: crypto.randomUUID(),
      type: 'daemon.ping',
      attempt: 1,
      queuedAt: new Date().toISOString(),
    })
    const batch = fakeMessageBatch([msg])
    await workers.queue(batch, workersTestEnv())
    expect(msg.retried).toBe(true)
    expect(msg.acked).toBe(false)
  }, 30_000)
})
