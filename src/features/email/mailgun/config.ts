/**
 * The one reading of the transactional mail provider's settings, shared by the
 * Workers sender and the Deno mailer: the key and domain must both be set, and
 * the rest comes straight from the resolved settings.
 */
import type { ResolvedEmailSettings } from '../../settings/email-settings.ts'

export type MailgunConfig = {
  apiKey: string
  domain: string
  from: string
  apiBase: string
}

/** The provider config, or `undefined` while the key or the domain is missing. */
export function mailgunConfigFromSettings(
  resolved: ResolvedEmailSettings
): MailgunConfig | undefined {
  const apiKey = resolved.mailgunApiKey?.trim() ?? ''
  const domain = resolved.mailgunDomain?.trim() ?? ''
  if (apiKey === '' || domain === '') return undefined
  return { apiKey, domain, from: resolved.from, apiBase: resolved.mailgunApiBase }
}
