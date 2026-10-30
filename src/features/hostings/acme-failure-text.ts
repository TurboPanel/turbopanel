/**
 * Plain words for a certificate failure a server reports.
 *
 * A server learns that its web server has no Let's Encrypt certificate yet by
 * opening the site over HTTPS itself; when that fails it reports the raw
 * network error (`fetch failed: error sending request for url (...): ... dns
 * error: failed to lookup address information: Name or service not known`).
 * That text is about the server's own check, not the authority's answer, and
 * is never shown as is: it becomes one sentence about what is wrong with the
 * name. Anything else (the authority's own reason) is kept.
 */

/** The shape of the server's own HTTPS check failing, as opposed to a reason from the authority. */
const PROBE_ERROR =
  /fetch failed|error sending request|client error \(connect\)|os error \d+|tcp connect error/i

const NO_DNS =
  /dns error|failed to lookup address|name or service not known|nodename nor servname|no address associated|nxdomain|temporary failure in name resolution/i
const REFUSED = /connection refused|econnrefused/i
const TIMED_OUT = /timed out|timeout|deadline has elapsed/i
const UNTRUSTED =
  /unknownissuer|invalid ?certificate|self[- ]signed|certificate verify|handshake|tls|alert/i

/** The name the check went to, read from `url (https://<name>/)` when the caller does not know it. */
function hostFromText(text: string): string | null {
  const match = /https?:\/\/([^/:\s)]+)/i.exec(text)
  return match ? match[1] : null
}

/** One plain sentence for a server's failed HTTPS check, or the text unchanged when it is not one. */
export function plainCertificateFailure(text: string, hostname?: string): string {
  if (!PROBE_ERROR.test(text)) return text
  const name = hostname ?? hostFromText(text) ?? 'This name'
  if (NO_DNS.test(text)) {
    return `${name} has no DNS record yet, so Let's Encrypt cannot check it. Add an A or AAAA record that points at the server.`
  }
  if (REFUSED.test(text)) {
    return `Nothing answered on port 443 at ${name}, so the server could not check its certificate.`
  }
  if (TIMED_OUT.test(text)) {
    return `${name} did not answer in time, so the server could not check its certificate.`
  }
  if (UNTRUSTED.test(text)) {
    return `${name} still shows a certificate Let's Encrypt did not issue, so the certificate has not been issued yet.`
  }
  return `The server could not reach ${name} over HTTPS to check its certificate.`
}
