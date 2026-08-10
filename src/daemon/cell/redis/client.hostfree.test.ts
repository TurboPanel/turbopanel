/**
 * Host-free coverage for Redis stream parse helpers, socket path resolution,
 * and RedisCellClient method wiring (via an injectable redisFactory).
 */

import { assertEquals, assertRejects } from 'jsr:@std/assert'
import type { Redis } from 'ioredis'
import {
  createRedisCellClient,
  parseAutoClaimEntries,
  parseMessageList,
  parseStreamEntries,
  parseStreamFields,
  parseStreamMessage,
  RedisCellClient,
  resolveSocketPath,
  type RedisConnectionOptions,
} from './client.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('resolveSocketPath prefers explicit opts then env then default', () => {
  assertEquals(
    resolveSocketPath({ socketPath: '/tmp/custom.sock' }),
    '/tmp/custom.sock',
  )
  const previous = Deno.env.get('TURBOPANEL_REDIS_SOCKET')
  try {
    Deno.env.set('TURBOPANEL_REDIS_SOCKET', '/tmp/env.sock')
    assertEquals(resolveSocketPath(), '/tmp/env.sock')
    Deno.env.delete('TURBOPANEL_REDIS_SOCKET')
    assertEquals(resolveSocketPath(), '/run/turbopanel/redis.sock')
  } finally {
    if (previous === undefined) {
      Deno.env.delete('TURBOPANEL_REDIS_SOCKET')
    } else {
      Deno.env.set('TURBOPANEL_REDIS_SOCKET', previous)
    }
  }
})

test('parseStreamFields pairs Redis flat field lists', () => {
  assertEquals(parseStreamFields(null), {})
  assertEquals(parseStreamFields('nope'), {})
  assertEquals(parseStreamFields(['a', '1', 'b', '2']), { a: '1', b: '2' })
  assertEquals(parseStreamFields(['solo']), { solo: '' })
})

test('parseStreamMessage requires an id + fields array', () => {
  assertEquals(parseStreamMessage(null), null)
  assertEquals(parseStreamMessage(['only-id']), null)
  assertEquals(parseStreamMessage(['1-0', ['k', 'v']]), {
    id: '1-0',
    fields: { k: 'v' },
  })
})

test('parseMessageList skips malformed entries', () => {
  assertEquals(parseMessageList(null), [])
  assertEquals(
    parseMessageList([['1-0', ['a', 'b']], 'bad', ['2-0', ['c', 'd']]]),
    [
      { id: '1-0', fields: { a: 'b' } },
      { id: '2-0', fields: { c: 'd' } },
    ],
  )
})

test('parseStreamEntries walks XREADGROUP stream blocks', () => {
  assertEquals(parseStreamEntries(null), [])
  assertEquals(parseStreamEntries([]), [])
  assertEquals(parseStreamEntries([['stream', []]]), [])
  assertEquals(
    parseStreamEntries([
      ['tp:cell:s:outbox', [['1-0', ['payload', '{}']], ['bad']]],
      'not-a-block',
      ['other', 'not-messages'],
    ]),
    [{ id: '1-0', fields: { payload: '{}' } }],
  )
})

test('parseAutoClaimEntries reads the claimed-message list', () => {
  assertEquals(parseAutoClaimEntries(null), [])
  assertEquals(parseAutoClaimEntries(['0-0']), [])
  assertEquals(
    parseAutoClaimEntries(['0-0', [['9-0', ['f', '1']]]]),
    [{ id: '9-0', fields: { f: '1' } }],
  )
})

type RecordedCall = { method: string; args: unknown[] }

/**
 * Minimal EventEmitter-backed ioredis stand-in. Records command args so
 * RedisCellClient branch wiring can be asserted without a live Redis socket.
 */
class RecordingRedis {
  readonly calls: RecordedCall[] = []
  readonly path: string
  #errorHandlers: Array<(err: Error) => void> = []
  hgetallResult: Record<string, string> = {}
  setResult: string | null = 'OK'
  getResult: string | null = 'value'
  pttlResult = 1000
  delResult = 1
  scanPages: Array<[string, string[]]> = [['0', []]]
  scanIndex = 0
  expireResult = 1
  saddResult = 1
  sremResult = 1
  smembersResult: string[] = ['a']
  xaddResult: string | null = '1-0'
  callResult: unknown = null
  xackResult = 1
  xdelResult = 1
  xautoclaimResult: unknown = ['0-0', [['2-0', ['k', 'v']]]]
  xrangeResult: unknown = [['3-0', ['x', '1']]]
  xrevrangeResult: unknown = [['4-0', ['y', '2']]]
  xlenResult = 2
  xtrimResult = 1
  zaddResult = 1
  zremResult = 1
  zrangebyscoreResult: string[] = ['m']
  zcardResult = 3
  evalResult: unknown = 'ok'
  quitCalls = 0
  throwOnCall: Error | null = null

  constructor(options: RedisConnectionOptions) {
    this.path = options.path
  }

  on(event: string, handler: (err: Error) => void): this {
    if (event === 'error') this.#errorHandlers.push(handler)
    return this
  }

  emitError(err: Error): void {
    for (const handler of this.#errorHandlers) handler(err)
  }

  #record(method: string, args: unknown[]): void {
    this.calls.push({ method, args })
  }

  async hset(...args: unknown[]): Promise<number> {
    this.#record('hset', args)
    return 1
  }

  async hgetall(...args: unknown[]): Promise<Record<string, string>> {
    this.#record('hgetall', args)
    return this.hgetallResult
  }

  async set(...args: unknown[]): Promise<string | null> {
    this.#record('set', args)
    return this.setResult
  }

  async get(...args: unknown[]): Promise<string | null> {
    this.#record('get', args)
    return this.getResult
  }

  async pttl(...args: unknown[]): Promise<number> {
    this.#record('pttl', args)
    return this.pttlResult
  }

  async del(...args: unknown[]): Promise<number> {
    this.#record('del', args)
    return this.delResult
  }

  async scan(...args: unknown[]): Promise<[string, string[]]> {
    this.#record('scan', args)
    const page = this.scanPages[this.scanIndex] ?? ['0', []]
    this.scanIndex += 1
    return page
  }

  async expire(...args: unknown[]): Promise<number> {
    this.#record('expire', args)
    return this.expireResult
  }

  async sadd(...args: unknown[]): Promise<number> {
    this.#record('sadd', args)
    return this.saddResult
  }

  async srem(...args: unknown[]): Promise<number> {
    this.#record('srem', args)
    return this.sremResult
  }

  async smembers(...args: unknown[]): Promise<string[]> {
    this.#record('smembers', args)
    return this.smembersResult
  }

  async xadd(...args: unknown[]): Promise<string | null> {
    this.#record('xadd', args)
    return this.xaddResult
  }

  async call(...args: unknown[]): Promise<unknown> {
    this.#record('call', args)
    if (this.throwOnCall) throw this.throwOnCall
    return this.callResult
  }

  async xack(...args: unknown[]): Promise<number> {
    this.#record('xack', args)
    return this.xackResult
  }

  async xdel(...args: unknown[]): Promise<number> {
    this.#record('xdel', args)
    return this.xdelResult
  }

  async xautoclaim(...args: unknown[]): Promise<unknown> {
    this.#record('xautoclaim', args)
    return this.xautoclaimResult
  }

  async xrange(...args: unknown[]): Promise<unknown> {
    this.#record('xrange', args)
    return this.xrangeResult
  }

  async xrevrange(...args: unknown[]): Promise<unknown> {
    this.#record('xrevrange', args)
    return this.xrevrangeResult
  }

  async xlen(...args: unknown[]): Promise<number> {
    this.#record('xlen', args)
    return this.xlenResult
  }

  async xtrim(...args: unknown[]): Promise<number> {
    this.#record('xtrim', args)
    return this.xtrimResult
  }

  async zadd(...args: unknown[]): Promise<number> {
    this.#record('zadd', args)
    return this.zaddResult
  }

  async zrem(...args: unknown[]): Promise<number> {
    this.#record('zrem', args)
    return this.zremResult
  }

  async zrangebyscore(...args: unknown[]): Promise<string[]> {
    this.#record('zrangebyscore', args)
    return this.zrangebyscoreResult
  }

  async zcard(...args: unknown[]): Promise<number> {
    this.#record('zcard', args)
    return this.zcardResult
  }

  async eval(...args: unknown[]): Promise<unknown> {
    this.#record('eval', args)
    return this.evalResult
  }

  async quit(): Promise<'OK'> {
    this.quitCalls += 1
    this.#record('quit', [])
    return 'OK'
  }
}

function createInstrumentedClient(socketPath = '/tmp/tp-redis-fake.sock'): {
  client: RedisCellClient
  instances: RecordingRedis[]
} {
  const instances: RecordingRedis[] = []
  const client = new RedisCellClient({
    socketPath,
    redisFactory: (options) => {
      const redis = new RecordingRedis(options)
      instances.push(redis)
      return redis as unknown as Redis
    },
  })
  return { client, instances }
}

function cmd(instances: RecordingRedis[]): RecordingRedis {
  const first = instances[0]
  if (!first) throw new TypeError('expected cmd redis instance')
  return first
}

function block(instances: RecordingRedis[]): RecordingRedis {
  const second = instances[1]
  if (!second) throw new TypeError('expected block redis instance')
  return second
}

function maint(instances: RecordingRedis[]): RecordingRedis {
  const third = instances[2]
  if (!third) throw new TypeError('expected maint redis instance')
  return third
}

test('RedisCellClient constructs three redis connections and closes them', async () => {
  const { client, instances } = createInstrumentedClient('/tmp/a.sock')
  assertEquals(instances.length, 3)
  assertEquals(cmd(instances).path, '/tmp/a.sock')
  assertEquals(block(instances).path, '/tmp/a.sock')
  assertEquals(maint(instances).path, '/tmp/a.sock')

  // Error listeners are attached — emitting should not throw.
  cmd(instances).emitError(new Error('boom'))

  await client.close()
  assertEquals(cmd(instances).quitCalls, 1)
  assertEquals(block(instances).quitCalls, 1)
  assertEquals(maint(instances).quitCalls, 1)
})

test('createRedisCellClient returns a RedisCellClient', () => {
  const instances: RecordingRedis[] = []
  const client = createRedisCellClient({
    socketPath: '/tmp/factory.sock',
    redisFactory: (options) => {
      const redis = new RecordingRedis(options)
      instances.push(redis)
      return redis as unknown as Redis
    },
  })
  assertEquals(client instanceof RedisCellClient, true)
  assertEquals(instances.length, 3)
})

test('RedisCellClient hash/string helpers cover empty and PX/NX branches', async () => {
  const { client, instances } = createInstrumentedClient()
  const redis = cmd(instances)

  await client.hset('h', {})
  assertEquals(redis.calls.some((c) => c.method === 'hset'), false)
  await client.hset('h', { a: '1' })
  assertEquals(redis.calls.at(-1), { method: 'hset', args: ['h', { a: '1' }] })

  redis.hgetallResult = {}
  assertEquals(await client.hgetall('h'), null)
  redis.hgetallResult = { a: '1' }
  assertEquals(await client.hgetall('h'), { a: '1' })

  await client.set('k', 'v')
  assertEquals(redis.calls.at(-1), { method: 'set', args: ['k', 'v'] })
  await client.set('k', 'v', 0)
  assertEquals(redis.calls.at(-1), { method: 'set', args: ['k', 'v'] })
  await client.set('k', 'v', 50)
  assertEquals(redis.calls.at(-1), {
    method: 'set',
    args: ['k', 'v', 'PX', 50],
  })

  redis.setResult = 'OK'
  assertEquals(await client.setnx('k', 'v', 10), true)
  assertEquals(redis.calls.at(-1), {
    method: 'set',
    args: ['k', 'v', 'PX', 10, 'NX'],
  })
  redis.setResult = null
  assertEquals(await client.setnx('k', 'v', 10), false)

  redis.setResult = 'OK'
  assertEquals(await client.setnxPersistent('k', 'v'), true)
  assertEquals(redis.calls.at(-1), {
    method: 'set',
    args: ['k', 'v', 'NX'],
  })
  redis.setResult = null
  assertEquals(await client.setnxPersistent('k', 'v'), false)

  redis.getResult = 'hello'
  assertEquals(await client.get('k'), 'hello')
  redis.getResult = null
  assertEquals(await client.get('k'), null)

  assertEquals(await client.pttl('k'), 1000)
  assertEquals(await client.del(), 0)
  assertEquals(await client.del('a', 'b'), 1)

  await client.close()
})

test('RedisCellClient scanKeys paginates and deleteByPattern short-circuits', async () => {
  const { client, instances } = createInstrumentedClient()
  const redis = cmd(instances)

  redis.scanPages = [
    ['1', ['a', 'b']],
    ['0', ['c']],
  ]
  assertEquals(await client.scanKeys('tp:*'), ['a', 'b', 'c'])

  redis.scanIndex = 0
  redis.scanPages = [['0', []]]
  assertEquals(await client.deleteByPattern('missing:*'), 0)

  redis.scanIndex = 0
  redis.scanPages = [['0', ['k1']]]
  redis.delResult = 1
  assertEquals(await client.deleteByPattern('k*'), 1)

  await client.close()
})

test('RedisCellClient expire/set helpers cover GT mode and empty members', async () => {
  const { client, instances } = createInstrumentedClient()
  const redis = cmd(instances)

  redis.expireResult = 1
  assertEquals(await client.expire('k', 5, 'GT'), true)
  assertEquals(redis.calls.at(-1), {
    method: 'expire',
    args: ['k', 5, 'GT'],
  })
  redis.expireResult = 0
  assertEquals(await client.expire('k', 5), false)
  assertEquals(redis.calls.at(-1), { method: 'expire', args: ['k', 5] })

  assertEquals(await client.sadd('s'), 0)
  assertEquals(await client.sadd('s', 'm1', 'm2'), 1)
  assertEquals(await client.srem('s'), 0)
  assertEquals(await client.srem('s', 'm1'), 1)
  assertEquals(await client.smembers('s'), ['a'])

  await client.close()
})

test('RedisCellClient stream helpers cover maxlen, block, and empty id lists', async () => {
  const { client, instances } = createInstrumentedClient()
  const redis = cmd(instances)
  const blockRedis = block(instances)
  const maintRedis = maint(instances)

  assertEquals(await client.xadd('stream', '*', { a: '1' }), '1-0')
  assertEquals(redis.calls.at(-1)?.method, 'xadd')
  assertEquals(
    redis.calls.at(-1)?.args,
    ['stream', '*', 'a', '1'],
  )

  assertEquals(
    await client.xadd('stream', '*', { a: '1' }, 100),
    '1-0',
  )
  assertEquals(
    redis.calls.at(-1)?.args,
    ['stream', 'MAXLEN', '~', 100, '*', 'a', '1'],
  )
  redis.xaddResult = null
  assertEquals(await client.xadd('stream', '*', { a: '1' }), '')

  blockRedis.callResult = [
    ['stream', [['5-0', ['f', '1']]]],
  ]
  assertEquals(
    await client.xreadgroup('g', 'c', 'stream', 10),
    [{ id: '5-0', fields: { f: '1' } }],
  )
  assertEquals(blockRedis.calls.at(-1)?.args[0], 'XREADGROUP')
  assertEquals(
    (blockRedis.calls.at(-1)?.args as string[]).includes('BLOCK'),
    false,
  )

  blockRedis.callResult = null
  assertEquals(
    await client.xreadgroup('g', 'c', 'stream', 10, 25, '0'),
    [],
  )
  assertEquals(
    (blockRedis.calls.at(-1)?.args as string[]).includes('BLOCK'),
    true,
  )
  assertEquals(
    await client.xreadgroup('g', 'c', 'stream', 10, 0),
    [],
  )

  assertEquals(await client.xack('stream', 'g'), 0)
  assertEquals(await client.xack('stream', 'g', '1-0'), 1)
  assertEquals(await client.xdel('stream'), 0)
  assertEquals(await client.xdel('stream', '1-0'), 1)

  assertEquals(
    await client.xautoclaim('stream', 'g', 'c', 1000, '0-0', 5),
    [{ id: '2-0', fields: { k: 'v' } }],
  )
  assertEquals(maintRedis.calls.at(-1)?.method, 'xautoclaim')

  assertEquals(
    await client.xrange('stream', '-', '+'),
    [{ id: '3-0', fields: { x: '1' } }],
  )
  assertEquals(
    await client.xrange('stream', '-', '+', 7),
    [{ id: '3-0', fields: { x: '1' } }],
  )
  assertEquals(
    redis.calls.filter((c) => c.method === 'xrange').at(-1)?.args,
    ['stream', '-', '+', 'COUNT', 7],
  )

  assertEquals(
    await client.xrevrange('stream', '+', '-'),
    [{ id: '4-0', fields: { y: '2' } }],
  )
  assertEquals(
    await client.xrevrange('stream', '+', '-', 3),
    [{ id: '4-0', fields: { y: '2' } }],
  )

  assertEquals(await client.xlen('stream'), 2)
  assertEquals(await client.xtrimMaxLen('stream', 50), 1)

  await client.close()
})

test('RedisCellClient xgroupCreate swallows BUSYGROUP and rethrows others', async () => {
  const { client, instances } = createInstrumentedClient()
  const redis = cmd(instances)

  redis.callResult = 'OK'
  await client.xgroupCreate('stream', 'g', '0', true)
  assertEquals(
    redis.calls.at(-1)?.args,
    ['XGROUP', 'CREATE', 'stream', 'g', '0', 'MKSTREAM'],
  )

  await client.xgroupCreate('stream', 'g', '0', false)
  assertEquals(
    redis.calls.at(-1)?.args,
    ['XGROUP', 'CREATE', 'stream', 'g', '0'],
  )

  redis.throwOnCall = new Error('BUSYGROUP Consumer Group name already exists')
  await client.xgroupCreate('stream', 'g', '0')

  redis.throwOnCall = new Error('NOGROUP')
  await assertRejects(
    () => client.xgroupCreate('stream', 'g', '0'),
    Error,
    'NOGROUP',
  )

  redis.throwOnCall = 'stringy-BUSYGROUP' as unknown as Error
  // Non-Error throw still stringifies and matches BUSYGROUP.
  await client.xgroupCreate('stream', 'g', '0')

  await client.close()
})

test('RedisCellClient sorted-set and eval helpers', async () => {
  const { client, instances } = createInstrumentedClient()
  const redis = cmd(instances)

  assertEquals(await client.zadd('z', 1, 'm'), 1)
  assertEquals(await client.zrem('z'), 0)
  assertEquals(await client.zrem('z', 'm'), 1)
  assertEquals(await client.zrangebyscore('z', 0, 10), ['m'])
  assertEquals(await client.zcard('z'), 3)
  assertEquals(await client.eval('return 1', 0), 'ok')
  assertEquals(redis.calls.at(-1)?.method, 'eval')

  await client.close()
})
