import { assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import {
  buildSignedCookie,
  generateSessionToken,
  HTTP_SESSION_COOKIE_NAME,
  HTTPS_SESSION_COOKIE_NAME,
  resolveRequestTls,
  resolveRequestTlsFromUrl,
  resolveSessionCookieName,
  resolveSessionCookieNameFromUrl,
  resolveTrustedProxyRequestTls,
  verifySignedCookie,
} from './crypto.ts'
import { deriveSecretsConfig, parseSecretsEnv } from './secrets.ts'
import { TEST_ONLY_TURBOPANEL_SECRET } from '../../test-fixtures/secrets.ts'

const V2_SECRET = 'Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2_Mm3Nn4Oo5Pp6Qq7'

function sessionSigningSecrets() {
  const config = parseSecretsEnv(`2:${V2_SECRET},1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    'deno')
  return deriveSecretsConfig(config, 'session-signing')
}

it('HTTPS session cookie name uses the __Host- prefix', () => {
  assertEquals(HTTPS_SESSION_COOKIE_NAME, '__Host-turbopanel.session_token')
})

it('resolveRequestTls (Workers) ignores spoofed X-Forwarded-Proto: http on HTTPS', () => {
  const tls = resolveRequestTls({
    requestUrl: 'https://panel.example.com/api/client/v1/auth/sign-in',
    runtime: 'workers',
    forwardedProto: 'http',
  })
  assertEquals(tls.isHttps, true)
  assertEquals(tls.cookieName, HTTPS_SESSION_COOKIE_NAME)
})

it('resolveRequestTls (Workers) cannot produce the HTTP cookie name via a spoofed header', () => {
  const cookieName = resolveSessionCookieName({
    requestUrl: 'https://panel.example.com/',
    runtime: 'workers',
    forwardedProto: 'http',
  })
  assertEquals(cookieName, HTTPS_SESSION_COOKIE_NAME)
})

it('resolveRequestTls (Workers) derives HTTPS state from the URL when no header is present', () => {
  const tls = resolveRequestTls({
    requestUrl: 'https://panel.example.com/',
    runtime: 'workers',
  })
  assertEquals(tls.isHttps, true)
  assertEquals(tls.cookieName, HTTPS_SESSION_COOKIE_NAME)
})

it('resolveRequestTls (Workers) serves the HTTP cookie for genuine plaintext HTTP requests', () => {
  const tls = resolveRequestTls({
    requestUrl: 'http://localhost:8880/',
    runtime: 'workers',
    forwardedProto: 'https',
  })
  // Spoofed https header does not upgrade a genuine plaintext request either.
  assertEquals(tls.isHttps, false)
  assertEquals(tls.cookieName, HTTP_SESSION_COOKIE_NAME)
})

it('resolveRequestTls (Deno) treats http+unix with X-Forwarded-Proto: https as HTTPS', () => {
  const tls = resolveRequestTls({
    requestUrl: 'http+unix://%2Frun%2Fturbopanel%2Finstance.sock/api/client/v1/auth/sign-in',
    runtime: 'deno',
    forwardedProto: 'https',
  })
  assertEquals(tls.isHttps, true)
  assertEquals(tls.cookieName, HTTPS_SESSION_COOKIE_NAME)
})

it('resolveRequestTls (Deno) treats http+unix with X-Forwarded-Proto: http as HTTP', () => {
  const tls = resolveRequestTls({
    requestUrl: 'http+unix://%2Frun%2Fturbopanel%2Finstance.sock/',
    runtime: 'deno',
    forwardedProto: 'http',
  })
  assertEquals(tls.isHttps, false)
  assertEquals(tls.cookieName, HTTP_SESSION_COOKIE_NAME)
})

it('resolveRequestTls (Deno) falls back to the URL when no forwarded header is set', () => {
  const tls = resolveRequestTls({
    requestUrl: 'http+unix://%2Frun%2Fturbopanel%2Finstance.sock/',
    runtime: 'deno',
  })
  // http+unix is neither http: nor https: — safe default is the HTTP cookie.
  assertEquals(tls.isHttps, false)
  assertEquals(tls.cookieName, HTTP_SESSION_COOKIE_NAME)
})

it('resolveTrustedProxyRequestTls honors the forwarded scheme over the request URL', () => {
  const tls = resolveTrustedProxyRequestTls(
    'http://127.0.0.1/api',
    'https',
  )
  assertEquals(tls.isHttps, true)
  assertEquals(tls.cookieName, HTTPS_SESSION_COOKIE_NAME)
})

it('resolveTrustedProxyRequestTls falls back to URL parsing for an unrecognized forwarded value', () => {
  const tls = resolveTrustedProxyRequestTls(
    'https://127.0.0.1/api',
    'garbage',
  )
  assertEquals(tls.isHttps, true)
  assertEquals(tls.cookieName, HTTPS_SESSION_COOKIE_NAME)
})

it('resolveRequestTlsFromUrl never consults a header', () => {
  assertEquals(
    resolveRequestTlsFromUrl('https://panel.example.com/').cookieName,
    HTTPS_SESSION_COOKIE_NAME,
  )
  assertEquals(
    resolveRequestTlsFromUrl('http://localhost:8880/').cookieName,
    HTTP_SESSION_COOKIE_NAME,
  )
})

it('resolveSessionCookieNameFromUrl derives the name from the URL scheme', () => {
  assertEquals(
    resolveSessionCookieNameFromUrl('https://panel.example.com/'),
    HTTPS_SESSION_COOKIE_NAME,
  )
  assertEquals(
    resolveSessionCookieNameFromUrl('http://localhost/'),
    HTTP_SESSION_COOKIE_NAME,
  )
})

it('resolveRequestTlsFromUrl defaults to the HTTP cookie for an unparseable URL', () => {
  assertEquals(
    resolveRequestTlsFromUrl('not a url').cookieName,
    HTTP_SESSION_COOKIE_NAME,
  )
})

it('generateSessionToken returns a non-empty base64url string', () => {
  const token = generateSessionToken()
  assertEquals(token.length > 0, true)
  assertEquals(/^[A-Za-z0-9_-]+$/.test(token), true)
  assertEquals(generateSessionToken() === token, false)
})

it('buildSignedCookie / verifySignedCookie round-trip with the current key', async () => {
  const secrets = await sessionSigningSecrets()
  const token = generateSessionToken()
  const cookie = await buildSignedCookie(token, secrets)
  const verified = await verifySignedCookie(cookie, secrets)
  assertEquals(verified, { token, rotated: false })
})

it('verifySignedCookie accepts a fallback key and marks rotation', async () => {
  const secrets = await sessionSigningSecrets()
  const v1Only = parseSecretsEnv(`1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    'deno')
  const v1Secrets = await deriveSecretsConfig(v1Only, 'session-signing')
  const token = generateSessionToken()
  const cookie = await buildSignedCookie(token, v1Secrets)
  const verified = await verifySignedCookie(cookie, secrets)
  assertEquals(verified?.token, token)
  assertEquals(verified?.rotated, true)
})

it('verifySignedCookie rejects malformed and tampered cookies', async () => {
  const secrets = await sessionSigningSecrets()
  assertEquals(await verifySignedCookie('', secrets), null)
  assertEquals(await verifySignedCookie('only-two.parts', secrets), null)
  assertEquals(
    await verifySignedCookie('tpsession.vabc.token.sig', secrets),
    null,
  )
  assertEquals(
    await verifySignedCookie('tpsession.v99.token.nope', secrets),
    null,
  )
  assertEquals(
    await verifySignedCookie('tpsecret.v1.token.sig', secrets),
    null,
  )
  assertEquals(
    await verifySignedCookie('tpsession.v1.only-one-field', secrets),
    null,
  )

  const token = generateSessionToken()
  const cookie = await buildSignedCookie(token, secrets)
  // tpsession.vN.<token>.<sig> — indices [2]=token, [3]=sig
  const parts = cookie.split('.')
  const cookieToken = parts[2]!
  const versionToken = parts[1]!
  const sig = parts[3]!
  assertEquals(
    await verifySignedCookie(
      `tpsession.${versionToken}.${cookieToken}.tampered`,
      secrets,
    ),
    null,
  )
  assertEquals(
    await verifySignedCookie(`tpsession.v0.${cookieToken}.${sig}`, secrets),
    null,
  )
  // Old <token>.v1.<sig> shape must be rejected (no back-compat).
  assertEquals(
    await verifySignedCookie(`${cookieToken}.${versionToken}.${sig}`, secrets),
    null,
  )
})

it('verifySignedCookie uses the XOR fallback when timingSafeEqual is unavailable', async () => {
  const secrets = await sessionSigningSecrets()
  const token = generateSessionToken()
  const cookie = await buildSignedCookie(token, secrets)

  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean
  }
  const saved = subtle.timingSafeEqual
  try {
    subtle.timingSafeEqual = undefined
    const verified = await verifySignedCookie(cookie, secrets)
    assertEquals(verified, { token, rotated: false })
    const parts = cookie.split('.')
    const cookieToken = parts[2]!
    const versionToken = parts[1]!
    assertEquals(
      await verifySignedCookie(
        `tpsession.${versionToken}.${cookieToken}.bad-signature-value`,
        secrets,
      ),
      null,
    )
  } finally {
    subtle.timingSafeEqual = saved
  }
})
