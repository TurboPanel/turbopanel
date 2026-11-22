import { assertEquals } from '@std/assert'
import { deriveSecretsConfig } from '../../lib/secrets/secrets.ts'
import { parseTestSecretsConfig } from '../../test-fixtures/secrets.ts'
import { authenticateShellUpgrade, isAllowedShellOrigin } from './upgrade.ts'
import {
  SHELL_TICKET_PURPOSE,
  SHELL_TICKET_TTL_MS,
  signShellTicket,
  ticketFromProtocolHeader,
  verifyShellTicket,
} from './ticket.ts'

const test = Deno.test.bind(Deno)

const SID = '11111111-2222-4333-8444-555555555555'
const CLAIMS = {
  sid: SID,
  userId: 'user-1',
  authSessionId: 'auth-1',
  serverId: 'server-1',
  orgId: 'org-1',
}
const URL_ = 'https://panel.example.net/ws/client/shell/' + SID
const NOW = 1_700_000_000_000

const keyring = await deriveSecretsConfig(parseTestSecretsConfig('deno'), SHELL_TICKET_PURPOSE)
const otherRing = await deriveSecretsConfig(parseTestSecretsConfig('deno'), 'session-signing')

test('ticket round trip, expiry and wrong keyring', async () => {
  const { ticket, expiresAtMs } = await signShellTicket(keyring, CLAIMS, NOW)
  assertEquals(expiresAtMs, NOW + SHELL_TICKET_TTL_MS)
  assertEquals(await verifyShellTicket(keyring, ticket, NOW + 1000), { ok: true, claims: CLAIMS })
  assertEquals(await verifyShellTicket(keyring, ticket, NOW + SHELL_TICKET_TTL_MS + 1000), {
    ok: false,
    reason: 'expired',
  })
  assertEquals(await verifyShellTicket(otherRing, ticket, NOW), { ok: false, reason: 'invalid' })
})

test('ticket tampering is refused', async () => {
  const { ticket } = await signShellTicket(keyring, CLAIMS, NOW)
  const parts = ticket.split('.')
  const forged = { ...CLAIMS, userId: 'user-2', exp: Math.floor(NOW / 1000) + 30 }
  parts[2] = btoa(JSON.stringify(forged))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
  assertEquals(await verifyShellTicket(keyring, parts.join('.'), NOW), {
    ok: false,
    reason: 'invalid',
  })
  for (const bad of ['', 'x', 'tpshell.v1.a', 'other.v1.a.b']) {
    assertEquals(await verifyShellTicket(keyring, bad, NOW), { ok: false, reason: 'invalid' })
  }
})

test('protocol header: exactly the version token and one ticket', () => {
  assertEquals(ticketFromProtocolHeader('tp-shell.v1, tp-ticket.abc'), 'abc')
  assertEquals(ticketFromProtocolHeader('tp-ticket.abc,tp-shell.v1'), 'abc')
  for (const bad of [
    null,
    '',
    'tp-shell.v1',
    'tp-ticket.abc',
    'tp-shell.v1, tp-ticket.a, tp-ticket.b',
    'tp-shell.v1, tp-ticket.a, other',
    'tp-shell.v2, tp-ticket.a',
  ]) {
    assertEquals(ticketFromProtocolHeader(bad), null, String(bad))
  }
})

test('origin: same host or configured, never missing or null', () => {
  assertEquals(isAllowedShellOrigin('https://panel.example.net', URL_, []), true)
  assertEquals(
    isAllowedShellOrigin('https://ui.example.net', URL_, ['https://ui.example.net']),
    true
  )
  assertEquals(isAllowedShellOrigin('https://evil.example.org', URL_, []), false)
  assertEquals(isAllowedShellOrigin(null, URL_, []), false)
  assertEquals(isAllowedShellOrigin('null', URL_, []), false)
  assertEquals(isAllowedShellOrigin('ftp://panel.example.net', URL_, []), false)
})

test('upgrade verdicts: sid, origin, ticket, mismatch', async () => {
  const { ticket } = await signShellTicket(keyring, CLAIMS, Date.now())
  const base = {
    sid: SID,
    origin: 'https://panel.example.net',
    protocolHeader: `tp-shell.v1, tp-ticket.${ticket}`,
    requestUrl: URL_,
    configuredOrigins: [],
    keyring,
  }
  assertEquals(await authenticateShellUpgrade(base), { ok: true, claims: CLAIMS })
  assertEquals(await authenticateShellUpgrade({ ...base, sid: 'nope' }), { ok: false, status: 400 })
  assertEquals(await authenticateShellUpgrade({ ...base, origin: 'https://evil.example.org' }), {
    ok: false,
    status: 403,
  })
  assertEquals(await authenticateShellUpgrade({ ...base, protocolHeader: 'tp-shell.v1' }), {
    ok: false,
    status: 401,
  })
  assertEquals(
    await authenticateShellUpgrade({ ...base, sid: '99999999-2222-4333-8444-555555555555' }),
    { ok: false, status: 403 }
  )
  assertEquals(await authenticateShellUpgrade({ ...base, nowMs: Date.now() + 120_000 }), {
    ok: false,
    status: 401,
  })
})
