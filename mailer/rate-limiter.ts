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

export class RateLimiter {
  private readonly capacity: number
  private readonly msPerToken: number
  private tokens: number
  private lastRefillMs: number

  constructor(ratePerMinute?: number, burstCapacity?: number) {
    const rate = ratePerMinute && ratePerMinute > 0 ? ratePerMinute : readRateFromEnv()
    const burst = burstCapacity && burstCapacity > 0 ? burstCapacity : readBurstFromEnv(rate)
    this.capacity = burst
    this.msPerToken = 60_000 / rate
    this.tokens = burst
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
