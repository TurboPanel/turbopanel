import { isNotNull } from 'drizzle-orm'
import type { Db } from '../../db.ts'
import type {
  DaemonCell,
  DaemonCellLease,
  DaemonCellRegistry,
  DaemonCellSnapshot,
  PendingRequestRecord,
} from './contracts.ts'
import {
  resolveCellGeneration,
  resolveCellLocationHint,
} from './location.ts'
import type {
  DaemonInboundEnvelope,
  DaemonOutboundEnvelope,
  OutboxDeliveryId,
} from './protocol.ts'
import { server } from '../../lib/db/schema.ts'

const CELL_SERVER_ID_HEADER = 'X-Turbopanel-Cell-Server-Id'

function isOverloadedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.toLowerCase().includes('overloaded')
}

function isTransientError(err: unknown): boolean {
  if (isOverloadedError(err)) return false
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('network') ||
    message.includes('timeout') ||
    message.includes('failed to fetch') ||
    message.includes('connection')
}

async function resolveLogicalCellName(
  db: Db | undefined,
  serverId: string,
): Promise<{ logicalName: string; locationHint?: DurableObjectLocationHint }> {
  let generation = 1
  let locationHint: string | undefined

  if (db) {
    ;[locationHint, generation] = await Promise.all([
      resolveCellLocationHint(db, serverId),
      resolveCellGeneration(db, serverId),
    ])
  }

  const logicalName = generation > 1 ? `${serverId}:g${generation}` : serverId
  const getOptions = locationHint
    ? { locationHint: locationHint as DurableObjectLocationHint }
    : undefined

  return { logicalName, locationHint: getOptions?.locationHint }
}

type RpcOptions = {
  method?: string
  body?: unknown
  serverId: string
  idempotent?: boolean
}

class DurableObjectStubDaemonCell implements DaemonCell {
  readonly #env: CloudflareBindings
  readonly #db: Db | undefined
  readonly #serverId: string
  #stub: DurableObjectStub | null = null

  constructor(env: CloudflareBindings, db: Db | undefined, serverId: string) {
    this.#env = env
    this.#db = db
    this.#serverId = serverId
  }

  async #resolveStub(): Promise<DurableObjectStub> {
    if (this.#stub) return this.#stub

    const { logicalName, locationHint } = await resolveLogicalCellName(
      this.#db,
      this.#serverId,
    )

    this.#stub = locationHint
      ? this.#env.DAEMON_CELL.getByName(logicalName, { locationHint })
      : this.#env.DAEMON_CELL.getByName(logicalName)

    return this.#stub
  }

  async #resetStub(): Promise<DurableObjectStub> {
    this.#stub = null
    return await this.#resolveStub()
  }

  async #rpc<T>(path: string, opts: RpcOptions): Promise<T> {
    const attempt = async (stub: DurableObjectStub): Promise<T> => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        [CELL_SERVER_ID_HEADER]: opts.serverId,
      }
      const init: RequestInit = {
        method: opts.method ?? (opts.body != null ? 'POST' : 'GET'),
        headers,
      }
      if (opts.body != null) {
        init.body = JSON.stringify({
          ...(typeof opts.body === 'object' && opts.body != null
            ? opts.body as Record<string, unknown>
            : {}),
          serverId: opts.serverId,
        })
      }

      const response = await stub.fetch(`https://do.internal${path}`, init)
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `RPC ${path} failed (${response.status})`)
      }
      return await response.json() as T
    }

    try {
      return await attempt(await this.#resolveStub())
    } catch (err) {
      if (isOverloadedError(err)) throw err
      if (opts.idempotent && isTransientError(err)) {
        return await attempt(await this.#resetStub())
      }
      throw err
    }
  }

  attachDaemonSocket(meta: {
    keyId: string
    hostname?: string
    machineId?: string
    remoteAddress?: string
    connectedAt?: string
  }): Promise<{ connectionId: string; lease: DaemonCellLease }> {
    return this.#rpc('/rpc/attach', {
      serverId: this.#serverId,
      body: { meta },
    })
  }

  detachDaemonSocket(params: {
    connectionId: string
    leaseToken: string
    reason?: string
    closedAt?: string
  }): Promise<void> {
    return this.#rpc('/rpc/detach', {
      serverId: this.#serverId,
      body: { params },
    }).then(() => undefined)
  }

  heartbeat(params: {
    connectionId?: string
    hostname?: string
    at?: string
  }): Promise<void> {
    return this.#rpc('/rpc/heartbeat', {
      serverId: this.#serverId,
      body: { params },
    }).then(() => undefined)
  }

  getSnapshot(): Promise<DaemonCellSnapshot> {
    return this.#rpc('/rpc/snapshot', {
      serverId: this.#serverId,
      method: 'GET',
    })
  }

  putSnapshot(patch: Partial<DaemonCellSnapshot>): Promise<DaemonCellSnapshot> {
    return this.#rpc('/rpc/snapshot', {
      serverId: this.#serverId,
      method: 'PATCH',
      body: { patch },
      idempotent: true,
    })
  }

  appendEvent(
    kind: string,
    payload: Record<string, unknown>,
    ttlSeconds?: number,
  ): Promise<void> {
    return this.#rpc('/rpc/event', {
      serverId: this.#serverId,
      body: { kind, payload, ttlSeconds },
      idempotent: true,
    }).then(() => undefined)
  }

  async listEvents(limit = 50): Promise<Array<{
    seq: string
    kind: string
    at: string
    payload: Record<string, unknown>
  }>> {
    const result = await this.#rpc<{ events: Array<{
      seq: string
      kind: string
      at: string
      payload: Record<string, unknown>
    }> }>(`/rpc/events?limit=${limit}`, {
      serverId: this.#serverId,
      method: 'GET',
    })
    return result.events
  }

  enqueue(
    outbound: DaemonOutboundEnvelope,
    opts?: { ttlSeconds?: number },
  ): Promise<PendingRequestRecord> {
    return this.#rpc('/rpc/enqueue', {
      serverId: this.#serverId,
      body: { outbound, opts },
      idempotent: true,
    })
  }

  markSent(
    deliveryId: OutboxDeliveryId,
    connectionId: string,
    sentAt?: string,
  ): Promise<void> {
    return this.#rpc('/rpc/mark-sent', {
      serverId: this.#serverId,
      body: { deliveryId, connectionId, sentAt },
    }).then(() => undefined)
  }

  async handleInbound(
    inbound: DaemonInboundEnvelope,
  ): Promise<PendingRequestRecord | null> {
    const result = await this.#rpc<{ record: PendingRequestRecord | null }>(
      '/rpc/inbound',
      { serverId: this.#serverId, body: { inbound } },
    )
    return result.record
  }

  async getRequest(requestId: string): Promise<PendingRequestRecord | null> {
    const result = await this.#rpc<{ record: PendingRequestRecord | null }>(
      `/rpc/request?requestId=${encodeURIComponent(requestId)}`,
      { serverId: this.#serverId, method: 'GET' },
    )
    return result.record
  }

  async listRequests(
    limit = 50,
    filter?: { requestKind?: string },
  ): Promise<PendingRequestRecord[]> {
    const params = new URLSearchParams({ limit: String(limit) })
    if (filter?.requestKind) {
      params.set('requestKind', filter.requestKind)
    }
    const result = await this.#rpc<{ records: PendingRequestRecord[] }>(
      `/rpc/requests?${params.toString()}`,
      { serverId: this.#serverId, method: 'GET' },
    )
    return result.records
  }

  async waitForRequest(
    requestId: string,
    timeoutMs: number,
  ): Promise<PendingRequestRecord | null> {
    const result = await this.#rpc<{ record: PendingRequestRecord | null }>(
      '/rpc/wait-request',
      { serverId: this.#serverId, body: { requestId, timeoutMs } },
    )
    return result.record
  }

  async createRequestAndWait(
    outbound: DaemonOutboundEnvelope,
    timeoutMs: number,
  ): Promise<PendingRequestRecord> {
    const result = await this.#rpc<{ record: PendingRequestRecord }>(
      '/rpc/create-and-wait',
      { serverId: this.#serverId, body: { outbound, timeoutMs } },
    )
    return result.record
  }

  async claimDeliveryLease(
    holder: string,
    ttlMs: number,
  ): Promise<DaemonCellLease | null> {
    const result = await this.#rpc<{ lease: DaemonCellLease | null }>(
      '/rpc/lease/claim',
      { serverId: this.#serverId, body: { holder, ttlMs } },
    )
    return result.lease
  }

  async renewDeliveryLease(
    holder: string,
    token: string,
    ttlMs: number,
  ): Promise<DaemonCellLease | null> {
    const result = await this.#rpc<{ lease: DaemonCellLease | null }>(
      '/rpc/lease/renew',
      { serverId: this.#serverId, body: { holder, token, ttlMs } },
    )
    return result.lease
  }

  releaseDeliveryLease(holder: string, token: string): Promise<void> {
    return this.#rpc('/rpc/lease/release', {
      serverId: this.#serverId,
      body: { holder, token },
    }).then(() => undefined)
  }

  async readOutboxBatch(params: {
    consumer: string
    count: number
    blockMs?: number
  }): Promise<DaemonOutboundEnvelope[]> {
    const result = await this.#rpc<{ envelopes: DaemonOutboundEnvelope[] }>(
      '/rpc/outbox/read',
      { serverId: this.#serverId, body: { params } },
    )
    return result.envelopes
  }

  ackOutbox(deliveryIds: OutboxDeliveryId[], consumer: string): Promise<void> {
    return this.#rpc('/rpc/outbox/ack', {
      serverId: this.#serverId,
      body: { deliveryIds, consumer },
    }).then(() => undefined)
  }

  prune(now?: number): Promise<void> {
    return this.#rpc('/rpc/prune', {
      serverId: this.#serverId,
      body: { now },
    }).then(() => undefined)
  }
}

export function createDurableObjectDaemonCellRegistry(
  env: CloudflareBindings,
  db?: Db,
): DaemonCellRegistry {
  const cells = new Map<string, DurableObjectStubDaemonCell>()

  const getCell = (serverId: string): DaemonCell => {
    let cell = cells.get(serverId)
    if (!cell) {
      cell = new DurableObjectStubDaemonCell(env, db, serverId)
      cells.set(serverId, cell)
    }
    return cell
  }

  return {
    getCell,

    async listOnlineServerIds(): Promise<string[]> {
      if (!db) return []

      const rows = await db
        .select({ id: server.id })
        .from(server)
        .where(isNotNull(server.organizationId))

      const online: string[] = []
      await Promise.all(
        rows.map(async (row) => {
          const snapshot = await getCell(row.id).getSnapshot()
          if (snapshot.connected) online.push(row.id)
        }),
      )
      return online
    },

    async getSnapshots(
      serverIds: string[],
    ): Promise<Map<string, DaemonCellSnapshot>> {
      const snapshots = await Promise.all(
        serverIds.map(async (id) => {
          const snapshot = await getCell(id).getSnapshot()
          return [id, snapshot] as const
        }),
      )
      return new Map(snapshots)
    },
  }
}

export { DurableObjectStubDaemonCell }
