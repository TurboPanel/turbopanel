export class RateLimiter {
  private readonly capacity: number
  private readonly msPerToken: number
  private tokens: number
  private lastRefillMs: number

  constructor(ratePerMinute?: number) {
    const parsedRate = ratePerMinute ??
      Number.parseInt(Deno.env.get('TURBOPANEL_MAILER_RATE_LIMIT_PER_MINUTE') ?? '60', 10)
    const rate = Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 60
    this.capacity = rate
    this.msPerToken = 60_000 / rate
    this.tokens = rate
    this.lastRefillMs = Date.now()
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
    const now = Date.now()
    const elapsed = now - this.lastRefillMs
    if (elapsed <= 0) return
    this.tokens = Math.min(this.capacity, this.tokens + elapsed / this.msPerToken)
    this.lastRefillMs = now
  }
}
