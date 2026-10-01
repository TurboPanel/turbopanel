import type { EmailJob, NotificationDigestGroup, OtpType } from '../../../features/email/types.ts'

const VALID_OTP_TYPES = new Set<OtpType>(['sign-in', 'email-verification', 'forget-password'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function parseUnwatched(
  value: unknown
): { nics: string[]; drives: string[]; gpus: string[] } | null {
  if (!isRecord(value)) return null
  if (!isStringArray(value.nics) || !isStringArray(value.drives) || !isStringArray(value.gpus)) {
    return null
  }
  return { nics: value.nics, drives: value.drives, gpus: value.gpus }
}

function parseSignupVerification(
  job: Record<string, unknown>,
  to: string,
  from: string
): EmailJob | null {
  if (typeof job.verificationUrl !== 'string') return null
  return {
    type: 'signup-verification',
    to,
    from,
    verificationUrl: job.verificationUrl,
  }
}

function parsePasswordReset(
  job: Record<string, unknown>,
  to: string,
  from: string
): EmailJob | null {
  if (typeof job.resetUrl !== 'string') return null
  return { type: 'password-reset', to, from, resetUrl: job.resetUrl }
}

function parseEmailOtp(job: Record<string, unknown>, to: string, from: string): EmailJob | null {
  if (typeof job.otp !== 'string') return null
  if (typeof job.otpType !== 'string' || !VALID_OTP_TYPES.has(job.otpType as OtpType)) {
    return null
  }
  return {
    type: 'email-otp',
    to,
    from,
    otp: job.otp,
    otpType: job.otpType as OtpType,
  }
}

function parseServerTierNotice(
  job: Record<string, unknown>,
  to: string,
  from: string
): EmailJob | null {
  const kind = job.kind
  if (kind !== 'exceeds' && kind !== 'overprovisioned') return null

  const serverName = job.serverName
  const organizationName = job.organizationName
  const licenseTierLabel = job.licenseTierLabel
  const requiredTierLabel = job.requiredTierLabel
  const recommendedTierLabel = job.recommendedTierLabel
  const consoleUrl = job.consoleUrl
  if (
    typeof serverName !== 'string' ||
    typeof organizationName !== 'string' ||
    typeof licenseTierLabel !== 'string' ||
    typeof requiredTierLabel !== 'string' ||
    typeof recommendedTierLabel !== 'string' ||
    typeof consoleUrl !== 'string'
  ) {
    return null
  }

  const unwatched = parseUnwatched(job.unwatched)
  if (!unwatched) return null

  return {
    type: 'server-tier-notice',
    to,
    from,
    kind,
    serverName,
    organizationName,
    licenseTierLabel,
    requiredTierLabel,
    recommendedTierLabel,
    unwatched,
    consoleUrl,
  }
}

const SEVERITIES = ['info', 'warning', 'critical']

function isDigestItem(item: unknown): boolean {
  const i = item as Record<string, unknown> | null
  return (
    typeof i === 'object' &&
    i !== null &&
    typeof i.title === 'string' &&
    typeof i.at === 'string' &&
    (i.url === null || typeof i.url === 'string')
  )
}

function isDigestGroup(group: unknown): group is NotificationDigestGroup {
  const g = group as Record<string, unknown> | null
  return (
    typeof g === 'object' &&
    g !== null &&
    typeof g.event === 'string' &&
    typeof g.severity === 'string' &&
    SEVERITIES.includes(g.severity) &&
    typeof g.count === 'number' &&
    Array.isArray(g.items) &&
    g.items.every(isDigestItem)
  )
}

function parseNotificationDigest(
  job: Record<string, unknown>,
  to: string,
  from: string
): EmailJob | null {
  if (job.summary !== 'hourly' && job.summary !== 'daily' && job.summary !== 'quiet') return null
  if (typeof job.total !== 'number' || typeof job.moreGroups !== 'number') return null
  if (!Array.isArray(job.groups) || !job.groups.every(isDigestGroup)) return null
  if (job.consoleUrl !== null && typeof job.consoleUrl !== 'string') return null
  if (typeof job.at !== 'string') return null
  return {
    type: 'notification-digest',
    to,
    from,
    summary: job.summary,
    total: job.total,
    groups: job.groups as NotificationDigestGroup[],
    moreGroups: job.moreGroups,
    consoleUrl: job.consoleUrl,
    at: job.at,
  }
}

function parseInvitation(job: Record<string, unknown>, to: string, from: string): EmailJob | null {
  if (typeof job.inviterEmail !== 'string') return null
  if (typeof job.organizationName !== 'string') return null
  if (typeof job.teamName !== 'string') return null
  if (typeof job.acceptUrl !== 'string') return null
  return {
    type: 'invitation',
    to,
    from,
    inviterEmail: job.inviterEmail,
    organizationName: job.organizationName,
    teamName: job.teamName,
    acceptUrl: job.acceptUrl,
  }
}

function parseNotification(
  job: Record<string, unknown>,
  to: string,
  from: string
): EmailJob | null {
  if (typeof job.event !== 'string') return null
  if (job.severity !== 'info' && job.severity !== 'warning' && job.severity !== 'critical')
    return null
  if (typeof job.title !== 'string') return null
  if (job.body !== null && typeof job.body !== 'string') return null
  if (!Array.isArray(job.details) || !job.details.every((d) => typeof d === 'string')) return null
  if (job.organizationName !== null && typeof job.organizationName !== 'string') return null
  if (job.consoleUrl !== null && typeof job.consoleUrl !== 'string') return null
  if (typeof job.at !== 'string') return null
  return {
    type: 'notification',
    to,
    from,
    event: job.event,
    severity: job.severity,
    title: job.title,
    body: job.body,
    details: job.details as string[],
    organizationName: job.organizationName,
    consoleUrl: job.consoleUrl,
    at: job.at,
  }
}

function parseChannelVerification(
  job: Record<string, unknown>,
  to: string,
  from: string
): EmailJob | null {
  if (typeof job.verifyUrl !== 'string') return null
  if (typeof job.channelLabel !== 'string') return null
  if (job.organizationName !== null && typeof job.organizationName !== 'string') return null
  if (typeof job.requestedByEmail !== 'string') return null
  return {
    type: 'channel-verification',
    to,
    from,
    verifyUrl: job.verifyUrl,
    channelLabel: job.channelLabel,
    organizationName: job.organizationName,
    requestedByEmail: job.requestedByEmail,
  }
}

/** Decode a queued mailer payload into an {@link EmailJob}, or `null` if invalid. */
export function parseEmailJob(raw: unknown): EmailJob | null {
  if (!isRecord(raw)) return null
  if (typeof raw.to !== 'string' || typeof raw.from !== 'string') return null

  if (raw.type === 'signup-verification') {
    return parseSignupVerification(raw, raw.to, raw.from)
  }
  if (raw.type === 'password-reset') {
    return parsePasswordReset(raw, raw.to, raw.from)
  }
  if (raw.type === 'email-otp') {
    return parseEmailOtp(raw, raw.to, raw.from)
  }
  if (raw.type === 'server-tier-notice') {
    return parseServerTierNotice(raw, raw.to, raw.from)
  }
  if (raw.type === 'invitation') {
    return parseInvitation(raw, raw.to, raw.from)
  }
  if (raw.type === 'notification') {
    return parseNotification(raw, raw.to, raw.from)
  }

  if (raw.type === 'notification-digest') {
    return parseNotificationDigest(raw, raw.to, raw.from)
  }

  if (raw.type === 'channel-verification') {
    return parseChannelVerification(raw, raw.to, raw.from)
  }

  return null
}
