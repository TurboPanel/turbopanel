function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function readRateFromEnv(): number {
  const hierarchical = Deno.env.get('TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_PER_MINUTE')
  if (hierarchical !== undefined && hierarchical !== '') {
    const n = parsePositiveInt(hierarchical, 0)
    if (n > 0) return n
  }
  return 60
}

function readBurstFromEnv(defaultRate: number): number {
  const hierarchical = Deno.env.get('TURBOPANEL_SYSTEM_EMAIL__RATE_LIMIT_BURST')
  if (hierarchical !== undefined && hierarchical !== '') {
    const n = parsePositiveInt(hierarchical, 0)
    if (n > 0) return n
  }
  return defaultRate
}

/** Milliseconds since the epoch; `Date.now` in production, a fake in tests. */
export type RateLimiterClock = () => number

export class RateLimiter {
  private readonly capacity: number
  private readonly msPerToken: number
  private readonly now: RateLimiterClock
  private tokens: number
  private lastRefillMs: number

  /**
   * `now` is the clock the bucket refills against. Tests pass a fake one so
   * the token count never depends on how long the test itself took.
   */
  constructor(ratePerMinute?: number, burstCapacity?: number, now: RateLimiterClock = Date.now) {
    const rate = ratePerMinute && ratePerMinute > 0 ? ratePerMinute : readRateFromEnv()
    const burst = burstCapacity && burstCapacity > 0 ? burstCapacity : readBurstFromEnv(rate)
    this.capacity = burst
    this.msPerToken = 60_000 / rate
    this.now = now
    this.tokens = burst
    this.lastRefillMs = now()
  }

  tryAcquire(): boolean {
    this.refill()
    if (this.tokens < 1) {
      return false
    }
    this.tokens -= 1
    return true
  }

  getWaitMs(): number {
    this.refill()
    if (this.tokens >= 1) return 0
    return Math.max(1, Math.ceil((1 - this.tokens) * this.msPerToken))
  }

  private refill(): void {
    const now = this.now()
    const elapsed = now - this.lastRefillMs
    if (elapsed <= 0) return
    this.tokens = Math.min(this.capacity, this.tokens + elapsed / this.msPerToken)
    this.lastRefillMs = now
  }
}
