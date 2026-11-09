/**
 * Telling "this text is not an API token at all" apart from every other
 * refusal. A Global API Key, a tunnel run token or a token with a stray
 * character never reaches Cloudflare's permission checks: the API answers 400
 * with error 6003 (`Invalid request headers`) and, in `error_chain`, 6111
 * (`Invalid format for Authorization header`). That is a problem with what was
 * pasted, not with reaching Cloudflare, so it gets its own words.
 */

export const CLOUDFLARE_TOKEN_FORMAT_MESSAGE =
  'This is not a Cloudflare API token. Create an API token in Cloudflare (My Profile > API Tokens); a Global API Key or a tunnel run token does not work here.'

/** One entry of the `errors` list in a Cloudflare API answer. */
export type CloudflareApiError = {
  code?: number
  message?: string
  error_chain?: { code?: number; message?: string }[]
}

const INVALID_REQUEST_HEADERS = 6003
const INVALID_AUTHORIZATION_FORMAT = 6111
const FORMAT_WORDING = /invalid request headers|invalid format for authorization header/i

/** A tunnel run token is base64 JSON, so it starts with `eyJ`; an API token never does. */
const RUN_TOKEN_PREFIX = 'eyJ'
/** Whitespace, control characters or anything outside printable ASCII cannot be part of an API token. */
const NOT_TOKEN_TEXT = /[^\x21-\x7e]/

/**
 * A shape Cloudflare would refuse as "not a token", found without asking it:
 * a tunnel run token, or text with a space, line break or other stray
 * character inside. Null when the text could be an API token.
 */
export function cloudflareTokenFormatProblem(token: string): string | null {
  const text = token.trim()
  if (text.startsWith(RUN_TOKEN_PREFIX) || NOT_TOKEN_TEXT.test(text)) {
    return CLOUDFLARE_TOKEN_FORMAT_MESSAGE
  }
  return null
}

function saysTokenFormat(entry: { code?: number; message?: string }, status: number): boolean {
  if (entry.code === INVALID_REQUEST_HEADERS || entry.code === INVALID_AUTHORIZATION_FORMAT) {
    return true
  }
  return status === 400 && typeof entry.message === 'string' && FORMAT_WORDING.test(entry.message)
}

/** Whether a refused request was refused because the Authorization value is not an API token. */
export function isTokenFormatRefusal(
  status: number,
  errors: readonly CloudflareApiError[] | undefined
): boolean {
  return (errors ?? []).some(
    (entry) =>
      saysTokenFormat(entry, status) ||
      (entry.error_chain ?? []).some((link) => saysTokenFormat(link, status))
  )
}
