/**
 * Strip query strings and fragments from every http(s) URL in `text`.
 *
 * A daemon's update failure can quote the full signed GitHub download URL
 * (`X-Amz-Signature`, `token`, ...). Those are bearer credentials, so a step's
 * stored errorMessage / detail keeps the host and path and drops the rest.
 * User info (`user:pass@`) is dropped too.
 */
const URL_WITH_SECRETS = /\bhttps?:\/\/[^\s"'<>`)\]]+/gi

function redactOne(match: string): string {
  const cut = match.search(/[?#]/)
  const base = cut === -1 ? match : match.slice(0, cut)
  const stripped = base.replace(/^(https?:\/\/)[^/@]*@/i, '$1')
  return cut === -1 ? stripped : `${stripped}?[redacted]`
}

export function redactUrlSecrets(text: string): string {
  return text.replaceAll(URL_WITH_SECRETS, redactOne)
}
