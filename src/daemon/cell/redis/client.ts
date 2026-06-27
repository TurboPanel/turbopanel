/** Deno-only — uses ioredis and Deno.env; not imported by the Workers bundle. */
import { Redis } from "ioredis";

export type RedisClientOptions = {
  socketPath?: string;
};

export type StreamEntry = {
  id: string;
  fields: Record<string, string>;
};

const DEFAULT_SOCKET_PATH = "/run/turbopanel/redis.sock";

function resolveSocketPath(opts?: RedisClientOptions): string {
  return opts?.socketPath ??
    Deno.env.get("TURBOPANEL_REDIS_SOCKET") ??
    DEFAULT_SOCKET_PATH;
}

function attachErrorLogging(redis: Redis, label: string): void {
  redis.on("error", (err: Error) => {
    console.error(`[redis:${label}]`, err.message);
  });
}

function parseStreamEntries(raw: unknown): StreamEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const entries: StreamEntry[] = [];
  for (const streamBlock of raw) {
    if (!Array.isArray(streamBlock) || streamBlock.length < 2) continue;
    const messages = streamBlock[1];
    if (!Array.isArray(messages)) continue;

    for (const message of messages) {
      if (!Array.isArray(message) || message.length < 2) continue;
      const id = String(message[0]);
      const fieldList = message[1];
      const fields: Record<string, string> = {};
      if (Array.isArray(fieldList)) {
        for (let i = 0; i < fieldList.length; i += 2) {
          fields[String(fieldList[i])] = String(fieldList[i + 1] ?? "");
        }
      }
      entries.push({ id, fields });
    }
  }
  return entries;
}

function parseAutoClaimEntries(raw: unknown): StreamEntry[] {
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const messages = raw[1];
  if (!Array.isArray(messages)) return [];

  const entries: StreamEntry[] = [];
  for (const message of messages) {
    if (!Array.isArray(message) || message.length < 2) continue;
    const id = String(message[0]);
    const fieldList = message[1];
    const fields: Record<string, string> = {};
    if (Array.isArray(fieldList)) {
      for (let i = 0; i < fieldList.length; i += 2) {
        fields[String(fieldList[i])] = String(fieldList[i + 1] ?? "");
      }
    }
    entries.push({ id, fields });
  }
  return entries;
}

export class RedisCellClient {
  readonly #cmd: Redis;
  readonly #block: Redis;
  readonly #maint: Redis;

  constructor(opts?: RedisClientOptions) {
    const path = resolveSocketPath(opts);
    const options = { path, maxRetriesPerRequest: null as number | null };

    this.#cmd = new Redis(options);
    this.#block = new Redis(options);
    this.#maint = new Redis(options);

    attachErrorLogging(this.#cmd, "cmd");
    attachErrorLogging(this.#block, "block");
    attachErrorLogging(this.#maint, "maint");
  }

  async hset(key: string, fields: Record<string, string>): Promise<void> {
    if (Object.keys(fields).length === 0) return;
    await this.#cmd.hset(key, fields);
  }

  async hgetall(key: string): Promise<Record<string, string> | null> {
    const result = await this.#cmd.hgetall(key);
    if (!result || Object.keys(result).length === 0) return null;
    return result;
  }

  async set(key: string, value: string, pxMs?: number): Promise<void> {
    if (pxMs != null && pxMs > 0) {
      await this.#cmd.set(key, value, "PX", pxMs);
    } else {
      await this.#cmd.set(key, value);
    }
  }

  async setnx(key: string, value: string, pxMs: number): Promise<boolean> {
    const result = await this.#cmd.set(key, value, "PX", pxMs, "NX");
    return result === "OK";
  }

  async setnxPersistent(key: string, value: string): Promise<boolean> {
    const result = await this.#cmd.set(key, value, "NX");
    return result === "OK";
  }

  async get(key: string): Promise<string | null> {
    const result = await this.#cmd.get(key);
    return result ?? null;
  }

  async pttl(key: string): Promise<number> {
    return await this.#cmd.pttl(key);
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return await this.#cmd.del(...keys);
  }

  async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [nextCursor, batch] = await this.#cmd.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        100,
      );
      cursor = nextCursor;
      if (Array.isArray(batch) && batch.length > 0) {
        keys.push(...batch.map(String));
      }
    } while (cursor !== "0");
    return keys;
  }

  async deleteByPattern(pattern: string): Promise<number> {
    const keys = await this.scanKeys(pattern);
    if (keys.length === 0) return 0;
    return await this.del(...keys);
  }

  async expire(
    key: string,
    seconds: number,
    mode?: "GT",
  ): Promise<boolean> {
    if (mode === "GT") {
      const result = await this.#cmd.expire(key, seconds, "GT");
      return result === 1;
    }
    const result = await this.#cmd.expire(key, seconds);
    return result === 1;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return await this.#cmd.sadd(key, ...members);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return await this.#cmd.srem(key, ...members);
  }

  async smembers(key: string): Promise<string[]> {
    return await this.#cmd.smembers(key);
  }

  async xadd(
    key: string,
    id: string,
    fields: Record<string, string>,
    maxlen?: number,
  ): Promise<string> {
    const args: (string | number)[] = [];
    if (maxlen != null) {
      args.push("MAXLEN", "~", maxlen);
    }
    args.push(id);
    for (const [field, value] of Object.entries(fields)) {
      args.push(field, value);
    }
    const result = await this.#cmd.xadd(
      key,
      ...(args as [string | number, ...(string | number)[]]),
    );
    return result ?? "";
  }

  async xreadgroup(
    group: string,
    consumer: string,
    streamKey: string,
    count: number,
    blockMs?: number,
    streamId: ">" | "0" = ">",
  ): Promise<StreamEntry[]> {
    const cmdArgs: string[] = [
      "GROUP",
      group,
      consumer,
      "COUNT",
      String(count),
    ];
    if (blockMs != null && blockMs > 0) {
      cmdArgs.push("BLOCK", String(blockMs));
    }
    cmdArgs.push("STREAMS", streamKey, streamId);
    const raw = await this.#block.call("XREADGROUP", ...cmdArgs);
    return parseStreamEntries(raw);
  }

  async xack(key: string, group: string, ...ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return await this.#cmd.xack(key, group, ...ids);
  }

  async xdel(key: string, ...ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    return await this.#cmd.xdel(key, ...ids);
  }

  async xautoclaim(
    key: string,
    group: string,
    consumer: string,
    minIdleMs: number,
    startId: string,
    count: number,
  ): Promise<StreamEntry[]> {
    const raw = await this.#maint.xautoclaim(
      key,
      group,
      consumer,
      minIdleMs,
      startId,
      "COUNT",
      count,
    );
    return parseAutoClaimEntries(raw);
  }

  async xrange(
    key: string,
    start: string,
    end: string,
    count?: number,
  ): Promise<StreamEntry[]> {
    const raw = count != null
      ? await this.#cmd.xrange(key, start, end, "COUNT", count)
      : await this.#cmd.xrange(key, start, end);

    if (!Array.isArray(raw)) return [];
    const entries: StreamEntry[] = [];
    for (const message of raw) {
      if (!Array.isArray(message) || message.length < 2) continue;
      const id = String(message[0]);
      const fieldList = message[1];
      const fields: Record<string, string> = {};
      if (Array.isArray(fieldList)) {
        for (let i = 0; i < fieldList.length; i += 2) {
          fields[String(fieldList[i])] = String(fieldList[i + 1] ?? "");
        }
      }
      entries.push({ id, fields });
    }
    return entries;
  }

  async xrevrange(
    key: string,
    end: string,
    start: string,
    count?: number,
  ): Promise<StreamEntry[]> {
    const raw = count != null
      ? await this.#cmd.xrevrange(key, end, start, "COUNT", count)
      : await this.#cmd.xrevrange(key, end, start);

    if (!Array.isArray(raw)) return [];
    const entries: StreamEntry[] = [];
    for (const message of raw) {
      if (!Array.isArray(message) || message.length < 2) continue;
      const id = String(message[0]);
      const fieldList = message[1];
      const fields: Record<string, string> = {};
      if (Array.isArray(fieldList)) {
        for (let i = 0; i < fieldList.length; i += 2) {
          fields[String(fieldList[i])] = String(fieldList[i + 1] ?? "");
        }
      }
      entries.push({ id, fields });
    }
    return entries;
  }

  async xlen(key: string): Promise<number> {
    return await this.#cmd.xlen(key);
  }

  async xtrimMaxLen(key: string, maxlen: number): Promise<number> {
    return await this.#cmd.xtrim(key, "MAXLEN", "~", maxlen);
  }

  async xgroupCreate(
    key: string,
    group: string,
    startId: string,
    mkstream = true,
  ): Promise<void> {
    try {
      const cmdArgs = ["CREATE", key, group, startId];
      if (mkstream) cmdArgs.push("MKSTREAM");
      await this.#cmd.call("XGROUP", ...cmdArgs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("BUSYGROUP")) throw err;
    }
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    return await this.#cmd.zadd(key, score, member);
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    if (members.length === 0) return 0;
    return await this.#cmd.zrem(key, ...members);
  }

  async zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
  ): Promise<string[]> {
    return await this.#cmd.zrangebyscore(key, min, max);
  }

  async zcard(key: string): Promise<number> {
    return await this.#cmd.zcard(key);
  }

  async eval(
    script: string,
    numkeys: number,
    ...args: (string | number)[]
  ): Promise<unknown> {
    return await this.#cmd.eval(script, numkeys, ...args);
  }

  async close(): Promise<void> {
    await Promise.all([
      this.#cmd.quit(),
      this.#block.quit(),
      this.#maint.quit(),
    ]);
  }
}

export function createRedisCellClient(
  opts?: RedisClientOptions,
): RedisCellClient {
  return new RedisCellClient(opts);
}
