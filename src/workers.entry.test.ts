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
import { takeLastOfflineSweepScheduledTimeForTests } from './daemon/cell/offline-sweep.ts'

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
  // Avoid live Hyperdrive sockets — entry smoke uses doubles only.
  setWorkersDbFactoryForTests(() => undefined)
})

afterEach(() => {
  resetWorkerAppCachesForTests()
  setWorkersDbFactoryForTests(null)
  resetWorkersBindingWarningsForTests()
})

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

  it('scheduled awaits the offline sweep and forwards scheduledTime', async () => {
    const scheduledTime = Date.parse('2026-01-01T00:15:00.000Z')
    const ctx = fakeExecutionContext()
    await workers.scheduled(
      {
        scheduledTime,
        cron: '* * * * *',
        noRetry() {},
      },
      workersTestEnv(),
      ctx,
    )
    expect(ctx.waitUntilPromises).toHaveLength(1)
    expect(takeLastOfflineSweepScheduledTimeForTests()).toBe(scheduledTime)
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
