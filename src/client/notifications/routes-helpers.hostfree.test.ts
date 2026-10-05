import { assertEquals } from '@std/assert'
import { parseChannelCreateBody } from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const OPTS = { allowPrivateTargets: true }

function email(label: string, address = 'ops@example.org') {
  return parseChannelCreateBody({ kind: 'email', label, address }, OPTS)
}

test('an email channel address is stored as one bare address', async () => {
  const ok = await email('Pager', 'Ops <ops@example.org>')
  assertEquals(ok.ok && ok.value.address, 'ops@example.org')
  for (const address of ['a@example.org, b@example.org', 'a@example.org\nb@example.org']) {
    const refused = await email('Pager', address)
    assertEquals(refused.ok, false, address)
  }
})

test('an email channel label is a short plain name, never a link or an address', async () => {
  for (const label of ['Pager', 'Ops (night) - EU', 'Team A & B', 'On call 24/7']) {
    assertEquals((await email(label)).ok, true, label)
  }
  for (const label of [
    'Your bank account is locked: https://evil.example/login',
    'visit evil.example now',
    'www.evil.example',
    'mail me at a@evil.example',
    'a'.repeat(41),
    'Line\nbreak',
    'Click <b>here</b>',
    '"quoted"',
  ]) {
    const refused = await email(label)
    assertEquals(refused.ok ? 'accepted' : refused.error, 'label_invalid', label)
  }
})

test('other channel kinds keep the wider label rule', async () => {
  const slack = await parseChannelCreateBody(
    {
      kind: 'slack',
      label: 'Ops: #alerts, "prod" (eu) — see runbook',
      address: 'https://hooks.example.org/x',
    },
    OPTS
  )
  assertEquals(slack.ok, true)
})
