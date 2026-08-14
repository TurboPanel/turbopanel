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

export async function startCommandConsumer(
  opts: StartCommandConsumerOpts,
): Promise<{ close(): Promise<void> }> {
  const connection = await connectAmqp(opts.amqpUrl)
  const channel = await connection.createConfirmChannel()
  await assertCommandAmqpTopology(channel)
  await channel.prefetch(1)

  const consumerDeps = buildCommandConsumerDeps(opts)

  const { consumerTag } = await channel.consume(
    COMMAND_AMQP_QUEUE,
    (msg) => {
      void handleMessage(msg)
    },
  )

  async function handleMessage(msg: AmqpMessage): Promise<void> {
    if (!msg) return

    try {
      const envelope = parseCommandEnvelope(msg.content.toString())
      await processCommandEnvelope(
        opts.db,
        opts.registry,
        envelope,
        consumerDeps,
      )
      applyCommandMessageDisposition(channel, msg, commandMessageDisposition({ ok: true }))
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      const disposition = commandMessageDisposition({ ok: false, error })
      if (disposition === 'nack_requeue') {
        compatLogWarn('command-consumer', `transient error, requeueing: ${errMsg}`)
      } else {
        compatLogError('command-consumer', `permanent error, dead-lettering: ${errMsg}`)
      }
      applyCommandMessageDisposition(channel, msg, disposition)
    }
  }

  return {
    async close(): Promise<void> {
      if (consumerTag) {
        await channel.cancel(consumerTag).catch(() => undefined)
      }
      await channel.close().catch(() => undefined)
      await connection.close().catch(() => undefined)
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
