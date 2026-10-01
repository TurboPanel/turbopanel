/**
 * Fake Have I Been Pwned range responders for tests: no network, and the
 * passwords are only ever built at run time by the caller.
 */
import { type BreachRangeResponder, breachLookupKey } from '../client/authn/breached-password.ts'

export type RecordingResponder = BreachRangeResponder & { prefixes: string[] }

const PADDING_ROWS =
  '0018B5C0A5F3E1D2C4B6A79881726354A9B:0\r\n0123456789ABCDEF0123456789ABCDEF012:0'

/** Answers "not breached" for everything and records each prefix it was asked for. */
export function cleanBreachResponder(): RecordingResponder {
  const prefixes: string[] = []
  const responder: BreachRangeResponder = (prefix) => {
    prefixes.push(prefix)
    return Promise.resolve(`${PADDING_ROWS}\r\n`)
  }
  return Object.assign(responder, { prefixes })
}

/** Answers with `password` listed as breached (and unrelated padding rows). */
export async function breachedBreachResponder(password: string): Promise<RecordingResponder> {
  const { suffix } = await breachLookupKey(password)
  const prefixes: string[] = []
  const responder: BreachRangeResponder = (prefix) => {
    prefixes.push(prefix)
    return Promise.resolve(`${PADDING_ROWS}\r\n${suffix}:42\r\n`)
  }
  return Object.assign(responder, { prefixes })
}

/** Fails like an unreachable API. */
export const downBreachResponder: BreachRangeResponder = () =>
  Promise.reject(new TypeError('network unreachable'))

/** Runs `fn` and returns what the compat logger wrote to stderr (Deno) or `console.warn` (Workers) meanwhile. */
export async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const decoder = new TextDecoder()
  const stderr = Deno.stderr as { writeSync: (data: Uint8Array) => number }
  const originalWrite = stderr.writeSync
  const originalWarn = console.warn
  stderr.writeSync = (data: Uint8Array) => {
    lines.push(decoder.decode(data))
    return data.length
  }
  console.warn = (...args: unknown[]) => {
    lines.push(args.join(' '))
  }
  try {
    await fn()
  } finally {
    stderr.writeSync = originalWrite
    console.warn = originalWarn
  }
  return lines
}
