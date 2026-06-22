import type {
  DaemonCell,
  DaemonCellLease,
  DaemonCellSnapshot,
  PendingRequestRecord,
  PendingRequestStatus,
} from '../contracts.ts'
import type {
  DaemonInboundEnvelope,
  DaemonOutboundEnvelope,
  OutboxDeliveryId,
} from '../protocol.ts'
import { mergeSnapshotPresence } from '../snapshot-merge.ts'
import type { RedisCellClient, StreamEntry } from './client.ts'
import {
  connKey,
  eventsKey,
  LEASE_TTL_MS,
  leaseKey,
  metaKey,
  onlineSetKey,
  OUTBOX_GROUP,
  outboxKey,
  requestKey,
  requestsKey,
  snapshotKey,
} from './keys.ts'
import {
  COMPARE_AND_DELETE,
  COMPARE_AND_RENEW,
  RECONCILE_STALE_SOCKET_PRESENCE,
} from './lua.ts'

const TERMINAL_STATUSES = new Set<PendingRequestStatus>([
  'done',
  'failed',
  'expired',
])

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString()
}

function parseSnapshot(raw: string | null, serverId: string): DaemonCellSnapshot | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as DaemonCellSnapshot
    return { ...parsed, serverId }
  } catch {
    return null
  }
}

function snapshotFromMeta(
  serverId: string,
  meta: Record<string, string>,
): DaemonCellSnapshot {
  return {
    serverId,
    version: Number(meta.snapshotVersion ?? '0'),
    updatedAt: meta.updatedAt ?? nowIso(),
    hostname: meta.hostname || undefined,
    machineId: meta.machineId || undefined,
    remoteAddress: meta.remoteAddress || undefined,
    sessionId: meta.sessionId || undefined,
    keyId: meta.keyId || undefined,
    connected: meta.connected === '1',
    connectedAt: meta.connectedAt || undefined,
    lastInboundAt: meta.lastInboundAt || undefined,
    lastOutboundAt: meta.lastOutboundAt || undefined,
    lastHeartbeatAt: meta.lastHeartbeatAt || undefined,
  }
}

function parseRequestRecord(
  serverId: string,
  requestId: string,
  fields: Record<string, string>,
): PendingRequestRecord {
  const record: PendingRequestRecord = {
    serverId,
    requestId,
    requestKind: fields.requestKind ?? '',
    status: (fields.status ?? 'queued') as PendingRequestStatus,
    createdAt: fields.createdAt ?? nowIso(),
    expiresAt: fields.expiresAt ?? nowIso(),
  }
  if (fields.ackAt) record.ackAt = fields.ackAt
  if (fields.finishedAt) record.finishedAt = fields.finishedAt
  if (fields.error) record.error = fields.error
  if (fields.command) record.command = fields.command
  if (fields.result) {
    try {
      record.result = JSON.parse(fields.result)
    } catch {
      record.result = fields.result
    }
  }
  return record
}

function isTerminalStatus(status: PendingRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

function envelopeFromOutboxFields(fields: Record<string, string>): DaemonOutboundEnvelope | null {
  const payloadRaw = fields.payload
  if (!payloadRaw) return null
  try {
    return JSON.parse(payloadRaw) as DaemonOutboundEnvelope
  } catch {
    return null
  }
}

function parseDeliveryMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, string>
  } catch {
    return {}
  }
}

function isLeaseOpSuccess(result: unknown): boolean {
  return result === 'OK' || result === 1
}

export class RedisDaemonCell implements DaemonCell {
  readonly #client: RedisCellClient
  readonly #serverId: string
  readonly #reclaimedByConsumer = new Map<string, StreamEntry[]>()
  readonly #deliveryToStreamId = new Map<string, string>()

  constructor(client: RedisCellClient, serverId: string) {
    this.#client = client
    this.#serverId = serverId
  }

  async #renewDaemonSocketLease(
    connectionId: string,
  ): Promise<boolean> {
    const renewed = await this.#client.eval(
      COMPARE_AND_RENEW,
      1,
      leaseKey(this.#serverId),
      connectionId,
      connectionId,
      LEASE_TTL_MS,
    )
    return isLeaseOpSuccess(renewed)
  }

  #rememberOutboxEntries(entries: StreamEntry[]): void {
    for (const entry of entries) {
      const deliveryId = entry.fields.deliveryId
      if (deliveryId) {
        this.#deliveryToStreamId.set(deliveryId, entry.id)
      }
    }
  }

  #entriesToEnvelopes(entries: StreamEntry[]): DaemonOutboundEnvelope[] {
    this.#rememberOutboxEntries(entries)
    const envelopes: DaemonOutboundEnvelope[] = []
    for (const entry of entries) {
      const env = envelopeFromOutboxFields(entry.fields)
      if (env) envelopes.push(env)
    }
    return envelopes
  }

  async #resolveStreamIdForDelivery(deliveryId: string): Promise<string | null> {
    const cached = this.#deliveryToStreamId.get(deliveryId)
    if (cached) return cached

    const requestIds = await this.#client.zrangebyscore(
      requestsKey(this.#serverId),
      '-inf',
      '+inf',
    )
    for (const requestId of requestIds) {
      const fields = await this.#client.hgetall(
        requestKey(this.#serverId, requestId),
      )
      if (!fields) continue
      const deliveries = parseDeliveryMap(fields.deliveries)
      const streamId = deliveries[deliveryId]
      if (streamId) return streamId
    }
    return null
  }

  async reconcileStalePresence(now = Date.now()): Promise<boolean> {
    const result = await this.#client.eval(
      RECONCILE_STALE_SOCKET_PRESENCE,
      3,
      leaseKey(this.#serverId),
      metaKey(this.#serverId),
      onlineSetKey(),
      this.#serverId,
      nowIso(now),
      'lease-expired',
    )

    const demoted = Array.isArray(result)
      ? result[0] === 1 || result[0] === '1'
      : result === 1
    if (!demoted) return false

    const staleConnectionId = Array.isArray(result) && result[1]
      ? String(result[1])
      : undefined
    if (staleConnectionId) {
      await this.appendEvent('disconnected', {
        connectionId: staleConnectionId,
        reason: 'lease-expired',
      })
    }
    return true
  }

  async attachDaemonSocket(meta: {
    sessionId: string
    keyId: string
    hostname?: string
    machineId?: string
    remoteAddress?: string
    connectedAt?: string
  }): Promise<{ connectionId: string; lease: DaemonCellLease }> {
    await this.reconcileStalePresence()

    const connectionId = crypto.randomUUID()
    const connectedAt = meta.connectedAt ?? nowIso()
    const leaseK = leaseKey(this.#serverId)

    let acquired = await this.#client.setnx(leaseK, connectionId, LEASE_TTL_MS)
    if (!acquired) {
      const existing = await this.#client.get(leaseK)
      if (existing) {
        throw new Error(
          `daemon socket lease held by another connection (${existing})`,
        )
      }
      acquired = await this.#client.setnx(leaseK, connectionId, LEASE_TTL_MS)
      if (!acquired) {
        throw new Error('daemon socket lease acquisition failed')
      }
    }

    const expiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString()

    await this.#client.hset(metaKey(this.#serverId), {
      connected: '1',
      connectionId,
      sessionId: meta.sessionId,
      keyId: meta.keyId,
      hostname: meta.hostname ?? '',
      machineId: meta.machineId ?? '',
      remoteAddress: meta.remoteAddress ?? '',
      connectedAt,
    })
    await this.#client.sadd(onlineSetKey(), this.#serverId)
    await this.#client.hset(connKey(this.#serverId, connectionId), {
      sessionId: meta.sessionId,
      keyId: meta.keyId,
      connectedAt,
      remoteAddress: meta.remoteAddress ?? '',
    })

    const outbox = outboxKey(this.#serverId)
    await this.#client.xgroupCreate(outbox, OUTBOX_GROUP, '$', true)

    const consumer = `ws:${connectionId}`
    const reclaimed = await this.#client.xautoclaim(
      outbox,
      OUTBOX_GROUP,
      consumer,
      60_000,
      '0-0',
      100,
    )
    if (reclaimed.length > 0) {
      this.#reclaimedByConsumer.set(consumer, reclaimed)
      this.#rememberOutboxEntries(reclaimed)
    }

    await this.appendEvent('connected', { connectionId })

    return {
      connectionId,
      lease: {
        holder: connectionId,
        token: connectionId,
        expiresAt,
      },
    }
  }

  async detachDaemonSocket(params: {
    connectionId: string
    leaseToken: string
    reason?: string
    closedAt?: string
  }): Promise<void> {
    const released = await this.#client.eval(
      COMPARE_AND_DELETE,
      1,
      leaseKey(this.#serverId),
      params.leaseToken,
    )
    if (!isLeaseOpSuccess(released)) return

    const meta = await this.#client.hgetall(metaKey(this.#serverId))
    if (meta?.connectionId === params.connectionId) {
      await this.#client.hset(metaKey(this.#serverId), { connected: '0' })
      await this.#client.srem(onlineSetKey(), this.#serverId)
    }

    const closedAt = params.closedAt ?? nowIso()
    await this.#client.hset(connKey(this.#serverId, params.connectionId), {
      closedAt,
      reason: params.reason ?? '',
    })
    await this.#client.expire(connKey(this.#serverId, params.connectionId), 86_400)

    this.#reclaimedByConsumer.delete(`ws:${params.connectionId}`)

    await this.appendEvent('disconnected', {
      connectionId: params.connectionId,
      reason: params.reason ?? '',
    })
  }

  async heartbeat(params: {
    connectionId?: string
    hostname?: string
    at?: string
  }): Promise<void> {
    const meta = await this.#client.hgetall(metaKey(this.#serverId))
    const connectionId = params.connectionId ?? meta?.connectionId
    if (!connectionId) return

    const renewed = await this.#renewDaemonSocketLease(connectionId)
    if (!renewed) return

    const fields: Record<string, string> = {
      lastHeartbeatAt: params.at ?? nowIso(),
    }
    if (params.hostname) fields.hostname = params.hostname
    await this.#client.hset(metaKey(this.#serverId), fields)
    await this.#client.sadd(onlineSetKey(), this.#serverId)
  }

  async getSnapshot(): Promise<DaemonCellSnapshot> {
    const raw = await this.#client.get(snapshotKey(this.#serverId))
    const fromJson = parseSnapshot(raw, this.#serverId)
    const meta = await this.#client.hgetall(metaKey(this.#serverId))
    const fromMeta = meta ? snapshotFromMeta(this.#serverId, meta) : null

    if (fromJson && fromMeta) {
      return mergeSnapshotPresence(fromJson, fromMeta)
    }
    if (fromJson) return fromJson
    if (fromMeta) return fromMeta

    return {
      serverId: this.#serverId,
      version: 0,
      updatedAt: nowIso(),
      connected: false,
    }
  }

  async putSnapshot(patch: Partial<DaemonCellSnapshot>): Promise<DaemonCellSnapshot> {
    const current = await this.getSnapshot()
    const updated: DaemonCellSnapshot = {
      ...current,
      ...patch,
      serverId: this.#serverId,
      version: current.version + 1,
      updatedAt: nowIso(),
    }
    await this.#client.set(snapshotKey(this.#serverId), JSON.stringify(updated))
    await this.#client.hset(metaKey(this.#serverId), {
      snapshotVersion: String(updated.version),
      updatedAt: updated.updatedAt,
    })
    return updated
  }

  async appendEvent(
    kind: string,
    payload: Record<string, unknown>,
    ttlSeconds?: number,
  ): Promise<void> {
    const at = nowIso()
    const key = eventsKey(this.#serverId)
    await this.#client.xadd(key, '*', {
      kind,
      at,
      payload: JSON.stringify(payload),
    }, 500)
    if (ttlSeconds != null) {
      await this.#client.expire(key, ttlSeconds, 'GT')
    }
  }

  async listEvents(limit = 50): Promise<Array<{
    seq: string
    kind: string
    at: string
    payload: Record<string, unknown>
  }>> {
    const entries = await this.#client.xrange(
      eventsKey(this.#serverId),
      '-',
      '+',
      limit,
    )
    return entries.map((entry) => {
      let payload: Record<string, unknown> = {}
      if (entry.fields.payload) {
        try {
          payload = JSON.parse(entry.fields.payload) as Record<string, unknown>
        } catch {
          payload = {}
        }
      }
      return {
        seq: entry.id,
        kind: entry.fields.kind ?? '',
        at: entry.fields.at ?? '',
        payload,
      }
    })
  }

  async enqueue(
    outbound: DaemonOutboundEnvelope,
    opts?: { ttlSeconds?: number },
  ): Promise<PendingRequestRecord> {
    const now = Date.now()
    const createdAt = outbound.at ?? nowIso(now)
    const ttlSeconds = opts?.ttlSeconds ?? 300
    const expiresAt = nowIso(now + ttlSeconds * 1000)
    const reqKey = requestKey(this.#serverId, outbound.requestId)
    const indexKey = requestsKey(this.#serverId)

    const existingFields = await this.#client.hgetall(reqKey)
    if (existingFields) {
      const deliveries = parseDeliveryMap(existingFields.deliveries)
      if (deliveries[outbound.deliveryId]) {
        return parseRequestRecord(
          this.#serverId,
          outbound.requestId,
          existingFields,
        )
      }

      const streamId = await this.#client.xadd(outboxKey(this.#serverId), '*', {
        deliveryId: outbound.deliveryId,
        requestId: outbound.requestId,
        kind: outbound.kind,
        payload: JSON.stringify(outbound),
        enqueuedAt: createdAt,
      })
      deliveries[outbound.deliveryId] = streamId
      await this.#client.hset(reqKey, {
        deliveries: JSON.stringify(deliveries),
      })
      this.#deliveryToStreamId.set(outbound.deliveryId, streamId)

      return parseRequestRecord(
        this.#serverId,
        outbound.requestId,
        {
          ...existingFields,
          deliveries: JSON.stringify(deliveries),
        },
      )
    }

    const streamId = await this.#client.xadd(outboxKey(this.#serverId), '*', {
      deliveryId: outbound.deliveryId,
      requestId: outbound.requestId,
      kind: outbound.kind,
      payload: JSON.stringify(outbound),
      enqueuedAt: createdAt,
    })
    const deliveries = { [outbound.deliveryId]: streamId }
    const recordFields: Record<string, string> = {
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: 'queued',
      createdAt,
      expiresAt,
      deliveries: JSON.stringify(deliveries),
    }
    if (outbound.kind === 'command') {
      recordFields.command = outbound.command
    }

    await this.#client.hset(reqKey, recordFields)
    await this.#client.expire(reqKey, ttlSeconds)
    await this.#client.zadd(indexKey, now, outbound.requestId)
    this.#deliveryToStreamId.set(outbound.deliveryId, streamId)

    return parseRequestRecord(this.#serverId, outbound.requestId, recordFields)
  }

  async markSent(
    deliveryId: OutboxDeliveryId,
    _connectionId: string,
    sentAt?: string,
  ): Promise<void> {
    const requestIds = await this.#client.zrangebyscore(
      requestsKey(this.#serverId),
      '-inf',
      '+inf',
    )
    for (const requestId of requestIds) {
      const fields = await this.#client.hgetall(
        requestKey(this.#serverId, requestId),
      )
      if (!fields) continue
      const deliveries = parseDeliveryMap(fields.deliveries)
      if (!deliveries[deliveryId]) continue

      await this.#client.hset(requestKey(this.#serverId, requestId), {
        status: 'sent',
        sentAt: sentAt ?? nowIso(),
      })
      return
    }
  }

  async handleInbound(
    inbound: DaemonInboundEnvelope,
  ): Promise<PendingRequestRecord | null> {
    const reqKey = requestKey(this.#serverId, inbound.requestId)
    const fields = await this.#client.hgetall(reqKey)
    if (!fields) return null

    const existing = parseRequestRecord(this.#serverId, inbound.requestId, fields)
    if (isTerminalStatus(existing.status)) return existing

    let status: PendingRequestStatus
    let result: unknown
    let error: string | undefined

    switch (inbound.kind) {
      case 'pong':
        status = 'acked'
        break
      case 'command-result':
        status = 'done'
        result = {
          exitCode: inbound.exitCode,
          stdout: inbound.stdout,
          stderr: inbound.stderr,
        }
        break
      case 'addresses-result':
        status = 'done'
        result = { addresses: inbound.addresses }
        await this.putSnapshot({
          addresses: inbound.addresses,
          lastInboundAt: inbound.at,
        })
        break
      case 'dev-sync-result':
      case 'tunnel-token-result':
      case 'update-result':
        status = inbound.ok ? 'done' : 'failed'
        result = { ok: inbound.ok, error: inbound.error }
        if (!inbound.ok) error = inbound.error
        break
      default:
        return existing
    }

    const updates: Record<string, string> = {
      status,
      finishedAt: inbound.at,
    }
    if (result !== undefined) updates.result = JSON.stringify(result)
    if (error) updates.error = error

    await this.#client.hset(reqKey, updates)
    await this.appendEvent('inbound', {
      kind: inbound.kind,
      requestId: inbound.requestId,
    })

    if (inbound.kind !== 'addresses-result') {
      await this.#client.hset(metaKey(this.#serverId), {
        lastInboundAt: inbound.at,
      })
    }

    return parseRequestRecord(
      this.#serverId,
      inbound.requestId,
      { ...fields, ...updates },
    )
  }

  async getRequest(requestId: string): Promise<PendingRequestRecord | null> {
    const fields = await this.#client.hgetall(
      requestKey(this.#serverId, requestId),
    )
    if (!fields) return null
    return parseRequestRecord(this.#serverId, requestId, fields)
  }

  async listRequests(
    limit = 50,
    filter?: { requestKind?: string },
  ): Promise<PendingRequestRecord[]> {
    const requestIds = await this.#client.zrangebyscore(
      requestsKey(this.#serverId),
      '-inf',
      '+inf',
    )
    const records: PendingRequestRecord[] = []
    for (let i = requestIds.length - 1; i >= 0; i--) {
      const requestId = requestIds[i]!
      const fields = await this.#client.hgetall(
        requestKey(this.#serverId, requestId),
      )
      if (!fields) continue
      const record = parseRequestRecord(this.#serverId, requestId, fields)
      if (filter?.requestKind && record.requestKind !== filter.requestKind) {
        continue
      }
      records.push(record)
      if (records.length >= limit) break
    }
    return records
  }

  async waitForRequest(
    requestId: string,
    timeoutMs: number,
  ): Promise<PendingRequestRecord | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const record = await this.getRequest(requestId)
      if (record && isTerminalStatus(record.status)) return record
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    return null
  }

  async createRequestAndWait(
    outbound: DaemonOutboundEnvelope,
    timeoutMs: number,
  ): Promise<PendingRequestRecord> {
    await this.enqueue(outbound)
    const result = await this.waitForRequest(outbound.requestId, timeoutMs)
    if (result) return result

    const expiredAt = nowIso()
    const reqKey = requestKey(this.#serverId, outbound.requestId)
    await this.#client.hset(reqKey, {
      status: 'expired',
      finishedAt: expiredAt,
    })
    return {
      serverId: this.#serverId,
      requestId: outbound.requestId,
      requestKind: outbound.kind,
      status: 'expired',
      createdAt: outbound.at,
      expiresAt: expiredAt,
      finishedAt: expiredAt,
    }
  }

  async claimDeliveryLease(
    holder: string,
    ttlMs: number,
  ): Promise<DaemonCellLease | null> {
    const key = leaseKey(this.#serverId)
    const acquired = await this.#client.setnx(key, holder, ttlMs)
    if (!acquired) return null
    return {
      holder,
      token: holder,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    }
  }

  async renewDeliveryLease(
    holder: string,
    token: string,
    ttlMs: number,
  ): Promise<DaemonCellLease | null> {
    const key = leaseKey(this.#serverId)
    const renewed = await this.#client.eval(
      COMPARE_AND_RENEW,
      1,
      key,
      token,
      holder,
      ttlMs,
    )
    if (renewed !== 'OK' && renewed !== 1) return null
    return {
      holder,
      token: holder,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    }
  }

  async releaseDeliveryLease(holder: string, token: string): Promise<void> {
    await this.#client.eval(
      COMPARE_AND_DELETE,
      1,
      leaseKey(this.#serverId),
      token,
    )
  }

  async readOutboxBatch(params: {
    consumer: string
    count: number
    blockMs?: number
  }): Promise<DaemonOutboundEnvelope[]> {
    const envelopes: DaemonOutboundEnvelope[] = []
    let remaining = params.count

    const reclaimed = this.#reclaimedByConsumer.get(params.consumer) ?? []
    if (reclaimed.length > 0 && remaining > 0) {
      const batch = reclaimed.splice(0, remaining)
      this.#reclaimedByConsumer.set(params.consumer, reclaimed)
      envelopes.push(...this.#entriesToEnvelopes(batch))
      remaining = params.count - envelopes.length
    }

    if (remaining > 0) {
      const pending = await this.#client.xreadgroup(
        OUTBOX_GROUP,
        params.consumer,
        outboxKey(this.#serverId),
        remaining,
        undefined,
        '0',
      )
      if (pending.length > 0) {
        envelopes.push(...this.#entriesToEnvelopes(pending))
        remaining = params.count - envelopes.length
      }
    }

    if (remaining > 0) {
      const fresh = await this.#client.xreadgroup(
        OUTBOX_GROUP,
        params.consumer,
        outboxKey(this.#serverId),
        remaining,
        params.blockMs,
        '>',
      )
      envelopes.push(...this.#entriesToEnvelopes(fresh))
    }

    return envelopes
  }

  async ackOutbox(
    deliveryIds: OutboxDeliveryId[],
    _consumer: string,
  ): Promise<void> {
    const streamIds: string[] = []
    for (const deliveryId of deliveryIds) {
      const streamId = await this.#resolveStreamIdForDelivery(deliveryId)
      if (streamId) streamIds.push(streamId)
    }
    if (streamIds.length > 0) {
      await this.#client.xack(outboxKey(this.#serverId), OUTBOX_GROUP, ...streamIds)
      for (const deliveryId of deliveryIds) {
        this.#deliveryToStreamId.delete(deliveryId)
      }
    }
  }

  async prune(now = Date.now()): Promise<void> {
    await this.reconcileStalePresence(now)
    await this.#client.xtrimMaxLen(eventsKey(this.#serverId), 500)
    await this.#client.xtrimMaxLen(outboxKey(this.#serverId), 1000)

    const indexKey = requestsKey(this.#serverId)
    const requestIds = await this.#client.zrangebyscore(indexKey, '-inf', '+inf')
    for (const requestId of requestIds) {
      const fields = await this.#client.hgetall(
        requestKey(this.#serverId, requestId),
      )
      if (!fields) {
        await this.#client.zrem(indexKey, requestId)
        continue
      }
      const expiresAtMs = Date.parse(fields.expiresAt ?? '')
      if (!Number.isNaN(expiresAtMs) && expiresAtMs <= now) {
        await this.#client.del(requestKey(this.#serverId, requestId))
        await this.#client.zrem(indexKey, requestId)
      }
    }
  }
}
