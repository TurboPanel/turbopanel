import type { Context } from 'hono'

export type OtpType = 'sign-in' | 'email-verification' | 'forget-password'

export type EmailJob =
  | {
      type: 'signup-verification'
      to: string
      from: string
      verificationUrl: string
    }
  | {
      /** Password-reset link (better-auth `sendResetPassword`); valid for one hour. */
      type: 'password-reset'
      to: string
      from: string
      resetUrl: string
    }
  | {
      type: 'email-otp'
      to: string
      from: string
      otp: string
      otpType: OtpType
    }
  | {
      type: 'server-tier-notice'
      to: string
      from: string
      kind: 'exceeds' | 'overprovisioned'
      serverName: string
      organizationName: string
      licenseTierLabel: string
      requiredTierLabel: string
      recommendedTierLabel: string
      unwatched: { nics: string[]; drives: string[]; gpus: string[] }
      consoleUrl: string
    }
  | {
      type: 'invitation'
      to: string
      from: string
      inviterEmail: string
      organizationName: string
      teamName: string
      acceptUrl: string
    }
  | {
      /** The link that confirms an email channel's address (`src/client/notifications/channel-verification.ts`); valid for one day. */
      type: 'channel-verification'
      to: string
      from: string
      verifyUrl: string
      channelLabel: string
      /** Set for an organization channel; null for a person's own. */
      organizationName: string | null
      /** The account that asked for the channel. */
      requestedByEmail: string
    }
  | {
      /** One notification event delivered to an email channel (`src/features/notifications/`). */
      type: 'notification'
      to: string
      from: string
      event: string
      severity: 'info' | 'warning' | 'critical'
      title: string
      body: string | null
      /** `key=value` lines of the non-secret context, already rendered. */
      details: string[]
      organizationName: string | null
      /** Where to look, when the event has a target the console can show. */
      consoleUrl: string | null
      at: string
      /** Unsubscribe and filtering headers; absent on jobs queued by an older build. */
      mail?: NotificationMailHeaders
    }
  | {
      /** One summary of the events a channel held for a digest window or quiet hours. */
      type: 'notification-digest'
      to: string
      from: string
      /** Why these were held: a digest cadence, or quiet hours that just ended. */
      summary: 'hourly' | 'daily' | 'quiet'
      /** Every event in the window, including those past the listed groups and items. */
      total: number
      groups: NotificationDigestGroup[]
      /** Event kinds beyond the listed groups. */
      moreGroups: number
      /** The link back to the app. */
      consoleUrl: string | null
      /** ISO time the digest was built. */
      at: string
      /** Unsubscribe and filtering headers; absent on jobs queued by an older build. */
      mail?: NotificationMailHeaders
    }

/**
 * What a notification email says about itself beyond its body: the RFC 8058
 * one-click unsubscribe link (a POST target, never redirected), the page a
 * person opens from the footer, and the facts large organizations filter mail
 * by. Every field is optional, so an older job still parses.
 */
export type NotificationMailHeaders = {
  /** `List-Unsubscribe` target; set only on a personal copy. */
  unsubscribeUrl?: string | null
  /** The footer's unsubscribe page in the web interface. */
  unsubscribePageUrl?: string | null
  /** The footer's "manage all settings" link. */
  settingsUrl?: string | null
  organizationId?: string | null
  projectId?: string | null
  event?: string | null
  /** Why the copy came: `preference`, `organization-channel` or `instance-channel`. */
  reason?: string | null
}

export type NotificationDigestItem = {
  title: string
  at: string
  /** Where the console shows the event's target, when it has one. */
  url: string | null
}

export type NotificationDigestGroup = {
  event: string
  severity: 'info' | 'warning' | 'critical'
  /** How many events of this kind the window held. */
  count: number
  /** The first few, newest last; `count` can be larger. */
  items: NotificationDigestItem[]
}

export interface EmailQueue {
  enqueue(job: EmailJob): Promise<void>
  close?(): Promise<void>
}

export function getEmailQueue(c: Context): EmailQueue | undefined {
  return c.get('emailQueue')
}

/**
 * Longest an email provider HTTP call may take before it is abandoned. A
 * provider that never answers must fail the send, not hold the request (and
 * whatever it holds) open until the platform kills it.
 */
export const EMAIL_PROVIDER_TIMEOUT_MS = 10_000
