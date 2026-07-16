export const COMMAND_TYPES = [
  'daemon.ping',
  'server.hostname.set',
  'server.reboot',
  'environment.deploy',
  'environment.stop',
] as const

export type CommandType = (typeof COMMAND_TYPES)[number]

export const COMMAND_STATUSES = [
  'queued',
  'dispatching',
  'sent',
  'acked',
  'running',
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
] as const

export type CommandStatus = (typeof COMMAND_STATUSES)[number]

export const TERMINAL_COMMAND_STATUSES: ReadonlySet<CommandStatus> = new Set([
  'succeeded',
  'failed',
  'timed_out',
  'cancelled',
])

export function isCommandType(value: unknown): value is CommandType {
  return typeof value === 'string' && (COMMAND_TYPES as readonly string[]).includes(value)
}

export function isCommandStatus(value: unknown): value is CommandStatus {
  return typeof value === 'string' && (COMMAND_STATUSES as readonly string[]).includes(value)
}
