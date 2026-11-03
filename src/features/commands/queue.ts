import type { Context } from 'hono'
import type { CommandEnvelope } from './envelope.ts'

export type CommandEnqueueOptions = {
  /**
   * Deliver no sooner than this many seconds from now (a retry or a command
   * waiting its server's turn). Self-hosted rounds up to the next delay tier.
   */
  delaySeconds?: number
}

export interface CommandQueue {
  enqueue(envelope: CommandEnvelope, options?: CommandEnqueueOptions): Promise<void>
  close?(): Promise<void>
}

export function getCommandQueue(c: Context): CommandQueue | undefined {
  return c.get('commandQueue')
}
