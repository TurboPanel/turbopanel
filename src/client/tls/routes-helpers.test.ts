import { assertEquals } from 'jsr:@std/assert'
import {
  applyTlsOptionsPatch,
  createFailure,
  isCreateTlsFailure,
  isOrganizationCaUniqueViolation,
  isTlsFingerprintUniqueViolation,
  materialFromLetsEncrypt,
  parseHostnames,
  parseSource,
  withPreferOption,
} from './routes-helpers.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseSource accepts tls source tokens', () => {
  assertEquals(parseSource('upload'), 'upload')
  assertEquals(parseSource('self_signed'), 'self_signed')
  assertEquals(parseSource('lets_encrypt'), 'lets_encrypt')
  assertEquals(parseSource('organization_ca'), 'organization_ca')
  assertEquals(parseSource('acme'), null)
  assertEquals(parseSource(1), null)
})

test('parseHostnames normalizes and rejects empty lists', () => {
  assertEquals(parseHostnames([' Example.COM ', '']), ['example.com'])
  assertEquals(parseHostnames(['*.Wild.example']), ['*.wild.example'])
  assertEquals(parseHostnames([]), null)
  assertEquals(parseHostnames('host'), null)
})

test('createFailure and isCreateTlsFailure discriminate results', () => {
  const failure = createFailure('Invalid request')
  assertEquals(failure, { error: 'Invalid request', status: 400 })
  assertEquals(createFailure('Invalid request', 'more'), {
    error: 'Invalid request',
    detail: 'more',
    status: 400,
  })
  assertEquals(isCreateTlsFailure(failure), true)
  assertEquals(
    isCreateTlsFailure({
      certificatePem: 'pem',
      privateKeyPemSealed: null,
      metadata: {} as never,
      options: null,
    }),
    false,
  )
})

test('isTlsFingerprintUniqueViolation matches org fingerprint index', () => {
  const match = Object.assign(
    new Error('duplicate key value violates unique constraint "uniq_tls_organization_fingerprint_sha256"'),
    { code: '23505' },
  )
  assertEquals(isTlsFingerprintUniqueViolation(match), true)
  assertEquals(
    isTlsFingerprintUniqueViolation(
      Object.assign(new Error('uniq_tls_organization_fingerprint_sha256'), {
        code: '23505',
      }),
    ),
    true,
  )
  assertEquals(isTlsFingerprintUniqueViolation({ code: '23505' }), false)
  assertEquals(isTlsFingerprintUniqueViolation(new Error('other')), false)
  assertEquals(isTlsFingerprintUniqueViolation(null), false)
})

test('isOrganizationCaUniqueViolation matches active CA index', () => {
  const match = Object.assign(
    new Error('duplicate key value violates unique constraint "uniq_tls_organization_active_ca"'),
    { code: '23505' },
  )
  assertEquals(isOrganizationCaUniqueViolation(match), true)
  assertEquals(isOrganizationCaUniqueViolation({ code: '23505' }), false)
  assertEquals(isOrganizationCaUniqueViolation(new Error('other')), false)
  assertEquals(isOrganizationCaUniqueViolation(null), false)
})

test('materialFromLetsEncrypt builds pending metadata', () => {
  const material = materialFromLetsEncrypt({
    hostnames: ['LE.example.com', '*.Example.com'],
    challengeType: 'dns-01',
    autoRenew: false,
  })
  if (isCreateTlsFailure(material)) {
    throw new TypeError('expected success material')
  }
  assertEquals(material.certificatePem, null)
  assertEquals(material.metadata.status, 'pending')
  assertEquals(material.metadata.dnsNames, ['le.example.com', '*.example.com'])
  assertEquals(material.metadata.hasWildcard, true)
  assertEquals(material.metadata.acme?.challengeType, 'dns-01')
  assertEquals(material.options?.autoRenew, false)
})

test('materialFromLetsEncrypt defaults challengeType and autoRenew', () => {
  const material = materialFromLetsEncrypt({
    hostnames: ['app.example.com'],
  })
  if (isCreateTlsFailure(material)) {
    throw new TypeError('expected success material')
  }
  assertEquals(material.metadata.acme?.challengeType, 'http-01')
  assertEquals(material.options?.autoRenew, true)
})

test('materialFromLetsEncrypt rejects missing hostnames', () => {
  const material = materialFromLetsEncrypt({})
  assertEquals(isCreateTlsFailure(material), true)
  if (!isCreateTlsFailure(material)) {
    throw new TypeError('expected failure material')
  }
  assertEquals(material.error, 'Invalid request')
})

test('withPreferOption merges finite prefer values only', () => {
  assertEquals(withPreferOption(null, 2), { prefer: 2 })
  assertEquals(withPreferOption({ autoRenew: true }, 3), {
    autoRenew: true,
    prefer: 3,
  })
  assertEquals(withPreferOption({ prefer: 1 }, 'nope'), { prefer: 1 })
})

test('applyTlsOptionsPatch updates prefer and autoRenew', () => {
  const cleared = applyTlsOptionsPatch({ prefer: 1, autoRenew: true }, { prefer: null })
  if (!cleared.ok) throw new TypeError('expected ok patch')
  assertEquals(cleared.changed, true)
  assertEquals('prefer' in cleared.options, false)

  const invalidPrefer = applyTlsOptionsPatch({}, { prefer: 'x' })
  assertEquals(invalidPrefer.ok, false)

  const invalidAutoRenew = applyTlsOptionsPatch({}, { autoRenew: 'yes' })
  assertEquals(invalidAutoRenew.ok, false)

  const setPrefer = applyTlsOptionsPatch({}, { prefer: 5 })
  if (!setPrefer.ok) throw new TypeError('expected ok patch')
  assertEquals(setPrefer.options.prefer, 5)
  assertEquals(setPrefer.changed, true)

  const unchanged = applyTlsOptionsPatch({ prefer: 1 }, {})
  if (!unchanged.ok) throw new TypeError('expected ok patch')
  assertEquals(unchanged.changed, false)

  const toggled = applyTlsOptionsPatch({}, { autoRenew: false })
  if (!toggled.ok) throw new TypeError('expected ok patch')
  assertEquals(toggled.options.autoRenew, false)
})
