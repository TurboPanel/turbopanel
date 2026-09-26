import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { RateLimiter } from './rate-limiter.ts'

const ORIGINAL_ENV = { ...process.env }
const env = process.env as Record<string, string | undefined>
const globals = globalThis as { Deno?: unknown }

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  // Provide a Deno shim for the module under test when running under vitest node env
  globals.Deno = {
    env: {
      get: (k: string) => env[k],
    },
  }
}

function restoreEnv() {
  for (const k of Object.keys(env)) delete env[k]
  Object.assign(process.env, ORIGINAL_ENV)
  delete globals.Deno
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
})
