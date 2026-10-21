/// <reference types="@cloudflare/workers-types" />
/**
 * The Workers home of the metrics ingest gate (`ingest-gate.ts`): one Durable
 * Object per server (`getByName(serverId)`), holding that server's
 * {@link GateState}. A Durable Object runs one request at a time per object,
 * so admissions for a server are strictly ordered and the count is exact; it
 * keeps the state in memory and writes it through to its own storage so an
 * eviction or a deploy does not hand the server a fresh burst.
 *
 * Distinct from `DaemonCellObject` on purpose: that is the daemon's WebSocket
 * cell and ingest must never wake it (see the metrics route). This object has
 * no sockets, no alarms and no database, so a call is a few microseconds.
 */
import { decideAdmission, type GateRequest, type GateState } from './ingest-gate.ts'

const STATE_KEY = 'state'

export class MetricsGateObject {
  readonly #ctx: DurableObjectState
  #state: GateState | undefined
  #loaded = false

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.#ctx = ctx
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
    let body: GateRequest
    try {
      body = (await request.json()) as GateRequest
    } catch {
      return new Response('bad request', { status: 400 })
    }
    if (typeof body?.sampledAt !== 'string' || typeof body?.eventCount !== 'number') {
      return new Response('bad request', { status: 400 })
    }
    if (!this.#loaded) {
      this.#state = await this.#ctx.storage.get<GateState>(STATE_KEY)
      this.#loaded = true
    }
    const { decision, next } = decideAdmission(this.#state, body, Date.now())
    if (next !== this.#state) {
      this.#state = next
      await this.#ctx.storage.put(STATE_KEY, next)
    }
    return Response.json(decision)
  }
}
