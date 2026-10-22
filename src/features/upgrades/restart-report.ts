/**
 * What a daemon step remembers when its host reported that the daemon's own
 * restart failed. The report is a hint, not a verdict: the restart command can
 * exit nonzero (or be cut off by the very restart it asked for) while the host
 * still comes back on the new build. So the step is held while the host has
 * the reconnect window to come back, and only judged after that.
 *
 * Pure helpers over a step's `detail`; no DB, no clock.
 */
import type { UpdateRestartReport } from '../../contracts/cell-protocol.ts'
import { redactUrlSecrets } from './redact-url-secrets.ts'

/** How long a host that reported a failed restart has to come back before the step fails. */
export const UPGRADE_RESTART_RECONNECT_MS = 10 * 60 * 1000

/** Error code the daemon sends with a failed restart (older daemons send only this). */
export const RESTART_FAILED_CODE = 'restart_failed'

/** Saved on a step that finished `done` after a restart error. */
export const RESTART_RECOVERED_NOTE =
  'The server restarted onto the new version after the first try was cut short.'

const MAX_STDERR_CHARS = 500
const MAX_MESSAGE_CHARS = 1000

export type RestartPending = {
  /** When the host reported the failed restart; the reconnect window counts from here. */
  at: string
  message: string
  restart?: UpdateRestartReport
}

export type ServerSnapshot = { serverName?: string; serverHostname?: string }

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return redactUrlSecrets(value.replace(/[\r\n\t]/g, ' ').slice(0, max))
}

/** The daemon's diagnostics, cut to a safe shape; null when the frame carried none that make sense. */
export function sanitizeRestartReport(value: unknown): UpdateRestartReport | null {
  const raw = record(value)
  const attempts = finite(raw.attempts)
  const elapsedMs = finite(raw.elapsedMs)
  if (attempts === undefined || elapsedMs === undefined) return null
  const command = text(raw.command, 16)
  const signal = text(raw.signal, 16)
  const stderr = text(raw.stderr, MAX_STDERR_CHARS)
  const exitCode = finite(raw.exitCode)
  return {
    ...(command ? { command } : {}),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(signal ? { signal } : {}),
    ...(stderr ? { stderr } : {}),
    attempts,
    elapsedMs,
  }
}

export function readRestartPending(detail: unknown): RestartPending | null {
  const raw = record(record(detail).restartPending)
  const at = typeof raw.at === 'string' ? raw.at : null
  const message = text(raw.message, MAX_MESSAGE_CHARS)
  if (!at || !message) return null
  const restart = sanitizeRestartReport(raw.restart)
  return { at, message, ...(restart ? { restart } : {}) }
}

/** Hold a step for the reconnect window. A second report (result after progress) keeps the first one's time and facts. */
export function withRestartPending(
  detail: unknown,
  report: { at: string; message: string; restart?: unknown }
): Record<string, unknown> {
  const existing = readRestartPending(detail)
  const restart = sanitizeRestartReport(report.restart) ?? existing?.restart
  const pending: RestartPending = {
    at: existing?.at ?? report.at,
    message: existing?.message ?? text(report.message, MAX_MESSAGE_CHARS) ?? RESTART_FAILED_CODE,
    ...(restart ? { restart } : {}),
  }
  return { ...record(detail), restartPending: pending }
}

/** The host came back on the target: drop the hold, keep the facts and a plain note. */
export function withRestartRecovered(detail: unknown): Record<string, unknown> {
  const { restartPending: pending, ...rest } = record(detail)
  const held = readRestartPending({ restartPending: pending })
  return {
    ...rest,
    restartNote: RESTART_RECOVERED_NOTE,
    ...(held ? { restartPending: held } : {}),
  }
}

export function readRestartNote(detail: unknown): string | null {
  const note = record(detail).restartNote
  return typeof note === 'string' && note.length > 0 ? note : null
}

/** One sentence of diagnostics for a failed restart, ready to append to the step's error. */
export function describeRestartPending(pending: RestartPending): string {
  const restart = pending.restart
  // A current daemon already put the diagnostics in its message.
  if (!restart || pending.message.includes('(systemctl ')) return pending.message
  const status = restart.signal
    ? `ended by ${restart.signal}`
    : `exited ${restart.exitCode ?? 'without a status'}`
  const stderr = restart.stderr ? `, stderr: ${restart.stderr}` : ''
  return `${pending.message} (systemctl ${restart.command ?? 'restart'} ${status}${stderr}; ${restart.attempts} ${restart.attempts === 1 ? 'try' : 'tries'}, ${restart.elapsedMs} ms)`
}

export function withServerSnapshot(
  detail: unknown,
  snapshot: ServerSnapshot
): Record<string, unknown> {
  return {
    ...record(detail),
    ...(snapshot.serverName ? { serverName: snapshot.serverName } : {}),
    ...(snapshot.serverHostname ? { serverHostname: snapshot.serverHostname } : {}),
  }
}

export function readServerSnapshot(detail: unknown): ServerSnapshot {
  const raw = record(detail)
  const serverName = text(raw.serverName, 255)
  const serverHostname = text(raw.serverHostname, 255)
  return {
    ...(serverName ? { serverName } : {}),
    ...(serverHostname ? { serverHostname } : {}),
  }
}
