/**
 * The per-server metrics ingest gate: exactly one stored sample a minute per
 * server, plus a small catch-up burst, and a bounded number of events an hour.
 *
 * Nothing else enforces the 60 s rhythm: the Workers rate-limit binding counts
 * per Cloudflare location and is only eventually consistent, so it throttles
 * bursts and is not a quota, and Analytics Engine is write-only (a row cannot
 * be read back at ingest, and its SQL has no way to drop duplicate sample
 * times before averaging). Without this gate a tampered daemon could mark
 * every sample durable and write about 1,584 rows a minute (roughly $17 per
 * server per month against $0.04 honest).
 *
 * The rules live in one pure function, {@link decideAdmission}; where its
 * state lives depends on the runtime and never involves Postgres:
 * - Workers: one small Durable Object per server (`ingest-gate-object.ts`),
 *   which serialises admissions, so two samples racing for the same minute can
 *   never both pass. Exact.
 * - Self-hosted: a bounded in-process map ({@link createInMemoryMetricsGate}).
 *   Exact while the process lives; a restart forgets the last stored time, so
 *   at most one early or replayed sample can slip through right after it.
 *
 * Rules, in order:
 * - a sample at or before the last stored one is a duplicate or a replay:
 *   refused;
 * - a sample at least {@link GATE_MIN_GAP_SECONDS} after the last one is on
 *   time: stored;
 * - an earlier one spends a catch-up token (bucket of
 *   {@link GATE_SAMPLE_BURST}, refilling one a minute) so a daemon can flush a
 *   short backlog after an outage, and nothing more;
 * - events are stored while the hourly budget lasts
 *   ({@link GATE_EVENTS_PER_HOUR}, refilling evenly); the rest are dropped.
 *
 * What stays best effort: the Analytics Engine write after an admitted sample
 * is fire-and-forget, so an admitted sample can still be lost, and nothing
 * retries it.
 */

/** A sample this long after the last stored one is on time (60 s cadence minus 10 s of jitter). */
export const GATE_MIN_GAP_SECONDS = 50
/** Early samples a server may store in a burst (a 5-minute backlog after an outage). */
export const GATE_SAMPLE_BURST = 5
/** Events a server may store per rolling hour. */
export const GATE_EVENTS_PER_HOUR = 120

export type GateDecision =
  | { stored: true; eventsAllowed: number }
  | { stored: false; reason: 'duplicate' | 'too_soon'; retryAfterSeconds: number }

/** What the gate remembers about one server. */
export type GateState = {
  lastSampledMs: number
  sampleTokens: number
  eventTokens: number
  refreshedMs: number
}

/** The seam the ingest route calls; the runtime decides where the state lives. */
export type MetricsGate = {
  admit(serverId: string, sampledAt: string, eventCount: number): Promise<GateDecision>
}

/** What a gate asks of a server: when the sample was taken, how many events it carries. */
export type GateRequest = { sampledAt: string; eventCount: number }

/**
 * The whole rule set. Pure: `state` is what was remembered (`undefined` for a
 * server never seen), `nowMs` the receive time. Returns the decision and the
 * state to remember; a refusal leaves the state exactly as it was.
 */
export function decideAdmission(
  state: GateState | undefined,
  request: GateRequest,
  nowMs: number
): { decision: GateDecision; next: GateState | undefined } {
  const sampledMs = Date.parse(request.sampledAt)
  const events = Math.max(0, Math.floor(request.eventCount))
  if (!Number.isFinite(sampledMs)) {
    return {
      decision: { stored: false, reason: 'duplicate', retryAfterSeconds: GATE_MIN_GAP_SECONDS },
      next: state,
    }
  }
  if (state === undefined) {
    const allowed = Math.min(events, GATE_EVENTS_PER_HOUR)
    return {
      decision: { stored: true, eventsAllowed: allowed },
      next: {
        lastSampledMs: sampledMs,
        sampleTokens: GATE_SAMPLE_BURST,
        eventTokens: GATE_EVENTS_PER_HOUR - allowed,
        refreshedMs: nowMs,
      },
    }
  }

  const gapSeconds = (sampledMs - state.lastSampledMs) / 1000
  if (gapSeconds <= 0) {
    return {
      decision: { stored: false, reason: 'duplicate', retryAfterSeconds: GATE_MIN_GAP_SECONDS },
      next: state,
    }
  }
  const elapsedSeconds = Math.max(0, (nowMs - state.refreshedMs) / 1000)
  const refilledSamples = Math.min(GATE_SAMPLE_BURST, state.sampleTokens + elapsedSeconds / 60)
  const onTime = gapSeconds >= GATE_MIN_GAP_SECONDS
  if (!onTime && refilledSamples < 1) {
    const untilToken = Math.max(1, Math.ceil((1 - refilledSamples) * 60))
    const untilGap = Math.max(1, Math.ceil(GATE_MIN_GAP_SECONDS - gapSeconds))
    return {
      decision: {
        stored: false,
        reason: 'too_soon',
        retryAfterSeconds: Math.min(untilToken, untilGap),
      },
      next: state,
    }
  }

  const eventBudget = Math.min(
    GATE_EVENTS_PER_HOUR,
    state.eventTokens + (elapsedSeconds * GATE_EVENTS_PER_HOUR) / 3600
  )
  const allowed = Math.min(events, Math.floor(eventBudget))
  return {
    decision: { stored: true, eventsAllowed: allowed },
    next: {
      lastSampledMs: sampledMs,
      sampleTokens: onTime ? refilledSamples : refilledSamples - 1,
      eventTokens: eventBudget - allowed,
      refreshedMs: nowMs,
    },
  }
}

/** Servers the in-process gate remembers at once; the oldest-seen is forgotten first. */
const MAX_IN_MEMORY_SERVERS = 10_000

/**
 * Self-hosted gate: the same rules over a bounded in-process map. Forgetting a
 * server (a restart, or the map overflowing) only ever resets its burst, so
 * the memory use is bounded whatever the daemons send.
 */
export function createInMemoryMetricsGate(now: () => number = Date.now): MetricsGate {
  const states = new Map<string, GateState>()
  return {
    admit(serverId, sampledAt, eventCount) {
      const { decision, next } = decideAdmission(
        states.get(serverId),
        { sampledAt, eventCount },
        now()
      )
      if (next !== undefined) {
        states.delete(serverId)
        states.set(serverId, next)
        if (states.size > MAX_IN_MEMORY_SERVERS) {
          const oldest = states.keys().next()
          if (!oldest.done) states.delete(oldest.value)
        }
      }
      return Promise.resolve(decision)
    },
  }
}

/**
 * Workers gate: asks the server's own gate object. The object answers with the
 * decision as JSON; anything else (the object unreachable, a malformed answer)
 * throws, and the route turns that into a 503 rather than storing unmetered.
 */
export function createDurableObjectMetricsGate(namespace: {
  getByName(name: string): { fetch(input: string, init?: RequestInit): Promise<Response> }
}): MetricsGate {
  return {
    async admit(serverId, sampledAt, eventCount) {
      const stub = namespace.getByName(serverId)
      const response = await stub.fetch('https://metrics-gate/admit', {
        method: 'POST',
        body: JSON.stringify({ sampledAt, eventCount } satisfies GateRequest),
      })
      if (!response.ok) throw new Error(`metrics gate answered ${response.status}`)
      const decision = (await response.json()) as GateDecision
      if (typeof decision?.stored !== 'boolean') throw new Error('metrics gate answered nonsense')
      return decision
    },
  }
}
