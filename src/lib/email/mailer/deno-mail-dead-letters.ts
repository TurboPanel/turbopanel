import amqplib from 'amqplib'
import {
  assertEmailAmqpTopology,
  EMAIL_AMQP_DEAD_QUEUE,
  EMAIL_AMQP_EXCHANGE,
  EMAIL_AMQP_ROUTING_KEY,
} from '../../../features/email/smtp/amqp-topology.ts'
import {
  type DeadLetterList,
  type DeadLetterReplayAll,
  deadLetterId,
  type MailDeadLetterStore,
  MailQueueUnavailableError,
  replayHeaders,
  summarizeDeadLetter,
} from '../../../features/email/smtp/dead-letter-replay.ts'
import { logInfo, logWarn } from '../../logger.ts'

/**
 * Lists and replays the mail dead-letter queue over RabbitMQ.
 *
 * Each call opens its own short-lived connection (an operator action, not a
 * hot path) and closes it, so nothing here shares state with the consumer. A
 * message is looked at by taking it off the queue unacknowledged, then put
 * back with a requeue (or acknowledged once its copy is safely on the send
 * queue). A crash in between leaves the message on the queue, never lost; the
 * worst case is a job replayed twice, which the send path already tolerates
 * (at-least-once).
 */

/** What this module needs of a delivered message. */
type Delivery = {
  content: Uint8Array
  properties?: { messageId?: unknown; headers?: Record<string, unknown> }
}

/** The slice of an amqplib confirm channel used here (a seam for tests). */
export type DeadLetterChannel = {
  assertExchange(exchange: string, type: string, options?: { durable?: boolean }): Promise<unknown>
  assertQueue(
    queue: string,
    options?: { durable?: boolean; arguments?: Record<string, unknown> }
  ): Promise<unknown>
  checkQueue(queue: string): Promise<{ messageCount: number }>
  bindQueue(queue: string, exchange: string, routingKey: string): Promise<unknown>
  get(queue: string, options?: { noAck?: boolean }): Promise<Delivery | false>
  ack(message: Delivery): void
  nack(message: Delivery, allUpTo?: boolean, requeue?: boolean): void
  publish(
    exchange: string,
    routingKey: string,
    content: Uint8Array,
    options: Record<string, unknown>,
    callback: (error: Error | null) => void
  ): boolean
  close(): Promise<void>
}

export type DeadLetterConnect = () => Promise<{
  channel: DeadLetterChannel
  close(): Promise<void>
}>

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function connectAmqp(amqpUrl: string): DeadLetterConnect {
  return async () => {
    const connection = await amqplib.connect(amqpUrl)
    try {
      const channel = await connection.createConfirmChannel()
      // Swallow late socket errors: an unlistened `error` event would take the
      // whole instance down (see the consumer's header).
      connection.on('error', () => undefined)
      channel.on('error', () => undefined)
      return {
        channel: channel as unknown as DeadLetterChannel,
        close: async () => {
          await connection.close().catch(() => undefined)
        },
      }
    } catch (error) {
      await connection.close().catch(() => undefined)
      throw error
    }
  }
}

async function takeUpTo(channel: DeadLetterChannel, max: number): Promise<Delivery[]> {
  const taken: Delivery[] = []
  while (taken.length < max) {
    const next = await channel.get(EMAIL_AMQP_DEAD_QUEUE, { noAck: false })
    if (next === false) break
    taken.push(next)
  }
  return taken
}

function putBack(channel: DeadLetterChannel, messages: readonly Delivery[]): void {
  for (const message of messages) {
    try {
      channel.nack(message, false, true)
    } catch (error) {
      // The channel is gone: the broker requeues every unacknowledged message itself.
      logWarn('mailer', `could not put a dead letter back: ${errorText(error)}`)
    }
  }
}

function republish(channel: DeadLetterChannel, message: Delivery, now: Date): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    channel.publish(
      EMAIL_AMQP_EXCHANGE,
      EMAIL_AMQP_ROUTING_KEY,
      message.content,
      {
        persistent: true,
        mandatory: true,
        ...(typeof message.properties?.messageId === 'string'
          ? { messageId: message.properties.messageId }
          : {}),
        headers: replayHeaders(message.properties?.headers, now),
      },
      (error) => (error ? reject(error) : resolve())
    )
  })
}

export type MailDeadLetterStoreOptions = {
  amqpUrl: string
  /** Test seam; production leaves it unset and connects with amqplib. */
  connect?: DeadLetterConnect
  now?: () => Date
}

export function createAmqpMailDeadLetterStore(
  options: MailDeadLetterStoreOptions
): MailDeadLetterStore {
  const connect = options.connect ?? connectAmqp(options.amqpUrl)
  const now = options.now ?? (() => new Date())

  /** One connection for one operation; the queue is declared as the consumer declares it. */
  async function withQueue<T>(
    run: (channel: DeadLetterChannel, total: number) => Promise<T>
  ): Promise<T> {
    let session: Awaited<ReturnType<DeadLetterConnect>>
    try {
      session = await connect()
    } catch (error) {
      throw new MailQueueUnavailableError(`mail queue unreachable: ${errorText(error)}`)
    }
    try {
      await assertEmailAmqpTopology(session.channel)
      const state = await session.channel.checkQueue(EMAIL_AMQP_DEAD_QUEUE)
      return await run(session.channel, state.messageCount)
    } catch (error) {
      if (error instanceof MailQueueUnavailableError) throw error
      throw new MailQueueUnavailableError(`mail queue request failed: ${errorText(error)}`)
    } finally {
      await session.channel.close().catch(() => undefined)
      await session.close()
    }
  }

  return {
    list: (limit) =>
      withQueue(async (channel, total): Promise<DeadLetterList> => {
        const taken = await takeUpTo(channel, limit)
        try {
          return { total, items: await Promise.all(taken.map((m) => summarizeDeadLetter(m))) }
        } finally {
          putBack(channel, taken)
        }
      }),

    replayOne: (id) =>
      withQueue(async (channel, total) => {
        const taken = await takeUpTo(channel, total)
        let match: Delivery | undefined
        for (const message of taken) {
          if ((await deadLetterId(message.properties?.messageId, message.content)) === id) {
            match = message
            break
          }
        }
        const others = taken.filter((message) => message !== match)
        try {
          if (!match) return { replayed: false }
          await republish(channel, match, now())
          channel.ack(match)
          logInfo('mailer', 'replayed one dead-lettered mail job')
          return { replayed: true }
        } catch (error) {
          if (match) putBack(channel, [match])
          throw error
        } finally {
          putBack(channel, others)
        }
      }),

    replayAll: (limit) =>
      withQueue(async (channel, total): Promise<DeadLetterReplayAll> => {
        const taken = await takeUpTo(channel, limit)
        let replayed = 0
        const failed: Delivery[] = []
        for (const message of taken) {
          try {
            await republish(channel, message, now())
            channel.ack(message)
            replayed++
          } catch (error) {
            logWarn('mailer', `could not replay a dead letter: ${errorText(error)}`)
            failed.push(message)
          }
        }
        putBack(channel, failed)
        logInfo('mailer', `replayed ${replayed} dead-lettered mail job(s), ${failed.length} failed`)
        return { replayed, failed: failed.length, remaining: Math.max(0, total - replayed) }
      }),
  }
}
