/**
 * The per-server metrics ingest gate: exactly one stored sample a minute per
 * server, plus a small catch-up burst, and a bounded number of events an hour.
 *
 * Nothing else enforces the 60 s rhythm: the Workers rate-limit binding counts
 * per Cloudflare location and is only eventually consistent, so it throttles
 * bursts and is not a quota. Without this gate a tampered daemon could mark
 * every sample durable and write about 1,584 rows a minute (roughly $17 per
 * server per month against $0.04 honest).
 *
 * One atomic statement per durable sample, run after the body is validated
 * (the check needs `sampledAt` and the event count): Postgres is strongly
 * consistent, so two samples racing for the same minute can never both pass.
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
 */
import { sql } from 'drizzle-orm'
import type { Db } from '../../db/connection.ts'

/** A sample this long after the last stored one is on time (60 s cadence minus 10 s of jitter). */
export const GATE_MIN_GAP_SECONDS = 50
/** Early samples a server may store in a burst (a 5-minute backlog after an outage). */
export const GATE_SAMPLE_BURST = 5
/** Events a server may store per rolling hour. */
export const GATE_EVENTS_PER_HOUR = 120

export type GateDecision =
  | { stored: true; eventsAllowed: number }
  | { stored: false; reason: 'duplicate' | 'too_soon'; retryAfterSeconds: number }

type GateRow = { events_allowed: number }
type GateStateRow = { last_sampled_at: string; sample_tokens: number; refreshed_at: string }

/**
 * Admit one durable sample for `serverId`, or say why not. `eventCount` is the
 * number of events the sample carries (already cut to the per-sample cap); the
 * decision says how many of them may be stored.
 */
export async function admitMetricsSample(
  db: Pick<Db, 'execute'>,
  serverId: string,
  sampledAt: string,
  eventCount: number
): Promise<GateDecision> {
  const events = Math.max(0, Math.floor(eventCount))
  const rows = (await db.execute(sql`
    INSERT INTO gate AS g (server_id, last_sampled_at, sample_tokens, event_tokens, events_allowed, refreshed_at)
    VALUES (
      ${serverId}::uuid,
      ${sampledAt}::timestamptz,
      ${GATE_SAMPLE_BURST}::double precision,
      ${GATE_EVENTS_PER_HOUR}::double precision - least(${events}::int, ${GATE_EVENTS_PER_HOUR}::int),
      least(${events}::int, ${GATE_EVENTS_PER_HOUR}::int),
      now()
    )
    ON CONFLICT (server_id) DO UPDATE SET
      last_sampled_at = EXCLUDED.last_sampled_at,
      sample_tokens = CASE
        WHEN extract(epoch FROM EXCLUDED.last_sampled_at - g.last_sampled_at) >= ${GATE_MIN_GAP_SECONDS}
          THEN least(${GATE_SAMPLE_BURST}::double precision,
                     g.sample_tokens + extract(epoch FROM now() - g.refreshed_at) / 60)
        ELSE least(${GATE_SAMPLE_BURST}::double precision,
                   g.sample_tokens + extract(epoch FROM now() - g.refreshed_at) / 60) - 1
      END,
      events_allowed = least(${events}::int, floor(least(${GATE_EVENTS_PER_HOUR}::double precision,
        g.event_tokens + extract(epoch FROM now() - g.refreshed_at) * ${GATE_EVENTS_PER_HOUR} / 3600))::int),
      event_tokens = least(${GATE_EVENTS_PER_HOUR}::double precision,
          g.event_tokens + extract(epoch FROM now() - g.refreshed_at) * ${GATE_EVENTS_PER_HOUR} / 3600)
        - least(${events}::int, floor(least(${GATE_EVENTS_PER_HOUR}::double precision,
          g.event_tokens + extract(epoch FROM now() - g.refreshed_at) * ${GATE_EVENTS_PER_HOUR} / 3600))::int),
      refreshed_at = now()
    WHERE EXCLUDED.last_sampled_at > g.last_sampled_at
      AND (
        extract(epoch FROM EXCLUDED.last_sampled_at - g.last_sampled_at) >= ${GATE_MIN_GAP_SECONDS}
        OR least(${GATE_SAMPLE_BURST}::double precision,
                 g.sample_tokens + extract(epoch FROM now() - g.refreshed_at) / 60) >= 1
      )
    RETURNING g.events_allowed
  `)) as unknown as GateRow[]

  const admitted = rows[0]
  if (admitted) return { stored: true, eventsAllowed: Number(admitted.events_allowed) }
  return await refusal(db, serverId, sampledAt)
}

/** Why a sample was refused, and when the server may try again (the slow path, refusals only). */
async function refusal(
  db: Pick<Db, 'execute'>,
  serverId: string,
  sampledAt: string
): Promise<GateDecision> {
  const rows = (await db.execute(sql`
    SELECT last_sampled_at, sample_tokens, refreshed_at FROM gate WHERE server_id = ${serverId}::uuid
  `)) as unknown as GateStateRow[]
  const state = rows[0]
  if (!state || Date.parse(sampledAt) <= Date.parse(state.last_sampled_at)) {
    return { stored: false, reason: 'duplicate', retryAfterSeconds: GATE_MIN_GAP_SECONDS }
  }
  const elapsed = (Date.now() - Date.parse(state.refreshed_at)) / 1000
  const tokens = Math.min(GATE_SAMPLE_BURST, Number(state.sample_tokens) + elapsed / 60)
  const untilToken = Math.max(1, Math.ceil((1 - tokens) * 60))
  const untilGap = Math.max(
    1,
    Math.ceil(
      GATE_MIN_GAP_SECONDS - (Date.parse(sampledAt) - Date.parse(state.last_sampled_at)) / 1000
    )
  )
  return { stored: false, reason: 'too_soon', retryAfterSeconds: Math.min(untilToken, untilGap) }
}
