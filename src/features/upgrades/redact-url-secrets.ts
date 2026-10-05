/**
 * Strip secrets from error text before it is stored or shown.
 *
 * URLs: the query string and fragment of every http(s) URL, and its user info
 * (`user:pass@`), are dropped. A daemon's update failure can quote the full
 * signed GitHub download URL (`X-Amz-Signature`, `token`, ...); those are bearer
 * credentials, so a step's stored errorMessage / detail keeps the host and path
 * and drops the rest.
 *
 * Bare tokens (not inside a URL): well-known token shapes (GitHub, Slack,
 * Stripe, AWS access key ids, JWTs, `sk-` API keys), `Bearer` header values,
 * and the value after `NAME=` (or `"name": "..."`) when the name is a secret
 * word (token, secret, password, api key, ...). The shapes are conservative on
 * purpose: text that merely mentions a word ("invalid token: expired") is kept.
 * Every pattern is linear (an anchored prefix, then one character class), so
 * none can backtrack badly. Known secret values are covered separately, on the
 * daemon, by its deny-set. Twin of the daemon's `redactUrlSecrets`
 * (turbopaneld src/util/redact-url-secrets.ts), which does the URL half.
 *
 * The optional tail of the URL pattern swallows the `]` of a `?[redacted]`
 * marker, so text that is redacted twice (daemon, then control plane) comes out
 * the same.
 */
const URL_WITH_SECRETS = /\bhttps?:\/\/[^\s"'<>`)\]]+(?:(?<=\?\[redacted)\])?/gi

/**
 * Where the host starts inside `rest` (the URL after `//`): just past the last
 * `@` of the authority, which ends at the first `/`. A `?` or `#` before that
 * `@` belongs to a password (`user:pa?ss@host`) when a `:` comes before it; with
 * no `:` it is a query that holds an address (`host?mail=a@b`), so no user info.
 * When in doubt the part is treated as user info: a lost host is better than a
 * leaked password.
 */
function hostStart(rest: string): number {
  const slash = rest.indexOf('/')
  const authority = slash === -1 ? rest : rest.slice(0, slash)
  const at = authority.lastIndexOf('@')
  if (at === -1) return 0
  const before = authority.slice(0, at)
  const cut = before.search(/[?#]/)
  if (cut !== -1 && !before.slice(0, cut).includes(':')) return 0
  return at + 1
}

function redactOne(match: string): string {
  const schemeEnd = match.indexOf('//') + 2
  const scheme = match.slice(0, schemeEnd)
  const rest = match.slice(schemeEnd)
  const target = rest.slice(hostStart(rest))
  const cut = target.search(/[?#]/)
  return cut === -1 ? `${scheme}${target}` : `${scheme}${target.slice(0, cut)}?[redacted]`
}

/** Token shapes with a fixed prefix. Each is replaced whole. */
const PREFIXED_TOKENS = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_\w{20,}/g,
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bsk-[\w-]{16,}/g,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
]

/** `Bearer abc...`: keep the scheme word, drop the credential (20+ characters, so prose survives). */
const BEARER_VALUE = /\bBearer\s+[\w.~+/=-]{20,}/gi

/**
 * `NAME=value`, `NAME: value`, `"name": "value"` where the name ends in a secret
 * word. The word may sit inside a longer name (`DB_PASSWORD`, `x-api-key`) but not
 * inside a longer word (`tokenizer`). After `=` any value of 4+ characters is
 * dropped; after `:` only a quoted value or a long credential-shaped one is
 * (so `token: expired` survives).
 */
const SECRET_NAME_ASSIGNMENT =
  /(?<![A-Za-z0-9])(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credentials?)["']?(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;&]+)/gi

const CREDENTIAL_SHAPED = /^[\w.~+/=-]{16,}$/

function redactAssignment(match: string, separator: string, value: string): string {
  const quoted = value.startsWith('"') || value.startsWith("'")
  const redact = separator.includes('=')
    ? value.length >= 4
    : quoted || CREDENTIAL_SHAPED.test(value)
  if (!redact) return match
  return (
    match.slice(0, match.length - value.length) +
    (quoted ? `${value[0]}[redacted]${value[0]}` : '[redacted]')
  )
}

function redactBareSecrets(text: string): string {
  let out = text
  for (const pattern of PREFIXED_TOKENS) out = out.replaceAll(pattern, '[redacted]')
  out = out.replaceAll(BEARER_VALUE, 'Bearer [redacted]')
  return out.replaceAll(SECRET_NAME_ASSIGNMENT, redactAssignment)
}

export function redactUrlSecrets(text: string): string {
  return redactBareSecrets(text.replaceAll(URL_WITH_SECRETS, redactOne))
}
