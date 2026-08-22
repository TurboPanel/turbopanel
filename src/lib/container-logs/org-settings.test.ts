import { assert, assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  containerLogSettingsResponse,
  parseContainerLogsEnabledInput,
  resolveContainerLogsEnabled,
} from './org-settings.ts'
import { CONTAINER_LOG_RETENTION_DAYS } from './types.ts'

describe('parseContainerLogsEnabledInput', () => {
  it('accepts either boolean', () => {
    assertEquals(parseContainerLogsEnabledInput(true), {
      ok: true,
      value: true,
    })
    assertEquals(parseContainerLogsEnabledInput(false), {
      ok: true,
      value: false,
    })
  })

  it('treats null as a clear back to the platform default', () => {
    assertEquals(parseContainerLogsEnabledInput(null), {
      ok: true,
      value: null,
    })
  })

  it('rejects truthy non-booleans rather than coercing them on', () => {
    for (const value of ['true', '1', 1, {}, [], undefined]) {
      const parsed = parseContainerLogsEnabledInput(value)
      assert(!parsed.ok, `${String(value)} must not enable a billed feature`)
    }
  })
})

describe('resolveContainerLogsEnabled', () => {
  it('is off unless the option is exactly true', () => {
    assertEquals(resolveContainerLogsEnabled(undefined), false)
    assertEquals(resolveContainerLogsEnabled(null), false)
    assertEquals(resolveContainerLogsEnabled({}), false)
    assertEquals(resolveContainerLogsEnabled({ containerLogsEnabled: false }), false)
    assertEquals(resolveContainerLogsEnabled({ containerLogsEnabled: true }), true)
  })
})

describe('containerLogSettingsResponse', () => {
  it('reports the switch plus the platform retention window', () => {
    assertEquals(containerLogSettingsResponse({ containerLogsEnabled: true }), {
      containerLogsEnabled: true,
      retentionDays: CONTAINER_LOG_RETENTION_DAYS,
    })
  })
})
