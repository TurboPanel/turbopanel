import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { RateLimiter } from './rate-limiter.ts'

const ORIGINAL_ENV = { ...process.env }

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete (process.env as any)[k]
    else (process.env as any)[k] = v
  }
  // Provide a Deno shim for the module under test when running under vitest node env
  ;(globalThis as any).Deno = {
    env: {
      get: (k: string) => (process.env as any)[k],
    },
  }
}

function restoreEnv() {
  for (const k of Object.keys(process.env)) delete (process.env as any)[k]
  Object.assign(process.env, ORIGINAL_ENV)
  delete (globalThis as any).Deno
}

describe('RateLimiter', () => {
  beforeEach(() => {
    setEnv({})
  })
  afterEach(() => {
    restoreEnv()
  })

  it('defaults to 60/min with capacity == rate when no burst provided', () => {
    const rl = new RateLimiter()
    // Internals not exported; exercise via behavior
    // Acquire up to capacity should succeed without wait
    for (let i = 0; i < 60; i++) {
      expect(rl.tryAcquire()).toBe(true)
    }
    expect(rl.tryAcquire()).toBe(false)
  })

  it('accepts explicit rate and burst (burst > rate yields larger capacity)', () => {
    const rl = new RateLimiter(100, 250)
    for (let i = 0; i < 250; i++) {
      expect(rl.tryAcquire()).toBe(true)
    }
    expect(rl.tryAcquire()).toBe(false)
  })

  it('uses burst as actual capacity even when smaller than rate', () => {
    const rl = new RateLimiter(100, 20)
    for (let i = 0; i < 20; i++) {
      expect(rl.tryAcquire()).toBe(true)
    }
    expect(rl.tryAcquire()).toBe(false)
  })

  it('reads hierarchical env for rate and burst', () => {
    setEnv({
      TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE: '10',
      TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_BURST: '15',
    })
    const rl = new RateLimiter()
    for (let i = 0; i < 15; i++) expect(rl.tryAcquire()).toBe(true)
    expect(rl.tryAcquire()).toBe(false)
  })

  it('falls back to legacy TURBOPANEL_MAILER_RATE_LIMIT_PER_MINUTE when no hierarchical key', () => {
    setEnv({ TURBOPANEL_MAILER_RATE_LIMIT_PER_MINUTE: '5' })
    const rl = new RateLimiter()
    for (let i = 0; i < 5; i++) expect(rl.tryAcquire()).toBe(true)
    expect(rl.tryAcquire()).toBe(false)
  })

  it('hierarchical takes precedence over legacy', () => {
    setEnv({
      TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE: '3',
      TURBOPANEL_MAILER_RATE_LIMIT_PER_MINUTE: '99',
    })
    const rl = new RateLimiter()
    for (let i = 0; i < 3; i++) expect(rl.tryAcquire()).toBe(true)
    expect(rl.tryAcquire()).toBe(false)
  })
})
