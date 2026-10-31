import { assertEquals } from '@std/assert'
import {
  isUnlimitedMaxServers,
  normalizeAcmeContactEmail,
  parseDefaultEnvironmentNameInput,
  parseMaxServersInput,
  parseOrganizationOptions,
  parseTemperatureUnitInput,
  resolveAcmeContactEmail,
  resolveComposeDefaultResourceLimits,
  resolveDefaultEnvironmentName,
  resolveDeployHooksEnabled,
  resolveDeployTimeoutMs,
  resolvePrincipalNamePolicy,
  resolveRandomizedPrincipalUsernames,
  resolveTemperatureUnit,
} from './organization-options.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseOrganizationOptions returns empty object for non-records', () => {
  assertEquals(parseOrganizationOptions(null), {})
  assertEquals(parseOrganizationOptions([]), {})
})

test('parseOrganizationOptions reads timezone, maxServers, and host defaults', () => {
  const options = parseOrganizationOptions({
    defaultServerTimezone: ' America/Chicago ',
    enforceServerTimezone: true,
    maxServers: 5,
    sshPort: 2222,
    ntp: { enabled: true, servers: ['time.cloudflare.com'] },
    defaultFabricEnabled: true,
    hideWebServerNames: false,
  })
  assertEquals(options.hideWebServerNames, false)
  assertEquals(parseOrganizationOptions({ hideWebServerNames: null }).hideWebServerNames, undefined)
  assertEquals(options.defaultServerTimezone, 'America/Chicago')
  assertEquals(options.enforceServerTimezone, true)
  assertEquals(options.maxServers, 5)
  assertEquals(options.sshPort, 2222)
  assertEquals(options.ntp, {
    enabled: true,
    servers: ['time.cloudflare.com'],
  })
  assertEquals(options.defaultFabricEnabled, true)
})

test('parseOrganizationOptions treats null maxServers as unlimited sentinel', () => {
  const options = parseOrganizationOptions({ maxServers: null })
  assertEquals(options.maxServers, null)
  assertEquals(isUnlimitedMaxServers(options.maxServers), true)
})

test('parseOrganizationOptions ignores invalid maxServers', () => {
  assertEquals(parseOrganizationOptions({ maxServers: -1 }).maxServers, undefined)
  assertEquals(parseOrganizationOptions({ maxServers: 1.5 }).maxServers, undefined)
  assertEquals(parseOrganizationOptions({ maxServers: '3' }).maxServers, undefined)
})

test('parseOrganizationOptions trims defaultEnvironmentName and omits blank', () => {
  assertEquals(
    parseOrganizationOptions({ defaultEnvironmentName: ' Staging ' }).defaultEnvironmentName,
    'Staging'
  )
  assertEquals(
    parseOrganizationOptions({ defaultEnvironmentName: '   ' }).defaultEnvironmentName,
    undefined
  )
  assertEquals(
    parseOrganizationOptions({ defaultEnvironmentName: 12 }).defaultEnvironmentName,
    undefined
  )
  assertEquals(
    parseOrganizationOptions({ defaultEnvironmentName: null }).defaultEnvironmentName,
    undefined
  )
})

test('parseMaxServersInput accepts zero and rejects negatives', () => {
  assertEquals(parseMaxServersInput(0), { ok: true, value: 0 })
  assertEquals(parseMaxServersInput(null), { ok: true, value: null })
  assertEquals(parseMaxServersInput(-1).ok, false)
})

test('parseDefaultEnvironmentNameInput accepts folder-safe names and resets', () => {
  assertEquals(parseDefaultEnvironmentNameInput('staging'), {
    ok: true,
    value: 'staging',
  })
  assertEquals(parseDefaultEnvironmentNameInput(' live_env-2 '), {
    ok: true,
    value: 'live_env-2',
  })
  assertEquals(parseDefaultEnvironmentNameInput(null), {
    ok: true,
    value: null,
  })
})

test('parseDefaultEnvironmentNameInput rejects names that cannot be a folder', () => {
  assertEquals(parseDefaultEnvironmentNameInput(12).ok, false)
  assertEquals(parseDefaultEnvironmentNameInput('').ok, false)
  assertEquals(parseDefaultEnvironmentNameInput('   ').ok, false)
  assertEquals(parseDefaultEnvironmentNameInput('Staging').ok, false)
  assertEquals(parseDefaultEnvironmentNameInput('live env').ok, false)
  assertEquals(parseDefaultEnvironmentNameInput('bad/name').ok, false)
  assertEquals(parseDefaultEnvironmentNameInput('bad\nname').ok, false)
  assertEquals(parseDefaultEnvironmentNameInput('common').ok, false)
  assertEquals(parseDefaultEnvironmentNameInput('a'.repeat(33)).ok, false)
})

test('resolveDefaultEnvironmentName ignores a saved value that is not a valid name', () => {
  assertEquals(resolveDefaultEnvironmentName({ defaultEnvironmentName: 'staging' }), 'staging')
  assertEquals(resolveDefaultEnvironmentName({ defaultEnvironmentName: 'My Env' }), 'production')
  assertEquals(resolveDefaultEnvironmentName({}), 'production')
})

test('isUnlimitedMaxServers for omitted and null', () => {
  assertEquals(isUnlimitedMaxServers(undefined), true)
  assertEquals(isUnlimitedMaxServers(null), true)
  assertEquals(isUnlimitedMaxServers(0), false)
  assertEquals(isUnlimitedMaxServers(2), false)
})

test('parseOrganizationOptions reads temperatureUnit and ignores invalid values', () => {
  assertEquals(
    parseOrganizationOptions({ temperatureUnit: 'fahrenheit' }).temperatureUnit,
    'fahrenheit'
  )
  assertEquals(parseOrganizationOptions({ temperatureUnit: 'kelvin' }).temperatureUnit, undefined)
  assertEquals(parseOrganizationOptions({ temperatureUnit: 42 }).temperatureUnit, undefined)
})

test('parseTemperatureUnitInput accepts celsius/fahrenheit and rejects everything else', () => {
  assertEquals(parseTemperatureUnitInput('celsius'), {
    ok: true,
    value: 'celsius',
  })
  assertEquals(parseTemperatureUnitInput('fahrenheit'), {
    ok: true,
    value: 'fahrenheit',
  })
  assertEquals(parseTemperatureUnitInput('kelvin').ok, false)
  assertEquals(parseTemperatureUnitInput(null).ok, false)
  assertEquals(parseTemperatureUnitInput(undefined).ok, false)
})

test('resolveTemperatureUnit defaults to celsius', () => {
  assertEquals(resolveTemperatureUnit({}), 'celsius')
  assertEquals(resolveTemperatureUnit({ temperatureUnit: 'fahrenheit' }), 'fahrenheit')
})

Deno.test('randomizedPrincipalUsernames parses and defaults to on', () => {
  assertEquals(
    parseOrganizationOptions({ randomizedPrincipalUsernames: false }).randomizedPrincipalUsernames,
    false
  )
  assertEquals(
    parseOrganizationOptions({ randomizedPrincipalUsernames: 'no' }).randomizedPrincipalUsernames,
    undefined
  )
  assertEquals(resolveRandomizedPrincipalUsernames({}), true)
  assertEquals(
    resolveRandomizedPrincipalUsernames({
      randomizedPrincipalUsernames: false,
    }),
    false
  )
  assertEquals(resolveRandomizedPrincipalUsernames({ randomizedPrincipalUsernames: true }), true)
})

test('principal name scheme options parse and default to partial', () => {
  assertEquals(
    parseOrganizationOptions({ principalNameScheme: 'random' }).principalNameScheme,
    'random'
  )
  assertEquals(
    parseOrganizationOptions({ principalNameScheme: 'full' }).principalNameScheme,
    undefined
  )
  assertEquals(
    parseOrganizationOptions({ principalNameSchemeLocked: true }).principalNameSchemeLocked,
    true
  )
  assertEquals(
    parseOrganizationOptions({ principalNameSchemeLocked: 'yes' }).principalNameSchemeLocked,
    undefined
  )
  assertEquals(resolvePrincipalNamePolicy({}), { defaultScheme: 'partial', locked: false })
  assertEquals(resolvePrincipalNamePolicy({ randomizedPrincipalUsernames: false }), {
    defaultScheme: 'plain',
    locked: false,
  })
  assertEquals(
    resolvePrincipalNamePolicy({ principalNameScheme: 'random', principalNameSchemeLocked: true }),
    { defaultScheme: 'random', locked: true }
  )
})

test('parseOrganizationOptions round-trips a valid metricsCapabilityPlan override', () => {
  const options = parseOrganizationOptions({
    metricsCapabilityPlan: { gpuSlots: 4, managedIngressEnabled: false },
  })
  assertEquals(options.metricsCapabilityPlan, {
    gpuSlots: 4,
    managedIngressEnabled: false,
  })
})

test('parseOrganizationOptions ignores an invalid metricsCapabilityPlan override', () => {
  const options = parseOrganizationOptions({
    metricsCapabilityPlan: { gpuSlots: 'not-a-number' },
  })
  assertEquals(options.metricsCapabilityPlan, undefined)
})

test('parseOrganizationOptions leaves metricsCapabilityPlan unset when absent', () => {
  const options = parseOrganizationOptions({})
  assertEquals(options.metricsCapabilityPlan, undefined)
})

test('parseOrganizationOptions reads a valid docker addressing block', () => {
  const options = parseOrganizationOptions({
    docker: {
      addressPools: [{ base: '10.200.0.0/16', size: 24 }],
      defaultBridgeCidr: '172.17.0.1/16',
    },
  })
  assertEquals(options.docker, {
    addressPools: [{ base: '10.200.0.0/16', size: 24 }],
    defaultBridgeCidr: '172.17.0.1/16',
  })
})

test('parseOrganizationOptions omits docker when absent, empty or fully invalid', () => {
  assertEquals(parseOrganizationOptions({}).docker, undefined)
  assertEquals(parseOrganizationOptions({ docker: {} }).docker, undefined)
  assertEquals(parseOrganizationOptions({ docker: 'pools' }).docker, undefined)
  assertEquals(
    parseOrganizationOptions({
      docker: {
        addressPools: [{ base: 'bad', size: 24 }],
        defaultBridgeCidr: 'bad',
      },
    }).docker,
    undefined
  )
})

test('composeDefaultResourceLimits parses positive figures and ignores the rest', () => {
  // Opt-in: absent unless the organization set one (the 0.1.0 default).
  assertEquals(resolveComposeDefaultResourceLimits(parseOrganizationOptions({})), null)
  assertEquals(
    resolveComposeDefaultResourceLimits(
      parseOrganizationOptions({ composeDefaultResourceLimits: { cpus: 1.5 } })
    ),
    { cpus: 1.5 }
  )
  assertEquals(
    resolveComposeDefaultResourceLimits(
      parseOrganizationOptions({
        composeDefaultResourceLimits: { cpus: 2, memoryBytes: 1073741824 },
      })
    ),
    { cpus: 2, memoryBytes: 1073741824 }
  )
  // Zero, negative, non-finite and wrong-typed figures are not a ceiling.
  for (const bad of [
    { cpus: 0 },
    { cpus: -1 },
    { memoryBytes: 0 },
    { memoryBytes: '512m' },
    { cpus: Number.NaN },
    {},
    [],
    '1',
  ]) {
    assertEquals(
      resolveComposeDefaultResourceLimits(
        parseOrganizationOptions({ composeDefaultResourceLimits: bad })
      ),
      null,
      JSON.stringify(bad)
    )
  }
})

test('deploy hooks are off unless the organization opted in', () => {
  assertEquals(resolveDeployHooksEnabled({}), false)
  assertEquals(resolveDeployHooksEnabled(parseOrganizationOptions({})), false)
  assertEquals(
    resolveDeployHooksEnabled(parseOrganizationOptions({ deployHooksEnabled: 'yes' })),
    false
  )
  assertEquals(
    resolveDeployHooksEnabled(parseOrganizationOptions({ deployHooksEnabled: true })),
    true
  )
  assertEquals(parseOrganizationOptions({ deployHooksEnabled: false }).deployHooksEnabled, false)
})

test('the new-project form switches keep only booleans', () => {
  assertEquals(
    parseOrganizationOptions({
      openEnvironmentSectionByDefault: true,
      openWorkspaceSectionByDefault: 'yes',
    }),
    { openEnvironmentSectionByDefault: true }
  )
  assertEquals(
    parseOrganizationOptions({ openWorkspaceSectionByDefault: false })
      .openWorkspaceSectionByDefault,
    false
  )
})

test('the deploy time limit is 30 minutes unless the organization set a whole number from 5 to 240', () => {
  assertEquals(resolveDeployTimeoutMs(null), 30 * 60_000)
  assertEquals(resolveDeployTimeoutMs(undefined), 30 * 60_000)
  assertEquals(resolveDeployTimeoutMs(90), 90 * 60_000)
  for (const bad of [4, 241, 12.5, '30', true]) {
    assertEquals(resolveDeployTimeoutMs(bad), 30 * 60_000, JSON.stringify(bad))
  }
  assertEquals(resolveDeployTimeoutMs(5), 5 * 60_000)
  assertEquals(resolveDeployTimeoutMs(240), 240 * 60_000)
})

test('normalizeAcmeContactEmail accepts one public mailbox and lowercases the domain', () => {
  assertEquals(normalizeAcmeContactEmail(' Ops@Example.COM '), 'Ops@example.com')
  assertEquals(normalizeAcmeContactEmail('a+b@mail.example.co'), 'a+b@mail.example.co')
  assertEquals(
    normalizeAcmeContactEmail('first.last_x-y+z@example.org'),
    'first.last_x-y+z@example.org'
  )
})

test('normalizeAcmeContactEmail rejects lists, header breaks, display names and non-public domains', () => {
  const bad = [
    '',
    'a?subject=x@example.org',
    'a%0d@example.org',
    'a%0a@example.org',
    'a#b@example.org',
    'a&b@example.org',
    'a=b@example.org',
    "a'b@example.org",
    'a/b@example.org',
    '.a@example.org',
    'a.@example.org',
    'a..b@example.org',
    'a@@example.org',
    'a@b@example.org',
    'a@b.cd, e@f.gh',
    'a@b.cd;e@f.gh',
    'a@b.cd\r\nBcc: x@y.zz',
    'Name <a@b.cd>',
    '<a@b.cd>',
    'a b@c.de',
    'a@localhost',
    'a@10.0.0.1',
    'a@[10.0.0.1]',
    'a@exa_mple.com',
    'a@-bad.com',
    'a@b..com',
    'é@example.com',
    `${'a'.repeat(65)}@example.com`,
    `a@${'b'.repeat(250)}.com`,
    5,
    null,
  ]
  for (const value of bad) assertEquals(normalizeAcmeContactEmail(value), null, String(value))
})

test('parseOrganizationOptions keeps a valid contact email and drops an invalid one', () => {
  assertEquals(
    parseOrganizationOptions({ acmeContactEmail: 'ops@example.com' }).acmeContactEmail,
    'ops@example.com'
  )
  assertEquals(parseOrganizationOptions({ acmeContactEmail: 'nope' }).acmeContactEmail, undefined)
  assertEquals(parseOrganizationOptions({ acmeContactEmail: null }).acmeContactEmail, undefined)
  assertEquals(resolveAcmeContactEmail({}), null)
})
