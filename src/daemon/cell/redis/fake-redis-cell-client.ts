/**
 * Host-free in-memory {@link RedisCellClient} for Deno unit tests.
 * Implements the Redis primitives used by {@link RedisDaemonCell} and registry.
 */
import type { StreamEntry } from "./client.ts";
import {
  COMPARE_AND_DELETE,
  COMPARE_AND_RENEW,
  RATE_LIMIT_TOKEN_BUCKET,
  RECONCILE_STALE_SOCKET_PRESENCE,
} from "./lua.ts";

type StringEntry = { value: string; expiresAt?: number };
type StreamGroupState = {
  lastDeliveredId: string;
  pending: Map<string, { consumer: string; idleSince: number }>;
};
type StreamState = {
  entries: StreamEntry[];
  groups: Map<string, StreamGroupState>;
};

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
  const regexBody = escaped.replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${regexBody}$`);
}

function nowMs(): number {
  return Date.now();
}

function isExpired(entry: StringEntry | undefined, at = nowMs()): boolean {
  return entry?.expiresAt != null && entry.expiresAt <= at;
}

function streamIdSeq(a: string, b: string): number {
  const [aMs, aSeq] = a.split("-").map(Number);
  const [bMs, bSeq] = b.split("-").map(Number);
  if (aMs !== bMs) return aMs - bMs;
  return (aSeq ?? 0) - (bSeq ?? 0);
}

export class FakeRedisCellClient {
  readonly #strings = new Map<string, StringEntry>();
  readonly #hashes = new Map<string, Map<string, string>>();
  readonly #sets = new Map<string, Set<string>>();
  readonly #zsets = new Map<string, Map<string, number>>();
  readonly #streams = new Map<string, StreamState>();
  readonly #streamSeq = new Map<string, number>();
  #closed = false;

  async hset(key: string, fields: Record<string, string>): Promise<void> {
    if (Object.keys(fields).length === 0) return;
    let hash = this.#hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.#hashes.set(key, hash);
    }
    for (const [field, value] of Object.entries(fields)) {
      hash.set(field, value);
    }
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    const hash = this.#hashes.get(key);
    if (!hash || hash.size === 0) return null;
    return Object.fromEntries(hash.entries());
  }

  async set(key: string, value: string, pxMs?: number): Promise<void> {
    const expiresAt = pxMs != null && pxMs > 0 ? nowMs() + pxMs : undefined;
    this.#strings.set(key, { value, expiresAt });
  }

  async setnx(key: string, value: string, pxMs: number): Promise<boolean> {
    const existing = this.#strings.get(key);
    if (existing && !isExpired(existing)) return false;
    await this.set(key, value, pxMs);
    return true;
  }

  async setnxPersistent(key: string, value: string): Promise<boolean> {
    const existing = this.#strings.get(key);
    if (existing && !isExpired(existing)) return false;
    this.#strings.set(key, { value });
    return true;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.#strings.get(key);
    if (!entry || isExpired(entry)) {
      if (entry) this.#strings.delete(key);
      return null;
    }
    return entry.value;
  }

  async pttl(key: string): Promise<number> {
    const entry = this.#strings.get(key);
    if (!entry) return -2;
    if (entry.expiresAt == null) return -1;
    const remaining = entry.expiresAt - nowMs();
    return remaining > 0 ? remaining : -2;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (
        this.#strings.delete(key) ||
        this.#hashes.delete(key) ||
        this.#sets.delete(key) ||
        this.#zsets.delete(key) ||
        this.#streams.delete(key)
      ) {
        removed += 1;
      }
    }
    return removed;
  }

  async scanKeys(pattern: string): Promise<string[]> {
    const re = globToRegExp(pattern);
    const keys = new Set<string>();
    for (const key of this.#strings.keys()) {
      if (re.test(key)) keys.add(key);
    }
    for (const key of this.#hashes.keys()) {
      if (re.test(key)) keys.add(key);
    }
    for (const key of this.#sets.keys()) {
      if (re.test(key)) keys.add(key);
    }
    for (const key of this.#zsets.keys()) {
      if (re.test(key)) keys.add(key);
    }
    for (const key of this.#streams.keys()) {
      if (re.test(key)) keys.add(key);
    }
    return [...keys].sort((a, b) => a.localeCompare(b));
  }

  async deleteByPattern(pattern: string): Promise<number> {
    const keys = await this.scanKeys(pattern);
    if (keys.length === 0) return 0;
    return await this.del(...keys);
  }

  async expire(key: string, seconds: number, mode?: "GT"): Promise<boolean> {
    const entry = this.#strings.get(key);
    if (!entry) return false;
    const newExpiresAt = nowMs() + seconds * 1000;
    if (mode === "GT" && entry.expiresAt != null && newExpiresAt <= entry.expiresAt) {
      return false;
    }
    entry.expiresAt = newExpiresAt;
    return true;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    let set = this.#sets.get(key);
    if (!set) {
      set = new Set();
      this.#sets.set(key, set);
    }
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member);
        added += 1;
      }
    }
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.#sets.get(key);
    if (!set || members.length === 0) return 0;
    let removed = 0;
    for (const member of members) {
      if (set.delete(member)) removed += 1;
    }
    if (set.size === 0) this.#sets.delete(key);
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    const set = this.#sets.get(key);
    if (!set) return [];
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  #streamState(key: string): StreamState {
    let state = this.#streams.get(key);
    if (!state) {
      state = { entries: [], groups: new Map() };
      this.#streams.set(key, state);
    }
    return state;
  }

  async xadd(
    key: string,
    id: string,
    fields: Record<string, string>,
    _maxlen?: number,
  ): Promise<string> {
    const state = this.#streamState(key);
    let streamId = id;
    if (id === "*") {
      const seq = (this.#streamSeq.get(key) ?? 0) + 1;
      this.#streamSeq.set(key, seq);
      streamId = `${nowMs()}-${seq}`;
    }
    state.entries.push({ id: streamId, fields: { ...fields } });
    return streamId;
  }

  async xgroupCreate(
    key: string,
    group: string,
    startId: string,
    mkstream = true,
  ): Promise<void> {
    if (mkstream) this.#streamState(key);
    const state = this.#streams.get(key);
    if (!state) throw new Error("ERR no such key");
    if (state.groups.has(group)) {
      if (mkstream) return;
      throw new Error("BUSYGROUP Consumer Group name already exists");
    }
    state.groups.set(group, {
      lastDeliveredId: startId === "$" ? "0-0" : startId,
      pending: new Map(),
    });
  }

  async xreadgroup(
    group: string,
    consumer: string,
    streamKey: string,
    count: number,
    _blockMs?: number,
    streamId: ">" | "0" = ">",
  ): Promise<StreamEntry[]> {
    const state = this.#streams.get(streamKey);
    if (!state) return [];
    const groupState = state.groups.get(group);
    if (!groupState) return [];

    const results: StreamEntry[] = [];

    if (streamId === "0") {
      for (const [entryId, pending] of groupState.pending.entries()) {
        if (pending.consumer !== consumer) continue;
        const entry = state.entries.find((e) => e.id === entryId);
        if (entry) results.push(entry);
        if (results.length >= count) break;
      }
      return results;
    }

    for (const entry of state.entries) {
      if (streamIdSeq(entry.id, groupState.lastDeliveredId) <= 0) continue;
      if (groupState.pending.has(entry.id)) continue;
      groupState.pending.set(entry.id, { consumer, idleSince: nowMs() });
      groupState.lastDeliveredId = entry.id;
      results.push(entry);
      if (results.length >= count) break;
    }
    return results;
  }

  async xack(key: string, group: string, ...ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const state = this.#streams.get(key);
    const groupState = state?.groups.get(group);
    if (!groupState) return 0;
    let acked = 0;
    for (const id of ids) {
      if (groupState.pending.delete(id)) acked += 1;
    }
    return acked;
  }

  async xdel(key: string, ...ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const state = this.#streams.get(key);
    if (!state) return 0;
    const idSet = new Set(ids);
    const before = state.entries.length;
    state.entries = state.entries.filter((e) => !idSet.has(e.id));
    for (const groupState of state.groups.values()) {
      for (const id of ids) {
        groupState.pending.delete(id);
      }
    }
    return before - state.entries.length;
  }

  async xautoclaim(
    key: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    _startId: string,
    count: number,
  ): Promise<StreamEntry[]> {
    const state = this.#streams.get(key);
    const groupState = state?.groups.get(group);
    if (!state || !groupState) return [];
    const reclaimed: StreamEntry[] = [];
    const at = nowMs();
    for (const [entryId, pending] of groupState.pending.entries()) {
      if (at - pending.idleSince < minIdleMs) continue;
      const entry = state.entries.find((e) => e.id === entryId);
      if (!entry) continue;
      groupState.pending.set(entryId, { consumer, idleSince: at });
      reclaimed.push(entry);
      if (reclaimed.length >= count) break;
    }
    return reclaimed;
  }

  async xrange(
    key: string,
    start: string,
    end: string,
    count?: number,
  ): Promise<StreamEntry[]> {
    const state = this.#streams.get(key);
    if (!state) return [];
    let entries = state.entries.filter((e) => {
      if (start !== "-" && streamIdSeq(e.id, start) < 0) return false;
      if (end !== "+" && streamIdSeq(e.id, end) > 0) return false;
      return true;
    });
    if (count != null) entries = entries.slice(0, count);
    return entries;
  }

  async xrevrange(
    key: string,
    end: string,
    start: string,
    count?: number,
  ): Promise<StreamEntry[]> {
    const forward = await this.xrange(key, start, end);
    forward.reverse();
    if (count != null) return forward.slice(0, count);
    return forward;
  }

  async xlen(key: string): Promise<number> {
    return this.#streams.get(key)?.entries.length ?? 0;
  }

  async xtrimMaxLen(key: string, maxlen: number): Promise<number> {
    const state = this.#streams.get(key);
    if (!state) return 0;
    const overflow = state.entries.length - maxlen;
    if (overflow <= 0) return 0;
    state.entries.splice(0, overflow);
    return overflow;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    let zset = this.#zsets.get(key);
    if (!zset) {
      zset = new Map();
      this.#zsets.set(key, zset);
    }
    const isNew = !zset.has(member);
    zset.set(member, score);
    return isNew ? 1 : 0;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    const zset = this.#zsets.get(key);
    if (!zset || members.length === 0) return 0;
    let removed = 0;
    for (const member of members) {
      if (zset.delete(member)) removed += 1;
    }
    if (zset.size === 0) this.#zsets.delete(key);
    return removed;
  }

  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<string[]> {
    const zset = this.#zsets.get(key);
    if (!zset) return [];
    const minScore = min === "-inf" ? Number.NEGATIVE_INFINITY : Number(min);
    const maxScore = max === "+inf" ? Number.POSITIVE_INFINITY : Number(max);
    return [...zset.entries()]
      .filter(([, score]) => score >= minScore && score <= maxScore)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([member]) => member);
  }

  async zcard(key: string): Promise<number> {
    return this.#zsets.get(key)?.size ?? 0;
  }

  async eval(
    script: string,
    numkeys: number,
    ...args: (string | number)[]
  ): Promise<unknown> {
    const keys = args.slice(0, numkeys).map(String);
    const argv = args.slice(numkeys).map(String);

    if (script === COMPARE_AND_DELETE) {
      const current = await this.get(keys[0]!);
      if (current === argv[0]) {
        await this.del(keys[0]!);
        return 1;
      }
      return 0;
    }

    if (script === COMPARE_AND_RENEW) {
      const current = await this.get(keys[0]!);
      if (current === argv[0]) {
        await this.set(keys[0]!, argv[1]!, Number(argv[2]));
        return "OK";
      }
      return 0;
    }

    if (script === RECONCILE_STALE_SOCKET_PRESENCE) {
      return this.#reconcileStaleSocketPresence(keys, argv);
    }

    if (script === RATE_LIMIT_TOKEN_BUCKET) {
      return this.#rateLimitTokenBucket(keys[0]!, argv);
    }

    throw new Error(`FakeRedisCellClient: unsupported eval script`);
  }

  async #reconcileStaleSocketPresence(
    keys: string[],
    argv: string[],
  ): Promise<number | [number, string]> {
    const [leaseKey, metaKey, onlineKey] = keys;
    const [serverId, closedAt, reason, staleBeforeIso] = argv;
    const meta = await this.hgetall(metaKey!);
    const connected = meta?.connected;
    let wasOnline = 0;

    if (connected !== "1") {
      wasOnline = await this.srem(onlineKey!, serverId!);
      if (wasOnline === 0) return 0;
    }

    const leaseHeld = await this.get(leaseKey!);
    if (leaseHeld) {
      let lastInbound = meta?.lastInboundAt;
      if (!lastInbound) lastInbound = meta?.lastSeenAt;
      if (!lastInbound) lastInbound = meta?.connectedAt;
      if (lastInbound && lastInbound > staleBeforeIso!) return 0;
    }

    const connectionId = meta?.connectionId ?? "";

    if (connected === "1") {
      await this.hset(metaKey!, { connected: "0" });
      await this.srem(onlineKey!, serverId!);
      if (connectionId !== "") {
        const connKey = `tp:cell:${serverId}:conn:${connectionId}`;
        await this.hset(connKey, { closedAt: closedAt!, reason: reason! });
        await this.expire(connKey, 86_400);
      }
    } else if (wasOnline === 1) {
      await this.srem(onlineKey!, serverId!);
    }

    if (connectionId !== "") return [1, connectionId];
    return 1;
  }

  async #rateLimitTokenBucket(key: string, argv: string[]): Promise<number> {
    const capacity = Number(argv[0]);
    const msPerToken = Number(argv[1]);
    const now = Number(argv[2]);
    const ttlMs = Number(argv[3]);

    const hash = await this.hgetall(key);
    let tokens = hash?.tokens != null ? Number(hash.tokens) : capacity;
    let ts = hash?.ts != null ? Number(hash.ts) : now;

    if (hash == null) {
      tokens = capacity;
      ts = now;
    } else {
      const elapsed = now - ts;
      if (elapsed > 0) {
        tokens = Math.min(capacity, tokens + elapsed / msPerToken);
        ts = now;
      }
    }

    let allowed = 0;
    if (tokens >= 1) {
      tokens -= 1;
      allowed = 1;
    }

    await this.hset(key, {
      tokens: String(tokens),
      ts: String(ts),
    });
    await this.set(key, "", ttlMs);
    return allowed;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#strings.clear();
    this.#hashes.clear();
    this.#sets.clear();
    this.#zsets.clear();
    this.#streams.clear();
    this.#streamSeq.clear();
  }

  /**
   * Test helper: backdate a stream PEL entry so {@link xautoclaim} can reclaim it.
   */
  ageStreamPendingIdle(
    streamKey: string,
    group: string,
    entryId: string,
    idleMs: number,
  ): void {
    const pending = this.#streams.get(streamKey)?.groups.get(group)?.pending
      .get(entryId);
    if (pending) pending.idleSince = nowMs() - idleMs;
  }

  /** Test helper — whether close() was invoked. */
  get closed(): boolean {
    return this.#closed;
  }
}

export function createFakeRedisCellClient(): FakeRedisCellClient {
  return new FakeRedisCellClient();
}
