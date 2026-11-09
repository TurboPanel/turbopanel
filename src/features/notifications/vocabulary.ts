/**
 * The fixed value sets of the notification tables that are not the event
 * catalogue itself. Each list is pinned to its CHECK in `schema.ts` by
 * `src/db/enum-checks.test.ts`, so a value is added in both places or not at
 * all.
 *
 * Workers-bundle safe: constants only.
 */

/** Who may hear a topic, checked again when a copy is sent. */
export const NOTIFICATION_AUDIENCES = ['members', 'managers', 'admins'] as const
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCES)[number]

/** Where a topic is raised: in an organization, by the vendor, for the install's administrators, or about one account. */
export const NOTIFICATION_TOPIC_KINDS = ['organization', 'platform', 'instance', 'account'] as const
export type NotificationTopicKind = (typeof NOTIFICATION_TOPIC_KINDS)[number]

/** The most specific resource an organization topic names. */
export const NOTIFICATION_TOPIC_SCOPES = [
  'organization',
  'project',
  'environment',
  'service',
  'server',
  'destination',
] as const
export type NotificationTopicScope = (typeof NOTIFICATION_TOPIC_SCOPES)[number]

/** A preference level: the lowest severity that gets through, or nothing. */
export const NOTIFICATION_LEVELS = ['all', 'warning', 'critical', 'none'] as const
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number]

/**
 * The channel kinds a preference names. `chat` covers the Slack, Discord and
 * Telegram channel kinds together; `inbox` is the bell.
 */
export const NOTIFICATION_PREFERENCE_KINDS = ['inbox', 'email', 'push', 'chat', 'webhook'] as const
export type NotificationPreferenceKind = (typeof NOTIFICATION_PREFERENCE_KINDS)[number]

export const NOTIFICATION_EVENT_STATUSES = ['open', 'resolved', 'closed'] as const
export type NotificationEventStatus = (typeof NOTIFICATION_EVENT_STATUSES)[number]

/** Why a copy was held, dropped or not sent; recorded on the `attempt` row. */
export const NOTIFICATION_ATTEMPT_REASONS = [
  'quiet_hours',
  'digest',
  'muted',
  'rate_limited',
  'bounced',
  'no_access',
  'scope_deleted',
  'read_in_app',
  'unverified',
  'channel_failing',
] as const
export type NotificationAttemptReason = (typeof NOTIFICATION_ATTEMPT_REASONS)[number]

export const NOTIFICATION_CHANNEL_PAUSED_REASONS = ['manual', 'failing', 'bounced'] as const

export const NOTIFICATION_DEVICE_KINDS = ['ios', 'android'] as const
export const NOTIFICATION_DEVICE_STATUSES = ['active', 'paused', 'invalid'] as const
export const NOTIFICATION_DEVICE_PROVIDERS = ['expo'] as const

export const NOTIFICATION_SUPPRESSION_REASONS = ['bounced', 'complained', 'rejected'] as const
export type NotificationSuppressionReason = (typeof NOTIFICATION_SUPPRESSION_REASONS)[number]
export const NOTIFICATION_SUPPRESSION_SOURCES = ['smtp', 'mailgun', 'mailpit', 'manual'] as const
export type NotificationSuppressionSource = (typeof NOTIFICATION_SUPPRESSION_SOURCES)[number]
