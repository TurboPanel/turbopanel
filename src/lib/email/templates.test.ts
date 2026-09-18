import { assertEquals } from '@std/assert'
import {
  createEmailOtpEmail,
  createEmailVerificationLinkEmail,
  createInvitationEmail,
  createNotificationEmail,
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

test('createInvitationEmail escapes interpolated fields and sets the subject', () => {
  const { subject, html, text } = createInvitationEmail({
    type: 'invitation',
    to: 'invitee@example.com',
    from: 'noreply@example.com',
    inviterEmail: 'owner@<org>.example',
    organizationName: 'Acme <script>',
    teamName: 'Ops & "Core"',
    acceptUrl: 'https://example.com/accept-invitation?id=<script>',
  })
  assertEquals(subject, "You've been invited to Acme <script> on TurboPanel")
  assertEquals(html.includes('<script>'), false)
  assertEquals(html.includes('&lt;script&gt;'), true)
  assertEquals(html.includes('&amp;'), true)
  assertEquals(html.includes('&quot;'), true)
  assertEquals(html.includes('owner@&lt;org&gt;.example'), true)
  assertEquals(text.includes('Acme <script>'), true)
  assertEquals(text.includes('https://example.com/accept-invitation?id=<script>'), true)
})

test('createNotificationEmail carries the severity in the subject and escapes every field', () => {
  const { subject, html, text } = createNotificationEmail({
    type: 'notification',
    to: 'ops@example.com',
    from: 'noreply@example.com',
    event: 'server.offline',
    severity: 'critical',
    title: 'Server <db-1> went offline',
    body: 'Stopped & gone.',
    details: ['serverName=<db-1>'],
    organizationName: 'Acme "Inc"',
    consoleUrl: 'https://panel.example.com/org/servers/s1?x=<y>',
    at: '2026-09-18T10:00:00.000Z',
  })
  assertEquals(subject, '[TurboPanel Critical] Server <db-1> went offline')
  assertEquals(html.includes('<db-1>'), false)
  assertEquals(html.includes('&lt;db-1&gt;'), true)
  assertEquals(html.includes('&quot;Inc&quot;'), true)
  assertEquals(html.includes('Open in TurboPanel'), true)
  assertEquals(text.includes('serverName=<db-1>'), true)
  assertEquals(text.includes('Open: https://panel.example.com/org/servers/s1?x=<y>'), true)
  const bare = createNotificationEmail({
    type: 'notification',
    to: 'ops@example.com',
    from: 'noreply@example.com',
    event: 'fleet.mass_disconnect',
    severity: 'warning',
    title: '7 servers went offline in one sweep',
    body: null,
    details: [],
    organizationName: null,
    consoleUrl: null,
    at: '2026-09-18T10:00:00.000Z',
  })
  assertEquals(bare.subject, '[TurboPanel Warning] 7 servers went offline in one sweep')
  assertEquals(bare.html.includes('Open in TurboPanel'), false)
})
