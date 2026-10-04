import { assertEquals } from '@std/assert'
import {
  DEFAULT_FIREWALL_ORG_POLICY,
  mergeFirewallPolicyIntoOptions,
  parseFirewallOrgPolicy,
  parseFirewallPolicyPatch,
  sshSourcesExcludeAddress,
} from './policy.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('an organization with no firewall options gets the observe-friendly defaults', () => {
  assertEquals(parseFirewallOrgPolicy(null), DEFAULT_FIREWALL_ORG_POLICY)
  assertEquals(parseFirewallOrgPolicy({}), DEFAULT_FIREWALL_ORG_POLICY)
  assertEquals(parseFirewallOrgPolicy({ firewall: 'nonsense' }), DEFAULT_FIREWALL_ORG_POLICY)
  assertEquals(DEFAULT_FIREWALL_ORG_POLICY.inputDefault, 'accept')
})

test('stored values are read back, and malformed ones fall back to the defaults', () => {
  const policy = parseFirewallOrgPolicy({
    firewall: {
      inputDefault: 'drop',
      ipv6: 'skip',
      sshSources: ['10.0.0.0/8', '203.0.113.7', 'nope'],
    },
  })
  assertEquals(policy, {
    inputDefault: 'drop',
    ipv6: 'skip',
    sshSources: ['10.0.0.0/8', '203.0.113.7/32'],
  })
  assertEquals(
    parseFirewallOrgPolicy({ firewall: { inputDefault: 'maybe', sshSources: ['nope'] } }),
    DEFAULT_FIREWALL_ORG_POLICY
  )
})

test('a patch changes only the fields present and normalises addresses', () => {
  const parsed = parseFirewallPolicyPatch({ sshSources: ['198.51.100.4', '10.0.0.0/8'] })
  assertEquals(parsed, { ok: true, patch: { sshSources: ['198.51.100.4/32', '10.0.0.0/8'] } })
  assertEquals(parseFirewallPolicyPatch({ inputDefault: 'drop' }), {
    ok: true,
    patch: { inputDefault: 'drop' },
  })
})

test('a patch refuses bad values and an empty body', () => {
  for (const body of [
    {},
    null,
    [],
    { inputDefault: 'block' },
    { ipv6: true },
    { sshSources: [] },
    { sshSources: ['not-an-address'] },
    { sshSources: ['any', '10.0.0.0/8'] },
    { sshSources: 'any' },
  ]) {
    assertEquals(parseFirewallPolicyPatch(body).ok, false, JSON.stringify(body))
  }
})

test('merging keeps the other option keys and the other policy fields', () => {
  const merged = mergeFirewallPolicyIntoOptions(
    { sshPort: 2222, firewall: { inputDefault: 'drop', ipv6: 'skip', sshSources: ['any'] } },
    { ipv6: 'mirror' }
  )
  assertEquals(merged, {
    sshPort: 2222,
    firewall: { inputDefault: 'drop', ipv6: 'mirror', sshSources: ['any'] },
  })
  assertEquals(mergeFirewallPolicyIntoOptions(null, { inputDefault: 'drop' }), {
    firewall: { inputDefault: 'drop', ipv6: 'mirror', sshSources: ['any'] },
  })
})

test('the lockout guard flags a narrowed list that leaves out the caller', () => {
  assertEquals(sshSourcesExcludeAddress(['203.0.113.0/24'], '198.51.100.4'), true)
  assertEquals(sshSourcesExcludeAddress(['203.0.113.0/24'], '203.0.113.9'), false)
  assertEquals(sshSourcesExcludeAddress(['10.0.0.0/8', '203.0.113.9/32'], '203.0.113.9'), false)
  assertEquals(sshSourcesExcludeAddress(['203.0.113.0/24'], '2001:db8::1'), true)
  assertEquals(sshSourcesExcludeAddress(['any'], '198.51.100.4'), false)
  assertEquals(sshSourcesExcludeAddress(['203.0.113.0/24'], null), false)
})
