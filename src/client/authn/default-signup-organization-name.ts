import {
  DISPLAY_NAME_MAX_LENGTH,
  displayNameCodePointLength,
  isValidDisplayName,
  normalizeDisplayName,
} from '../../lib/display-name-format.ts'

/** Fallback when sign-up cannot derive a name from the account email. */
export const MY_ORGANIZATION_NAME = 'My Organization'

/** Lower-case suffix appended to the normalized email on first org provision. */
export const SIGNUP_ORGANIZATION_NAME_SUFFIX = "'s organization"

/**
 * Default display name for the first organization created at sign-up when the
 * caller passes no explicit `orgName`. Uses the stored email (`trim` +
 * `toLowerCase`, same as auth routes). Falls back to {@link MY_ORGANIZATION_NAME}
 * when the email is missing or the composed label would violate display-name rules.
 */
export function resolveDefaultSignupOrganizationName(email: string | null | undefined): string {
  const trimmed = email?.trim().toLowerCase() ?? ''
  if (!trimmed) {
    return MY_ORGANIZATION_NAME
  }

  const suffix = SIGNUP_ORGANIZATION_NAME_SUFFIX
  const suffixLen = displayNameCodePointLength(suffix)
  const maxEmailLen = DISPLAY_NAME_MAX_LENGTH - suffixLen
  if (maxEmailLen < 1) {
    return MY_ORGANIZATION_NAME
  }

  const emailChars = [...trimmed]
  const truncatedEmail =
    emailChars.length > maxEmailLen ? emailChars.slice(0, maxEmailLen).join('') : trimmed
  const composed = `${truncatedEmail}${suffix}`
  const normalized = normalizeDisplayName(composed)
  if (!isValidDisplayName(normalized)) {
    return MY_ORGANIZATION_NAME
  }
  return normalized
}
