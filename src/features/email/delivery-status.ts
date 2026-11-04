/**
 * Whether system email can go out right now, for the notice on Admin ›
 * Settings › Email. Same answer on both runtimes; each fills in what it can
 * see (only self-hosted can count its dead-letter queue from here).
 */
import { isEmailActiveForRuntime, type ResolvedEmailSettings } from '../settings/email-settings.ts'

export type EmailDeliveryState =
  /** A provider is set up and the queue is reachable. */
  | 'ok'
  /** No usable provider for this edition: nothing is sent. */
  | 'not_configured'
  /** Self-hosted: the mail broker could not be reached when the control plane started. */
  | 'queue_unavailable'

export type EmailDeliveryStatus = {
  state: EmailDeliveryState
  /** Mail jobs that gave up and wait in the dead-letter queue; `null` when this edition cannot count them. */
  deadLetters: number | null
}

export function emailDeliveryState(input: {
  settings: ResolvedEmailSettings
  runtime: 'deno' | 'workers'
  /** Self-hosted only: the control plane fell back to the no-op mail queue. */
  queueUnavailable: boolean
}): EmailDeliveryState {
  if (!isEmailActiveForRuntime(input.settings, input.runtime)) return 'not_configured'
  if (input.runtime === 'deno' && input.queueUnavailable) return 'queue_unavailable'
  return 'ok'
}
