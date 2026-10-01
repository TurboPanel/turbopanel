import { assertEquals } from '@std/assert'
import {
  edictConsistencyError,
  formatStoredAddress,
  parseEdictCreate,
  parseEdictPatch,
} from './edict-input.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const ALLOW_HTTPS = {
  label: 'Allow HTTPS',
  scope: 'host',
  action: 'accept',
  proto: 'tcp',
  ports: '443',
  sourceKind: 'any',
}

test('a complete allow rule parses with defaults filled in', () => {
  const parsed = parseEdictCreate(ALLOW_HTTPS)
  assertEquals(parsed, {
    ok: true,
    values: {
      label: 'Allow HTTPS',
      scope: 'host',
      action: 'accept',
      proto: 'tcp',
      ports: '443',
      sourceKind: 'any',
      sourceAddresses: [],
      isEnabled: true,
      serverId: null,
    },
  })
})

test('ports are normalised and a degenerate range collapses to one port', () => {
  const range = parseEdictCreate({ ...ALLOW_HTTPS, ports: ' 5432-5440 ' })
  assertEquals(range.ok && range.values.ports, '5432-5440')
  const single = parseEdictCreate({ ...ALLOW_HTTPS, ports: '8443-8443' })
  assertEquals(single.ok && single.values.ports, '8443')
})

test('ports outside 1-65535, descending ranges and non-strings are refused', () => {
  for (const ports of ['0', '65536', '70000', '90-80', 'http', '', '80,443', 443, ['80']]) {
    assertEquals(parseEdictCreate({ ...ALLOW_HTTPS, ports }).ok, false, JSON.stringify(ports))
  }
})

test('an addresses source needs valid addresses and takes bare IPs as /32 and /128', () => {
  const ok = parseEdictCreate({
    ...ALLOW_HTTPS,
    sourceKind: 'addresses',
    sourceAddresses: ['192.0.2.9', '2001:db8::1', '10.0.0.0/8', '192.0.2.9'],
  })
  assertEquals(ok.ok && ok.values.sourceAddresses, [
    '192.0.2.9/32',
    '2001:db8::1/128',
    '10.0.0.0/8',
  ])
  for (const sourceAddresses of [
    [],
    ['nope'],
    ['any'],
    ['10.0.0.0/33'],
    'x',
    Array.from({ length: 257 }, (_, i) => `10.0.${i >> 8}.${i & 255}`),
  ]) {
    assertEquals(
      parseEdictCreate({ ...ALLOW_HTTPS, sourceKind: 'addresses', sourceAddresses }).ok,
      false,
      JSON.stringify(sourceAddresses).slice(0, 60)
    )
  }
})

test('addresses are refused for every other source kind', () => {
  const parsed = parseEdictCreate({
    ...ALLOW_HTTPS,
    sourceKind: 'fabric',
    sourceAddresses: ['10.0.0.1'],
  })
  assertEquals(parsed.ok, false)
})

test('a block may say every port; an allow may not', () => {
  const block = parseEdictCreate({
    label: 'Block all',
    scope: 'host',
    action: 'drop',
    proto: 'any',
    sourceKind: 'any',
  })
  assertEquals(block.ok && block.values.ports, null)
  const allow = { label: 'x', scope: 'host', action: 'accept', proto: 'tcp', sourceKind: 'any' }
  assertEquals(parseEdictCreate(allow).ok, false)
})

test('ports need tcp or udp', () => {
  assertEquals(parseEdictCreate({ ...ALLOW_HTTPS, proto: 'any', action: 'drop' }).ok, false)
})

test('labels follow the wire comment alphabet', () => {
  for (const label of ['', 'a'.repeat(49), 'semi;colon', 'new\nline', 'quote"', 'tab\t', 5]) {
    assertEquals(parseEdictCreate({ ...ALLOW_HTTPS, label }).ok, false, JSON.stringify(label))
  }
  assertEquals(parseEdictCreate({ ...ALLOW_HTTPS, label: 'a'.repeat(48) }).ok, true)
  assertEquals(parseEdictCreate({ ...ALLOW_HTTPS, label: 'db: 5432/tcp - office_vpn.1' }).ok, true)
})

test('unknown enum members and missing required fields are refused', () => {
  for (const patch of [
    { scope: 'both' },
    { action: 'allow' },
    { proto: 'icmp' },
    { sourceKind: 'everyone' },
    { isEnabled: 'yes' },
    { serverId: 5 },
  ]) {
    assertEquals(parseEdictCreate({ ...ALLOW_HTTPS, ...patch }).ok, false, JSON.stringify(patch))
  }
  for (const key of ['label', 'scope', 'action', 'proto', 'sourceKind']) {
    const { [key]: _omitted, ...rest } = ALLOW_HTTPS as Record<string, unknown>
    assertEquals(parseEdictCreate(rest).ok, false, key)
  }
  assertEquals(parseEdictCreate(null).ok, false)
  assertEquals(parseEdictCreate([]).ok, false)
})

test('a patch carries only the fields present, and ports may be cleared with null', () => {
  assertEquals(parseEdictPatch({ isEnabled: false }), { ok: true, values: { isEnabled: false } })
  assertEquals(parseEdictPatch({ ports: null }), { ok: true, values: { ports: null } })
  assertEquals(parseEdictPatch({}).ok, false)
  assertEquals(parseEdictPatch({ ports: '99999' }).ok, false)
})

test('the consistency check names the broken rule in plain words', () => {
  const base = {
    label: 'x',
    scope: 'host' as const,
    action: 'accept' as const,
    proto: 'tcp' as const,
    ports: '22',
    sourceKind: 'any' as const,
    sourceAddresses: [],
    isEnabled: true,
    serverId: null,
  }
  assertEquals(edictConsistencyError(base), null)
  assertEquals(edictConsistencyError({ ...base, ports: null }), 'an allow rule must name its ports')
  assertEquals(
    edictConsistencyError({ ...base, proto: 'any' }),
    'ports need a protocol of tcp or udp'
  )
  assertEquals(
    edictConsistencyError({ ...base, sourceKind: 'addresses' }),
    'sourceAddresses is required for the addresses source'
  )
})

test('Postgres prints a lone host without its mask; the API puts it back', () => {
  assertEquals(formatStoredAddress('192.0.2.9'), '192.0.2.9/32')
  assertEquals(formatStoredAddress('2001:db8::1'), '2001:db8::1/128')
  assertEquals(formatStoredAddress('10.0.0.0/8'), '10.0.0.0/8')
  assertEquals(formatStoredAddress('2001:db8::/32'), '2001:db8::/32')
})
