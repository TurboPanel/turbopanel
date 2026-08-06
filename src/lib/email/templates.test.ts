import { assertEquals } from '@std/assert'
import {
  createEmailOtpEmail,
  createEmailVerificationLinkEmail,
} from './templates.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('createEmailVerificationLinkEmail escapes HTML in verify URL', () => {
  const malicious = 'https://example.com/verify?x=<script>'
  const { subject, html, text } = createEmailVerificationLinkEmail(
    'user@example.com',
    malicious,
  )
  assertEquals(subject, 'Verify your TurboPanel email')
  assertEquals(html.includes('<script>'), false)
  assertEquals(html.includes('&lt;script&gt;'), true)
  assertEquals(html.includes('&quot;'), false)
  assertEquals(text.includes(malicious), true)
})

test('createEmailVerificationLinkEmail escapes quotes and ampersands in URLs', () => {
  const tricky = 'https://example.com/verify?a=1&b="2"'
  const { html } = createEmailVerificationLinkEmail('ops@example.com', tricky)
  assertEquals(html.includes('&amp;'), true)
  assertEquals(html.includes('&quot;'), true)
  assertEquals(html.includes('href="https://example.com/verify?a=1&amp;b=&quot;2&quot;"'), true)
})

test('createEmailOtpEmail covers otp types and escapes otp in HTML', () => {
  const subjects = {
    'sign-in': 'Your TurboPanel sign-in code',
    'email-verification': 'Verify your TurboPanel email',
    'forget-password': 'Reset your TurboPanel password',
  } as const

  for (const otpType of ['sign-in', 'email-verification', 'forget-password'] as const) {
    const { subject, html, text } = createEmailOtpEmail(
      'user@example.com',
      '123456',
      otpType,
    )
    assertEquals(subject, subjects[otpType])
    assertEquals(html.includes('123456'), true)
    assertEquals(text.includes('123456'), true)
    assertEquals(html.includes(subject), true)
  }

  const xss = createEmailOtpEmail('user@example.com', '<script>', 'sign-in')
  assertEquals(xss.html.includes('<script>'), false)
  assertEquals(xss.html.includes('&lt;script&gt;'), true)
  assertEquals(xss.text.includes('<script>'), true)
})
