/**
 * Host-free coverage for organization route pure validation helpers.
 */

import { assertEquals } from '@std/assert'
import {
  applyManagedDefaultsPatch,
  applyTlsSettingsPatch,
  type TlsSettingsState,
  composeGatedFieldsGetResponse,
  composeGatedFieldsPutResponse,
  defaultEnvironmentGetResponse,
  defaultEnvironmentPutResponse,
  defaultTimezoneGetResponse,
  defaultTimezonePutResponse,
  hostDefaultsGetResponse,
  hostDefaultsPutResponse,
  managedDefaultsGetResponse,
  managedDefaultsPutResponse,
  parseComposeDefaultResourceLimitsPatch,
  parseComposeGatedFieldsPatch,
  parseDefaultEnvironmentPutBody,
  parseDefaultTimezonePatch,
  parseHostDefaultsPatch,
  parseManagedDefaultsPatch,
  parseOrganizationCreateDisplayName,
  organizationPatchAudits,
  parseOrganizationPatch,
  parseOrganizationPatchDisplayName,
  parseProjectSettingsPatch,
  parseServerCapacityPutBody,
  parseTemperatureUnitPatch,
  projectSettingsGetResponse,
  projectSettingsPutResponse,
  temperatureUnitGetResponse,
  temperatureUnitPutResponse,
  toOrganizationRecord,
  validateManagedDefaults,
} from './routes-helpers.ts'
import type { ManagedOrganizationDefaults } from '../../features/managed/org-defaults.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

test('parseComposeGatedFieldsPatch requires a boolean, no reset sentinel', () => {
  assertEquals(parseComposeGatedFieldsPatch({ composeGatedFieldsEnabled: true }), {
    ok: true,
    patch: { composeGatedFieldsEnabled: true },
  })
  assertEquals(parseComposeGatedFieldsPatch({ composeGatedFieldsEnabled: false }), {
    ok: true,
    patch: { composeGatedFieldsEnabled: false },
  })
  assertEquals(parseComposeGatedFieldsPatch({}).ok, false)
  assertEquals(parseComposeGatedFieldsPatch({ composeGatedFieldsEnabled: null }), {
    ok: false,
    error: 'Invalid composeGatedFieldsEnabled',
    status: 400,
  })
  assertEquals(parseComposeGatedFieldsPatch({ composeGatedFieldsEnabled: 'true' }).ok, false)
})

test('composeGatedFields responses default to false — deny-by-default, not just at deploy time', () => {
  assertEquals(composeGatedFieldsGetResponse({}), {
    composeGatedFieldsEnabled: false,
  })
  assertEquals(composeGatedFieldsGetResponse({ composeGatedFieldsEnabled: true }), {
    composeGatedFieldsEnabled: true,
  })
  assertEquals(composeGatedFieldsPutResponse({ composeGatedFieldsEnabled: true }), {
    ok: true,
    composeGatedFieldsEnabled: true,
  })
})

test('parseManagedDefaultsPatch accepts a mode or an explicit clear', () => {
  assertEquals(parseManagedDefaultsPatch({ sslMode: 'verify-full' }), {
    ok: true,
    patch: { sslMode: 'verify-full' },
  })
  // `null` is how an operator returns the org to the platform default; it is
  // not the same as omitting the key, which is an empty patch.
  assertEquals(parseManagedDefaultsPatch({ sslMode: null }), { ok: true, patch: { sslMode: null } })
  assertEquals(parseManagedDefaultsPatch({}).ok, false)
  // A typo must 400 rather than silently downgrade every inheriting service.
  assertEquals(parseManagedDefaultsPatch({ sslMode: 'requrie' }), {
    ok: false,
    error: 'Invalid sslMode',
    status: 400,
  })
  assertEquals(parseManagedDefaultsPatch({ sslMode: true }).ok, false)
})

test('applyManagedDefaultsPatch preserves untouched sibling keys', () => {
  // The route writes the whole `managedDatabase` object back, so this merge is
  // the only thing keeping a future sibling key (ports) alive across a PUT that
  // only names sslMode.
  // `unrelated` stands in for a sibling key this helper does not know about,
  // so it has to be smuggled past the declared type on both sides.
  const current = {
    sslMode: 'require' as const,
    unrelated: 'keep-me',
  } as ManagedOrganizationDefaults
  assertEquals(applyManagedDefaultsPatch(current, { sslMode: 'verify-ca' }), {
    sslMode: 'verify-ca',
    unrelated: 'keep-me',
  } as ManagedOrganizationDefaults)
  assertEquals(applyManagedDefaultsPatch(current, { sslMode: null }), {
    unrelated: 'keep-me',
  } as ManagedOrganizationDefaults)
  assertEquals(applyManagedDefaultsPatch({}, {}), {})
})

test('managed defaults responses separate configured from effective', () => {
  assertEquals(managedDefaultsGetResponse({}), {
    sslMode: null,
    effectiveSslMode: 'require',
    ports: { postgres: null, mysqlFamily: null },
    effectivePorts: { postgres: 15432, mysqlFamily: 13306 },
    allowAllDatabasesLogins: true,
  })
  assertEquals(managedDefaultsGetResponse({ sslMode: 'prefer' }), {
    sslMode: 'prefer',
    effectiveSslMode: 'prefer',
    ports: { postgres: null, mysqlFamily: null },
    effectivePorts: { postgres: 15432, mysqlFamily: 13306 },
    allowAllDatabasesLogins: true,
  })
  // One overridden family must not drag the other off its platform listener.
  assertEquals(managedDefaultsGetResponse({ ports: { postgres: 18432 } }), {
    sslMode: null,
    effectiveSslMode: 'require',
    ports: { postgres: 18432, mysqlFamily: null },
    effectivePorts: { postgres: 18432, mysqlFamily: 13306 },
    allowAllDatabasesLogins: true,
  })
  assertEquals(managedDefaultsPutResponse({ sslMode: 'disable' }), {
    ok: true,
    sslMode: 'disable',
    effectiveSslMode: 'disable',
    ports: { postgres: null, mysqlFamily: null },
    effectivePorts: { postgres: 15432, mysqlFamily: 13306 },
    allowAllDatabasesLogins: true,
  })
})

test('parseManagedDefaultsPatch names the offending listener port field', () => {
  assertEquals(parseManagedDefaultsPatch({ ports: { postgres: 18432 } }), {
    ok: true,
    patch: { ports: { postgres: 18432 } },
  })
  // Clearing one family versus clearing the whole object are different edits.
  assertEquals(parseManagedDefaultsPatch({ ports: { mysqlFamily: null } }), {
    ok: true,
    patch: { ports: { mysqlFamily: null } },
  })
  assertEquals(parseManagedDefaultsPatch({ ports: null }), { ok: true, patch: { ports: null } })
  // The message has to say which family and why, or an operator cannot tell a
  // privileged port from a platform-reserved one.
  assertEquals(parseManagedDefaultsPatch({ ports: { postgres: 443 } }), {
    ok: false,
    error: 'ports.postgres must be an integer between 1024 and 65535',
    status: 400,
  })
  assertEquals(parseManagedDefaultsPatch({ ports: { mysqlFamily: 6032 } }), {
    ok: false,
    error: 'ports.mysqlFamily is reserved for the ProxySQL admin interface',
    status: 400,
  })
  assertEquals(parseManagedDefaultsPatch({ ports: { postgres: 45100 } }), {
    ok: false,
    error: 'ports.postgres is reserved for managed member private listeners (45000-45999)',
    status: 400,
  })
  assertEquals(parseManagedDefaultsPatch({ ports: 15432 }).ok, false)
})

test('applyManagedDefaultsPatch merges listener ports per family', () => {
  const current: ManagedOrganizationDefaults = {
    ports: { postgres: 18432, mysqlFamily: 18306 },
  }
  assertEquals(applyManagedDefaultsPatch(current, { ports: { postgres: 19432 } }), {
    ports: { postgres: 19432, mysqlFamily: 18306 },
  })
  assertEquals(applyManagedDefaultsPatch(current, { ports: { postgres: null } }), {
    ports: { mysqlFamily: 18306 },
  })
  // Clearing the last family drops the whole object rather than persisting an
  // empty one, so the stored jsonb stays readable.
  assertEquals(
    applyManagedDefaultsPatch(
      { ports: { postgres: 18432 } },
      {
        ports: { postgres: null },
      }
    ),
    {}
  )
  assertEquals(applyManagedDefaultsPatch(current, { ports: null }), {})
  // sslMode and ports are independent keys on one object; editing one must not
  // disturb the other.
  assertEquals(
    applyManagedDefaultsPatch(
      { sslMode: 'verify-full', ...current },
      {
        sslMode: 'prefer',
      }
    ),
    { sslMode: 'prefer', ports: { postgres: 18432, mysqlFamily: 18306 } }
  )
})

test('validateManagedDefaults catches a collision only visible after merge', () => {
  assertEquals(validateManagedDefaults({}), null)
  assertEquals(validateManagedDefaults({ ports: { postgres: 18432, mysqlFamily: 18306 } }), null)
  // Two protocol modules on one port would leave ProxySQL half-bound. This is
  // reachable by overriding one family onto the other's inherited default, so
  // the per-field parser cannot see it.
  assertEquals(validateManagedDefaults({ ports: { postgres: 13306 } }), {
    ok: false,
    error: "ports.mysqlFamily must differ from the other protocol family's listener port",
    status: 400,
  })
})

test('parseHostDefaultsPatch rejects empty and invalid patches', () => {
  assertEquals(parseHostDefaultsPatch({}).ok, false)
  assertEquals(parseHostDefaultsPatch({ sshPort: 0 }), {
    ok: false,
    error: 'Invalid sshPort',
    status: 400,
  })
  assertEquals(parseHostDefaultsPatch({ ntp: { servers: [] } }), {
    ok: false,
    error: 'Invalid ntp',
    status: 400,
  })
  assertEquals(parseHostDefaultsPatch({ defaultFabricEnabled: 'yes' }), {
    ok: false,
    error: 'Invalid defaultFabricEnabled',
    status: 400,
  })
})

test('parseHostDefaultsPatch accepts sshPort, ntp, fabric default, and clears', () => {
  const port = parseHostDefaultsPatch({ sshPort: 2222 })
  if (!port.ok) {
    throw new TypeError('expected sshPort patch')
  }
  assertEquals(port.patch.sshPort, 2222)

  const clearPort = parseHostDefaultsPatch({ sshPort: null })
  if (!clearPort.ok) {
    throw new TypeError('expected sshPort clear')
  }
  assertEquals(clearPort.patch.sshPort, null)

  const ntp = parseHostDefaultsPatch({
    ntp: { enabled: true, servers: ['time.cloudflare.com'] },
    defaultFabricEnabled: true,
  })
  if (!ntp.ok) {
    throw new TypeError('expected ntp/fabric patch')
  }
  assertEquals(ntp.patch.ntp, {
    enabled: true,
    servers: ['time.cloudflare.com'],
  })
  assertEquals(ntp.patch.defaultFabricEnabled, true)
})

test('hostDefaultsGetResponse and PutResponse expose configured org values', () => {
  assertEquals(hostDefaultsGetResponse({}), {
    sshPort: null,
    ntp: null,
    hideWebServerNames: true,
    sendViaHeader: false,
    defaultFabricEnabled: false,
  })
  assertEquals(
    hostDefaultsPutResponse({
      sshPort: 2222,
      ntp: { enabled: true },
      defaultFabricEnabled: true,
    }),
    {
      ok: true,
      sshPort: 2222,
      ntp: { enabled: true },
      hideWebServerNames: true,
      sendViaHeader: false,
      defaultFabricEnabled: true,
    }
  )
  assertEquals(hostDefaultsGetResponse({ hideWebServerNames: false }).hideWebServerNames, false)
  assertEquals(hostDefaultsGetResponse({ sendViaHeader: true }).sendViaHeader, true)
})

test('parseHostDefaultsPatch takes hideWebServerNames as a boolean or null', () => {
  assertEquals(parseHostDefaultsPatch({ hideWebServerNames: 'no' }), {
    ok: false,
    error: 'Invalid hideWebServerNames',
    status: 400,
  })
  const off = parseHostDefaultsPatch({ hideWebServerNames: false })
  if (!off.ok) throw new TypeError('expected hideWebServerNames patch')
  assertEquals(off.patch.hideWebServerNames, false)
  const cleared = parseHostDefaultsPatch({ hideWebServerNames: null })
  if (!cleared.ok) throw new TypeError('expected hideWebServerNames clear')
  assertEquals(cleared.patch.hideWebServerNames, null)
})

test('parseHostDefaultsPatch takes sendViaHeader as a boolean or null', () => {
  assertEquals(parseHostDefaultsPatch({ sendViaHeader: 'yes' }), {
    ok: false,
    error: 'Invalid sendViaHeader',
    status: 400,
  })
  const on = parseHostDefaultsPatch({ sendViaHeader: true })
  if (!on.ok) throw new TypeError('expected sendViaHeader patch')
  assertEquals(on.patch, { sendViaHeader: true })
  const off = parseHostDefaultsPatch({ sendViaHeader: false })
  if (!off.ok) throw new TypeError('expected sendViaHeader patch')
  assertEquals(off.patch.sendViaHeader, false)
  const cleared = parseHostDefaultsPatch({ sendViaHeader: null })
  if (!cleared.ok) throw new TypeError('expected sendViaHeader clear')
  assertEquals(cleared.patch.sendViaHeader, null)
})

test('parseDefaultTimezonePatch rejects empty and invalid patches', () => {
  assertEquals(parseDefaultTimezonePatch({}).ok, false)
  assertEquals(parseDefaultTimezonePatch({ defaultServerTimezone: 'Not/AZone' }), {
    ok: false,
    error: 'Invalid defaultServerTimezone',
    status: 400,
  })
  assertEquals(parseDefaultTimezonePatch({ enforceServerTimezone: 'yes' }), {
    ok: false,
    error: 'Invalid enforceServerTimezone',
    status: 400,
  })
})

test('parseDefaultTimezonePatch accepts null timezone and boolean enforcement', () => {
  const reset = parseDefaultTimezonePatch({ defaultServerTimezone: null })
  if (!reset.ok) {
    throw new TypeError('expected null timezone reset to succeed')
  }
  assertEquals(reset.patch.defaultServerTimezone, null)

  const enforce = parseDefaultTimezonePatch({
    defaultServerTimezone: 'America/New_York',
    enforceServerTimezone: true,
  })
  if (!enforce.ok) {
    throw new TypeError('expected valid timezone patch')
  }
  assertEquals(enforce.patch.defaultServerTimezone, 'America/New_York')
  assertEquals(enforce.patch.enforceServerTimezone, true)
})

test('parseTemperatureUnitPatch requires the field and validates the value', () => {
  assertEquals(parseTemperatureUnitPatch({}).ok, false)
  assertEquals(parseTemperatureUnitPatch({ temperatureUnit: 'kelvin' }), {
    ok: false,
    error: 'Invalid temperatureUnit',
    status: 400,
  })
  assertEquals(parseTemperatureUnitPatch({ temperatureUnit: 'fahrenheit' }), {
    ok: true,
    patch: { temperatureUnit: 'fahrenheit' },
  })
})

test('project settings patch takes one switch or both, each a boolean', () => {
  assertEquals(parseProjectSettingsPatch({ openWorkspaceSectionByDefault: true }), {
    ok: true,
    patch: { openWorkspaceSectionByDefault: true },
  })
  assertEquals(
    parseProjectSettingsPatch({
      openEnvironmentSectionByDefault: false,
      openWorkspaceSectionByDefault: true,
      other: 1,
    }),
    {
      ok: true,
      patch: { openEnvironmentSectionByDefault: false, openWorkspaceSectionByDefault: true },
    }
  )
  assertEquals(parseProjectSettingsPatch({ openWorkspaceSectionByDefault: null }), {
    ok: false,
    error: 'Invalid openWorkspaceSectionByDefault',
    status: 400,
  })
  assertEquals(parseProjectSettingsPatch({}).ok, false)
})

test('project settings response shapers default both switches to off', () => {
  assertEquals(projectSettingsGetResponse({}), {
    openEnvironmentSectionByDefault: false,
    openWorkspaceSectionByDefault: false,
  })
  assertEquals(projectSettingsPutResponse({ openEnvironmentSectionByDefault: true }), {
    ok: true,
    openEnvironmentSectionByDefault: true,
    openWorkspaceSectionByDefault: false,
  })
})

test('temperature unit response shapers', () => {
  assertEquals(temperatureUnitGetResponse({}), { temperatureUnit: 'celsius' })
  assertEquals(temperatureUnitGetResponse({ temperatureUnit: 'fahrenheit' }), {
    temperatureUnit: 'fahrenheit',
  })
  assertEquals(temperatureUnitPutResponse({ temperatureUnit: 'fahrenheit' }), {
    ok: true,
    temperatureUnit: 'fahrenheit',
  })
})

test('parseDefaultEnvironmentPutBody requires field and validates names', () => {
  assertEquals(parseDefaultEnvironmentPutBody({}).ok, false)
  assertEquals(parseDefaultEnvironmentPutBody({ defaultEnvironmentName: '' }).ok, false)
  assertEquals(parseDefaultEnvironmentPutBody({ defaultEnvironmentName: 'bad\nname' }).ok, false)
  assertEquals(parseDefaultEnvironmentPutBody({ defaultEnvironmentName: 'bad/name' }).ok, false)
  assertEquals(parseDefaultEnvironmentPutBody({ defaultEnvironmentName: 'My Env' }).ok, false)

  const ok = parseDefaultEnvironmentPutBody({
    defaultEnvironmentName: ' staging ',
  })
  if (!ok.ok) {
    throw new TypeError('expected valid default environment name')
  }
  assertEquals(ok.defaultEnvironmentName, 'staging')

  const reset = parseDefaultEnvironmentPutBody({
    defaultEnvironmentName: null,
  })
  if (!reset.ok) {
    throw new TypeError('expected null default environment reset')
  }
  assertEquals(reset.defaultEnvironmentName, null)
})

test('parseServerCapacityPutBody requires maxServers and validates values', () => {
  assertEquals(parseServerCapacityPutBody({}).ok, false)
  assertEquals(parseServerCapacityPutBody({ maxServers: -1 }).ok, false)
  assertEquals(parseServerCapacityPutBody({ maxServers: 1.5 }).ok, false)

  const unlimited = parseServerCapacityPutBody({ maxServers: null })
  if (!unlimited.ok) {
    throw new TypeError('expected null maxServers')
  }
  assertEquals(unlimited.maxServers, null)

  const capped = parseServerCapacityPutBody({ maxServers: 3 })
  if (!capped.ok) {
    throw new TypeError('expected integer maxServers')
  }
  assertEquals(capped.maxServers, 3)
})

test('parseOrganizationCreateDisplayName defaults when name is absent', () => {
  const defaultName = parseOrganizationCreateDisplayName({})
  if (!defaultName.ok) {
    throw new TypeError('expected default organization name')
  }
  assertEquals(defaultName.name, 'New Organization')

  const apostrophe = parseOrganizationCreateDisplayName({
    name: "O'Reilly",
  })
  if (!apostrophe.ok) {
    throw new TypeError('expected apostrophe organization name')
  }
  assertEquals(apostrophe.name, "O'Reilly")

  const unicode = parseOrganizationCreateDisplayName({
    name: 'Müller GmbH',
  })
  if (!unicode.ok) {
    throw new TypeError('expected Unicode organization name')
  }
  assertEquals(unicode.name, 'Müller GmbH')

  // Control characters are rejected (wire field is validated, not ignored).
  const rejected = parseOrganizationCreateDisplayName({
    name: 'bad\nname',
  })
  if (rejected.ok) {
    throw new TypeError('expected invalid name to be rejected')
  }
  assertEquals(rejected.status, 400)
})

test('parseOrganizationPatchDisplayName requires a valid display name', () => {
  assertEquals(parseOrganizationPatchDisplayName({}).ok, false)
  assertEquals(parseOrganizationPatchDisplayName({ name: '' }).ok, false)
  assertEquals(parseOrganizationPatchDisplayName({ name: 'bad\nname' }).ok, false)
  assertEquals(parseOrganizationPatchDisplayName({ name: null }).ok, false)

  const ok = parseOrganizationPatchDisplayName({
    name: " O'Reilly ",
  })
  if (!ok.ok) {
    throw new TypeError('expected apostrophe organization name')
  }
  assertEquals(ok.name, "O'Reilly")

  const folded = parseOrganizationPatchDisplayName({
    name: 'McDonald\u2019s',
  })
  if (!folded.ok) {
    throw new TypeError('expected folded curly apostrophe')
  }
  assertEquals(folded.name, "McDonald's")
})

test('toOrganizationRecord maps DB name, icon and the emoji setting', () => {
  assertEquals(
    toOrganizationRecord({
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Acme',
      createdAt: '2026-01-01T00:00:00.000Z',
      icon: '🚀',
      isEmojiIconAllowed: false,
    }),
    {
      id: '11111111-1111-1111-1111-111111111111',
      name: 'Acme',
      createdAt: '2026-01-01T00:00:00.000Z',
      icon: '🚀',
      isEmojiIconAllowed: false,
    }
  )
})

test('parseOrganizationPatch takes a name, an icon and the emoji setting, at least one', () => {
  assertEquals(parseOrganizationPatch({}).ok, false)
  assertEquals(parseOrganizationPatch({ name: '' }).ok, false)
  assertEquals(parseOrganizationPatch({ name: 'Acme' }), {
    ok: true,
    patch: { name: 'Acme', iconIsEmoji: false },
  })
  assertEquals(parseOrganizationPatch({ icon: 'rocket' }), {
    ok: true,
    patch: { icon: 'rocket', iconIsEmoji: false },
  })
  assertEquals(parseOrganizationPatch({ icon: '👩‍💻' }), {
    ok: true,
    patch: { icon: '👩‍💻', iconIsEmoji: true },
  })
  assertEquals(parseOrganizationPatch({ icon: null }), {
    ok: true,
    patch: { icon: null, iconIsEmoji: false },
  })
  assertEquals(parseOrganizationPatch({ isEmojiIconAllowed: false }), {
    ok: true,
    patch: { isEmojiIconAllowed: false, iconIsEmoji: false },
  })
  assertEquals(parseOrganizationPatch({ icon: 'unicorn' }).ok, false)
  assertEquals(parseOrganizationPatch({ icon: '🚀🚀' }).ok, false)
  assertEquals(parseOrganizationPatch({ icon: '1️⃣' }).ok, false)
  assertEquals(parseOrganizationPatch({ isEmojiIconAllowed: 'no' }).ok, false)
  assertEquals(parseOrganizationPatch({ name: 'Acme', icon: 7 }).ok, false)
})

test('organizationPatchAudits records only the icon and emoji settings that changed', () => {
  const before = { icon: 'rocket', isEmojiIconAllowed: true }
  assertEquals(organizationPatchAudits({ name: 'Acme', iconIsEmoji: false }, before), [])
  assertEquals(
    organizationPatchAudits(
      { icon: 'rocket', isEmojiIconAllowed: true, iconIsEmoji: false },
      before
    ),
    []
  )
  assertEquals(
    organizationPatchAudits({ icon: '🚀', isEmojiIconAllowed: false, iconIsEmoji: true }, before),
    [
      { action: 'organization.icon.set', context: { icon: '🚀', previousIcon: 'rocket' } },
      { action: 'organization.emoji_icons.set', context: { isEmojiIconAllowed: false } },
    ]
  )
})

test('default timezone and environment response shapers', () => {
  assertEquals(defaultTimezoneGetResponse({}), {
    defaultServerTimezone: null,
    enforceServerTimezone: false,
  })
  assertEquals(
    defaultTimezoneGetResponse({
      defaultServerTimezone: 'UTC',
      enforceServerTimezone: true,
    }),
    { defaultServerTimezone: 'UTC', enforceServerTimezone: true }
  )
  assertEquals(defaultTimezonePutResponse({ defaultServerTimezone: null }), {
    ok: true,
    defaultServerTimezone: null,
    enforceServerTimezone: false,
  })
  assertEquals(defaultEnvironmentGetResponse({}), {
    defaultEnvironmentName: null,
  })
  assertEquals(defaultEnvironmentPutResponse({ defaultEnvironmentName: 'staging' }), {
    ok: true,
    defaultEnvironmentName: 'staging',
  })
})

test('parseComposeDefaultResourceLimitsPatch takes positive figures, or null to clear', () => {
  assertEquals(
    parseComposeDefaultResourceLimitsPatch({
      composeDefaultResourceLimits: { cpus: 1, memoryBytes: 536870912 },
    }),
    {
      ok: true,
      patch: {
        composeDefaultResourceLimits: { cpus: 1, memoryBytes: 536870912 },
      },
    }
  )
  // Either figure alone is a valid ceiling.
  assertEquals(
    parseComposeDefaultResourceLimitsPatch({
      composeDefaultResourceLimits: { cpus: 0.5 },
    }),
    { ok: true, patch: { composeDefaultResourceLimits: { cpus: 0.5 } } }
  )
  // null clears the opt-in, back to the 0.1.0 default of no platform number.
  assertEquals(
    parseComposeDefaultResourceLimitsPatch({
      composeDefaultResourceLimits: null,
    }),
    { ok: true, patch: { composeDefaultResourceLimits: null } }
  )
  // An empty object would read as opting in to nothing.
  assertEquals(
    parseComposeDefaultResourceLimitsPatch({ composeDefaultResourceLimits: {} }).ok,
    false
  )
  for (const bad of [
    { composeDefaultResourceLimits: { cpus: 0 } },
    { composeDefaultResourceLimits: { cpus: -2 } },
    { composeDefaultResourceLimits: { memoryBytes: 1.5 } },
    { composeDefaultResourceLimits: { memoryBytes: '512m' } },
    { composeDefaultResourceLimits: [] },
    { composeDefaultResourceLimits: '1' },
    {},
  ]) {
    assertEquals(parseComposeDefaultResourceLimitsPatch(bad).ok, false, JSON.stringify(bad))
  }
})

test("applyTlsSettingsPatch needs a contact and the current agreement for Let's Encrypt to be on", () => {
  const now = '2026-11-03T18:00:00.000Z'
  const terms = 'https://letsencrypt.org/documents/LE-SA-v1.5.pdf'
  const newer = 'https://letsencrypt.org/documents/LE-SA-v1.6.pdf'
  const off: TlsSettingsState = {
    acmeEnabled: false,
    acmeContactEmail: null,
    acmeTermsAcceptedAt: null,
    acmeTermsUrl: null,
  }
  const code = (
    patch: Parameters<typeof applyTlsSettingsPatch>[1],
    before: TlsSettingsState = off,
    current: string | null = terms
  ) => {
    const result = applyTlsSettingsPatch(before, patch, now, current)
    return result.ok ? null : `${result.refusal.status} ${result.refusal.code}`
  }
  const accept = { acmeTermsAccepted: true as const, acmeTermsUrl: terms }

  assertEquals(code({ acmeEnabled: true, ...accept }), '400 acme_contact_email_required')
  assertEquals(
    code({ acmeEnabled: true, acmeContactEmail: 'ops@example.com' }),
    '400 acme_terms_not_accepted'
  )
  // The agreement shown must be the current one, and readable.
  assertEquals(code({ ...accept, acmeTermsUrl: newer }), '409 acme_terms_changed')
  assertEquals(code(accept, off, null), '503 acme_terms_unavailable')
  assertEquals(
    applyTlsSettingsPatch(
      off,
      { acmeEnabled: true, acmeContactEmail: 'ops@example.com', ...accept },
      now,
      terms
    ),
    {
      ok: true,
      next: {
        acmeEnabled: true,
        acmeContactEmail: 'ops@example.com',
        acmeTermsAcceptedAt: now,
        acmeTermsUrl: terms,
      },
    }
  )

  const on: TlsSettingsState = {
    acmeEnabled: true,
    acmeContactEmail: 'ops@example.com',
    acmeTermsAcceptedAt: '2026-11-01T00:00:00.000Z',
    acmeTermsUrl: terms,
  }
  // Removing the contact while on is refused; turning off keeps the rest.
  assertEquals(code({ acmeContactEmail: null }, on), '400 acme_contact_email_required')
  assertEquals(applyTlsSettingsPatch(on, { acmeEnabled: false }, now, terms), {
    ok: true,
    next: { ...on, acmeEnabled: false },
  })
  // Newer terms: turning back on asks again; accepting the new ones records them.
  const offOld = { ...on, acmeEnabled: false }
  assertEquals(code({ acmeEnabled: true }, offOld, newer), '400 acme_terms_not_accepted')
  assertEquals(code({ acmeEnabled: true }, offOld, null), '503 acme_terms_unavailable')
  assertEquals(
    applyTlsSettingsPatch(
      offOld,
      { acmeEnabled: true, acmeTermsAccepted: true, acmeTermsUrl: newer },
      now,
      newer
    ),
    { ok: true, next: { ...on, acmeTermsAcceptedAt: now, acmeTermsUrl: newer } }
  )
  // Staying on with older terms is allowed (the screen asks again).
  assertEquals(code({ acmeContactEmail: 'new@example.com' }, on, newer), null)

  // An organization already on before this step, with neither, can save a contact.
  const legacy: TlsSettingsState = { ...off, acmeEnabled: true }
  assertEquals(code({ acmeContactEmail: 'ops@example.com' }, legacy), null)
  assertEquals(code({ acmeEnabled: true }, legacy), null)
  // Turning on while clearing an existing contact is refused.
  assertEquals(
    code(
      { acmeEnabled: true, acmeContactEmail: null, ...accept },
      { ...off, acmeContactEmail: 'a@example.com' }
    ),
    '400 acme_contact_email_required'
  )
  // Off with nothing stored is always allowed, even when the terms cannot be read.
  assertEquals(code({ acmeContactEmail: null }, off, null), null)
})
