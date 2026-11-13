import { assertEquals } from '@std/assert'
import type { BuildLimits } from '../../contracts/commands/schemas.ts'
import { parseOrganizationOptions } from '../organizations/organization-options.ts'
import { parseServiceOptions } from '../projects/service-options.ts'
import { parseServerOptions } from '../servers/server-metadata.ts'
import {
  attachBuildLimits,
  parseBuildLimitSettings,
  parseBuildLimitSettingsInput,
  resolveBuildLimits,
} from './build-limits.ts'

const test = Deno.test.bind(Deno)
const GIB = 1024 ** 3

test('the smallest limit set among the levels wins, cores and memory on their own', () => {
  assertEquals(
    resolveBuildLimits({
      organization: { cores: 4, memoryBytes: 8 * GIB },
      server: { cores: 2 },
      service: { memoryBytes: 2 * GIB },
    }),
    {
      cores: { cores: 2, source: 'server' },
      memory: { bytes: 2 * GIB, source: 'service' },
    }
  )
  // A level that sets nothing never lowers the result.
  assertEquals(resolveBuildLimits({ organization: { cores: 3 }, server: {}, service: {} }), {
    cores: { cores: 3, source: 'organization' },
  })
})

test('a tie goes to the narrowest level, and nothing set means nothing sent', () => {
  assertEquals(
    resolveBuildLimits({
      organization: { cores: 2 },
      server: { cores: 2 },
      service: { cores: 2 },
    }),
    { cores: { cores: 2, source: 'service' } }
  )
  assertEquals(resolveBuildLimits({}), undefined)
  assertEquals(resolveBuildLimits({ organization: {}, server: {}, service: {} }), undefined)
})

test('stored settings drop what is out of range; a request refuses it', () => {
  assertEquals(parseBuildLimitSettings({ cores: 1.5, memoryBytes: GIB }), {
    cores: 1.5,
    memoryBytes: GIB,
  })
  assertEquals(parseBuildLimitSettings({ cores: 0.5, memoryBytes: 100 }), {})
  assertEquals(parseBuildLimitSettings({ cores: 1000, memoryBytes: 1.5 }), {})
  assertEquals(parseBuildLimitSettings('x'), {})
  assertEquals(parseBuildLimitSettingsInput(null), { ok: true, value: {} })
  assertEquals(parseBuildLimitSettingsInput({ cores: null, memoryBytes: 2 * GIB }), {
    ok: true,
    value: { memoryBytes: 2 * GIB },
  })
  assertEquals(parseBuildLimitSettingsInput({ cores: 1.234 }), { ok: true, value: { cores: 1.23 } })
  for (const bad of [{ cores: 0 }, { cores: 'two' }, { memoryBytes: GIB - 1 }, [], 'x']) {
    assertEquals(parseBuildLimitSettingsInput(bad).ok, false)
  }
})

test('the three levels keep their limits in options that already exist', () => {
  assertEquals(parseOrganizationOptions({ buildLimits: { cores: 2 } }).buildLimits, { cores: 2 })
  assertEquals(parseOrganizationOptions({ buildLimits: { cores: 0 } }).buildLimits, undefined)
  assertEquals(parseServerOptions({ buildLimits: { memoryBytes: 2 * GIB } })?.buildLimits, {
    memoryBytes: 2 * GIB,
  })
  assertEquals(parseServiceOptions({ build: { disableCache: true, cores: 1.5 } })?.build, {
    disableCache: true,
    cores: 1.5,
  })
  assertEquals(parseServiceOptions({ build: { disableCache: false } })?.build, undefined)
})

test('each source entry gets the full limits of its own service, server and organization', () => {
  const entries: Array<{
    composeServiceName: string
    commitSha: string
    buildLimits?: BuildLimits
  }> = [
    { composeServiceName: 'web', commitSha: 'a' },
    { composeServiceName: 'worker', commitSha: 'b' },
  ]
  const out = attachBuildLimits(entries, {
    organizationOptions: { buildLimits: { cores: 4 } },
    serverOptions: { buildLimits: { memoryBytes: 4 * GIB } },
    serviceOptionsByComposeName: new Map([['web', { build: { cores: 1.5 } }]]),
  })
  assertEquals(out[0]?.buildLimits, {
    cores: { cores: 1.5, source: 'service' },
    memory: { bytes: 4 * GIB, source: 'server' },
  })
  assertEquals(out[1]?.buildLimits, {
    cores: { cores: 4, source: 'organization' },
    memory: { bytes: 4 * GIB, source: 'server' },
  })
  // No level limits anything: the entry is untouched.
  const bare = attachBuildLimits(entries, {
    organizationOptions: {},
    serverOptions: null,
    serviceOptionsByComposeName: new Map(),
  })
  assertEquals(bare, entries)
})
