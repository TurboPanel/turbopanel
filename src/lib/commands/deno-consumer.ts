import amqplib from 'amqplib'
import type { Db } from '../../db.ts'
import type { DaemonCellRegistry } from '../../daemon/cell/contracts.ts'
import { compatLogError, compatLogWarn } from '../../log-compat.ts'
import {
  assertCommandAmqpTopology,
  COMMAND_AMQP_QUEUE,
} from './command-amqp-topology.ts'
import {
  isTransientError,
  processCommandEnvelope,
  type CommandConsumerDeps,
  type CommandResealDeps,
} from './consumer.ts'
import { parseCommandEnvelope } from './envelope.ts'
import type { CommandQueue } from './queue.ts'

type AmqpConnection = Awaited<ReturnType<typeof amqplib.connect>>
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createConfirmChannel']>>
type AmqpMessage = Parameters<Parameters<AmqpChannel['consume']>[1]>[0]

export type CommandMessageDisposition = 'ack' | 'nack_requeue' | 'nack_dead'

export type StartCommandConsumerOpts = {
  db: Db
  registry: DaemonCellRegistry
  amqpUrl: string
  commandQueue?: CommandQueue
  resealDeps?: CommandResealDeps
  secretsConfig?: import('../../client/authn/secrets.ts').SecretsConfig
  dataEncryptionSecrets?: import('../../client/authn/secrets.ts').DerivedSecretsConfig
}

/**
 * Host-free: only wire optional consumer deps when at least one is present.
 */
export function buildCommandConsumerDeps(
  opts: Pick<
    StartCommandConsumerOpts,
    'commandQueue' | 'resealDeps' | 'secretsConfig' | 'dataEncryptionSecrets'
  >,
): CommandConsumerDeps | undefined {
  if (!(opts.commandQueue || opts.resealDeps || opts.secretsConfig)) {
    return undefined
  }
  return {
    commandQueue: opts.commandQueue,
    resealDeps: opts.resealDeps,
    secretsConfig: opts.secretsConfig,
    dataEncryptionSecrets: opts.dataEncryptionSecrets,
  }
}

/**
 * Host-free: map success / transient / permanent errors to AMQP ack/nack.
 */
export function commandMessageDisposition(
  outcome: { ok: true } | { ok: false; error: unknown },
): CommandMessageDisposition {
  if (outcome.ok) return 'ack'
  return isTransientError(outcome.error) ? 'nack_requeue' : 'nack_dead'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function connectAmqp(url: string): Promise<AmqpConnection> {
  const maxAttempts = 30
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await amqplib.connect(url)
    } catch (error) {
      if (attempt === maxAttempts) throw error
      const errMsg = error instanceof Error ? error.message : String(error)
      compatLogWarn(
        'command-consumer',
        `AMQP connect failed (attempt ${attempt}/${maxAttempts}): ${errMsg}`,
      )
      await sleep(1000)
    }
  }
  throw new Error('connectAmqp: unreachable')
}

/**
 * Reconnect backoff after the broker drops an established connection. The
 * first retry is immediate-ish because a container restart is usually over in
 * a second; the cap keeps a long broker outage from spinning.
 */
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000

/** The subset of the amqplib EventEmitter surface this module uses. */
type AmqpEmitter = {
  on?: (event: string, listener: (arg?: unknown) => void) => unknown
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type ConsumerSession = {
  connection: AmqpConnection
  channel: AmqpChannel
  consumerTag: string | undefined
  /** Set by the listeners when this session's broker went away. */
  lost: boolean
}

export async function startCommandConsumer(
  opts: StartCommandConsumerOpts,
): Promise<{ close(): Promise<void> }> {
  const consumerDeps = buildCommandConsumerDeps(opts)

  let closed = false
  let reconnecting = false
  let session: ConsumerSession | undefined

  /**
   * Attach the listeners amqplib requires us to attach.
   *
   * A connection object with no `error` listener is why the instance used to
   * die with the broker: amqplib's `succeed()` wires
   * `stream.on('end', onSocketError.bind(self, new Error('Unexpected close')))`,
   * so when RabbitMQ goes away the connection emits `error` — and an
   * unhandled `error` event on an EventEmitter is a thrown exception, which
   * for a top-level consumer means the process exits 1. A game day on
   * 2026-09-18 killed the RabbitMQ container and took the whole control plane
   * down with it; the retry loop in {@link connectAmqp} only ever covered
   * failures to *open* a connection, never the loss of an open one.
   */
  function watchForLoss(
    target: AmqpConnection | AmqpChannel,
    label: string,
    owner: ConsumerSession,
  ): void {
    const emitter = target as AmqpEmitter
    if (typeof emitter.on !== 'function') return
    emitter.on('error', (error) => {
      owner.lost = true
      compatLogWarn(
        'command-consumer',
        `AMQP ${label} error: ${errorMessage(error)}`,
      )
      void reopen(owner, `${label} error`)
    })
    emitter.on('close', () => {
      owner.lost = true
      void reopen(owner, `${label} closed`)
    })
  }

  async function openSession(): Promise<ConsumerSession> {
    const connection = await connectAmqp(opts.amqpUrl)
    const channel = await connection.createConfirmChannel()
    await assertCommandAmqpTopology(channel)
    await channel.prefetch(1)

    const opened: ConsumerSession = {
      connection,
      channel,
      consumerTag: undefined,
      lost: false,
    }
    // Before consume(): a broker that dies during the first delivery still
    // has to find a listener waiting for it.
    watchForLoss(connection, 'connection', opened)
    watchForLoss(channel, 'channel', opened)

    const { consumerTag } = await channel.consume(
      COMMAND_AMQP_QUEUE,
      (msg) => {
        void handleMessage(channel, msg)
      },
    )
    opened.consumerTag = consumerTag
    return opened
  }

  /**
   * Rebuild the session after the broker went away. Retries until it works or
   * {@link close} is called: a queue that is down for ten minutes is an
   * outage to ride out, not a reason to stop consuming commands forever.
   */
  async function reopen(from: ConsumerSession, reason: string): Promise<void> {
    // `close` and `error` both fire for the same loss, and a session that has
    // already been replaced can still emit late; one rebuild per loss.
    if (closed || reconnecting || session !== from) return
    reconnecting = true
    session = undefined
    compatLogWarn('command-consumer', `AMQP ${reason} — reconnecting`)

    let delay = RECONNECT_BASE_DELAY_MS
    while (!closed) {
      try {
        const rebuilt = await openSession()
        if (closed) {
          // close() landed while this was being set up; installing it would
          // leave a consumer running past shutdown.
          await rebuilt.channel.close().catch(() => undefined)
          await rebuilt.connection.close().catch(() => undefined)
          break
        }
        if (rebuilt.lost) {
          // The broker went away again while this session was being set up.
          // Its own listeners already fired and found `session` unset, so
          // nothing else will retry — installing it would leave a dead
          // session that never emits again.
          compatLogWarn(
            'command-consumer',
            'AMQP connection was lost again during reconnect — retrying',
          )
          await rebuilt.channel.close().catch(() => undefined)
          await rebuilt.connection.close().catch(() => undefined)
          await sleep(delay)
          delay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS)
          continue
        }
        session = rebuilt
        compatLogWarn('command-consumer', 'AMQP reconnected, consuming again')
        break
      } catch (error) {
        compatLogError(
          'command-consumer',
          `AMQP reconnect failed: ${errorMessage(error)} — retrying in ${delay}ms`,
        )
        await sleep(delay)
        delay = Math.min(delay * 2, RECONNECT_MAX_DELAY_MS)
      }
    }
    reconnecting = false
  }

  /**
   * ack/nack on a channel the broker has already taken away throws
   * synchronously (`IllegalOperationError: Channel closed`). Unguarded that is
   * the same process-exit this module's listeners exist to prevent: the throw
   * escapes `handleMessage`, and `void handleMessage(...)` makes it an
   * unhandled rejection — nothing in this codebase registers a handler for
   * those, so the instance dies. Swallowing is also the correct answer:
   * RabbitMQ requeues every unacknowledged delivery when a channel closes, so
   * the message is not lost, it is redelivered on the rebuilt session.
   */
  function disposeSafely(
    channel: AmqpChannel,
    msg: NonNullable<AmqpMessage>,
    disposition: CommandMessageDisposition,
  ): void {
    try {
      applyCommandMessageDisposition(channel, msg, disposition)
    } catch (error) {
      compatLogWarn(
        'command-consumer',
        `could not ${disposition} a delivery: ${
          errorMessage(error)
        } — the channel is gone; the broker will redeliver`,
      )
    }
  }

  async function handleMessage(
    channel: AmqpChannel,
    msg: AmqpMessage,
  ): Promise<void> {
    if (!msg) return

    let disposition: CommandMessageDisposition
    try {
      const envelope = parseCommandEnvelope(msg.content.toString())
      await processCommandEnvelope(
        opts.db,
        opts.registry,
        envelope,
        consumerDeps,
      )
      disposition = commandMessageDisposition({ ok: true })
    } catch (error) {
      const errMsg = errorMessage(error)
      disposition = commandMessageDisposition({ ok: false, error })
      if (disposition === 'nack_requeue') {
        compatLogWarn('command-consumer', `transient error, requeueing: ${errMsg}`)
      } else {
        compatLogError('command-consumer', `permanent error, dead-lettering: ${errMsg}`)
      }
    }
    // Outside the try: a failed ack is a broker problem, not a reason to
    // re-classify a command that processed fine as a processing failure.
    disposeSafely(channel, msg, disposition)
  }

  session = await openSession()

  return {
    async close(): Promise<void> {
      closed = true
      const open = session
      session = undefined
      if (!open) return
      if (open.consumerTag) {
        await open.channel.cancel(open.consumerTag).catch(() => undefined)
      }
      await open.channel.close().catch(() => undefined)
      await open.connection.close().catch(() => undefined)
    },
  }
}

/** Apply ack/nack for a consumed message (kept thin for unit tests of disposition). */
export function applyCommandMessageDisposition(
  channel: Pick<AmqpChannel, 'ack' | 'nack'>,
  msg: NonNullable<AmqpMessage>,
  disposition: CommandMessageDisposition,
): void {
  if (disposition === 'ack') {
    channel.ack(msg)
    return
  }
  channel.nack(msg, false, disposition === 'nack_requeue')
}
