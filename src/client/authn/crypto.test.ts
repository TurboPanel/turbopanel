import { assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  buildSignedCookie,
  generateSessionToken,
  HTTP_SESSION_COOKIE_NAME,
  HTTPS_SESSION_COOKIE_NAME,
  LEGACY_HTTPS_SESSION_COOKIE_NAME,
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

async function sessionSigningSecrets() {
  const config = parseSecretsEnv(
    undefined,
    `2:${V2_SECRET},1:${TEST_ONLY_TURBOPANEL_SECRET}`,
    'deno',
  )
  return deriveSecretsConfig(config, 'session-signing')
}

describe('HTTPS session cookie name', () => {
  it('uses the __Host- prefix (not the retired __Secure- name)', () => {
    assertEquals(HTTPS_SESSION_COOKIE_NAME, '__Host-turbopanel.session_token')
    assertEquals(
      LEGACY_HTTPS_SESSION_COOKIE_NAME,
      '__Secure-turbopanel.session_token',
    )
  })
})

describe('resolveRequestTls (Workers — URL-derived, header untrusted)', () => {
  it('ignores a spoofed X-Forwarded-Proto: http on an HTTPS request', () => {
    const tls = resolveRequestTls({
      requestUrl: 'https://panel.example.com/api/client/v1/auth/sign-in',
      runtime: 'workers',
      forwardedProto: 'http',
    })
    assertEquals(tls.isHttps, true)
    assertEquals(tls.cookieName, HTTPS_SESSION_COOKIE_NAME)
  })

  it('cannot produce the HTTP cookie name via a spoofed header', () => {
    const cookieName = resolveSessionCookieName({
      requestUrl: 'https://panel.example.com/',
      runtime: 'workers',
      forwardedProto: 'http',
    })
    assertEquals(cookieName, HTTPS_SESSION_COOKIE_NAME)
  })

  it('derives HTTPS state from the URL when no header is present', () => {
    const tls = resolveRequestTls({
      requestUrl: 'https://panel.example.com/',
      runtime: 'workers',
    })
    assertEquals(tls.isHttps, true)
    assertEquals(tls.cookieName, HTTPS_SESSION_COOKIE_NAME)
  })

  it('serves the HTTP cookie for genuine plaintext HTTP requests', () => {
    const tls = resolveRequestTls({
      requestUrl: 'http://localhost:8880/',
      runtime: 'workers',
      forwardedProto: 'https',
    })
    // Spoofed https header does not upgrade a genuine plaintext request either.
    assertEquals(tls.isHttps, false)
    assertEquals(tls.cookieName, HTTP_SESSION_COOKIE_NAME)
  })
})

describe('resolveRequestTls (Deno trusted proxy — honors X-Forwarded-Proto)', () => {
  it('treats an http+unix request with X-Forwarded-Proto: https as HTTPS', () => {
    const tls = resolveRequestTls({
      requestUrl: 'http+unix://%2Frun%2Fturbopanel%2Finstance.sock/api/client/v1/auth/sign-in',
      runtime: 'deno',
      forwardedProto: 'https',
    })
    assertEquals(tls.isHttps, true)
    assertEquals(tls.cookieName, HTTPS_SESSION_COOKIE_NAME)
  })

  it('treats an http+unix request with X-Forwarded-Proto: http as HTTP', () => {
    const tls = resolveRequestTls({
      requestUrl: 'http+unix://%2Frun%2Fturbopanel%2Finstance.sock/',
      runtime: 'deno',
      forwardedProto: 'http',
    })
    assertEquals(tls.isHttps, false)
    assertEquals(tls.cookieName, HTTP_SESSION_COOKIE_NAME)
  })

  it('falls back to the URL when no forwarded header is set', () => {
    const tls = resolveRequestTls({
      requestUrl: 'http+unix://%2Frun%2Fturbopanel%2Finstance.sock/',
      runtime: 'deno',
    })
    // http+unix is neither http: nor https: — safe default is the HTTP cookie.
    assertEquals(tls.isHttps, false)
    assertEquals(tls.cookieName, HTTP_SESSION_COOKIE_NAME)
  })
})

describe('resolveTrustedProxyRequestTls (Deno-only entrypoint helper)', () => {
  it('honors the forwarded scheme over the request URL', () => {
    const tls = resolveTrustedProxyRequestTls(
      'http://127.0.0.1/api',
      'https',
    )
    assertEquals(tls.isHttps, true)
    assertEquals(tls.cookieName, HTTPS_SESSION_COOKIE_NAME)
  })

  it('falls back to URL parsing for an unrecognized forwarded value', () => {
    const tls = resolveTrustedProxyRequestTls(
      'https://127.0.0.1/api',
      'garbage',
    )
    assertEquals(tls.isHttps, true)
    assertEquals(tls.cookieName, HTTPS_SESSION_COOKIE_NAME)
  })
})

describe('URL-only helpers (docs / OpenAPI)', () => {
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

  it('defaults to the HTTP cookie for an unparseable URL', () => {
    assertEquals(
      resolveRequestTlsFromUrl('not a url').cookieName,
      HTTP_SESSION_COOKIE_NAME,
    )
  })
})

describe('session cookie signing', () => {
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
    const v1Only = parseSecretsEnv(
      TEST_ONLY_TURBOPANEL_SECRET,
      undefined,
      'deno',
    )
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
      await verifySignedCookie('token.vabc.sig', secrets),
      null,
    )
    assertEquals(
      await verifySignedCookie('token.v99.nope', secrets),
      null,
    )

    const token = generateSessionToken()
    const cookie = await buildSignedCookie(token, secrets)
    const [, version, sig] = cookie.split('.')
    assertEquals(
      await verifySignedCookie(`${token}.${version}.tampered`, secrets),
      null,
    )
    assertEquals(
      await verifySignedCookie(`${token}.v0.${sig}`, secrets),
      null,
    )
  })

  it('uses the XOR fallback when timingSafeEqual is unavailable', async () => {
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
      const [, version, sig] = cookie.split('.')
      assertEquals(
        await verifySignedCookie(`${token}.${version}.bad-signature-value`, secrets),
        null,
      )
    } finally {
      subtle.timingSafeEqual = saved
    }
  })
})
