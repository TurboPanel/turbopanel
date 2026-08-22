import { assert, assertEquals } from '@std/assert'
import { beforeEach, describe, it } from '@std/testing/bdd'
import { ClickHouseContainerLogStore } from './clickhouse/store.ts'
import { PipelinesIcebergContainerLogStore } from './cloudflare/pipeline-store.ts'
import type { PipelineLike } from './cloudflare/pipeline-store.ts'
import { DisabledContainerLogStore } from './disabled-store.ts'
import {
  parseContainerLogRetentionDays,
  parseContainerLogsEnabled,
  resetContainerLogStoreSelectionWarningsForTests,
  resolveContainerLogStore,
} from './store-selection.ts'
import { CONTAINER_LOG_RETENTION_DAYS } from './types.ts'

const PIPELINE: PipelineLike = { send: () => Promise.resolve() }

const FULL_R2_SQL = {
  accountId: 'acct',
  apiToken: 'token',
  bucket: 'bucket',
  table: 'default.container_logs',
}

const FULL_CLICKHOUSE = {
  url: 'http://127.0.0.1:8123',
  database: 'turbopanel_metrics',
  user: 'turbopanel_app',
  password: 'secret',
}

function captureWarnings(fn: () => void): string[] {
  const messages: string[] = []
  const original = console.warn
  console.warn = (message?: unknown) => {
    messages.push(String(message))
  }
  try {
    fn()
  } finally {
    console.warn = original
  }
  return messages
}

beforeEach(() => {
  resetContainerLogStoreSelectionWarningsForTests()
})

describe('parseContainerLogsEnabled', () => {
  it('is off unless explicitly opted in', () => {
    assertEquals(parseContainerLogsEnabled(undefined), false)
    assertEquals(parseContainerLogsEnabled(null), false)
    assertEquals(parseContainerLogsEnabled(''), false)
    assertEquals(parseContainerLogsEnabled('0'), false)
    assertEquals(parseContainerLogsEnabled('off'), false)
    assertEquals(parseContainerLogsEnabled('maybe'), false)
  })

  it('accepts the documented truthy tokens', () => {
    assertEquals(parseContainerLogsEnabled('1'), true)
    assertEquals(parseContainerLogsEnabled(' TRUE '), true)
    assertEquals(parseContainerLogsEnabled('yes'), true)
    assertEquals(parseContainerLogsEnabled('on'), true)
    assertEquals(parseContainerLogsEnabled(true), true)
  })
})

describe('parseContainerLogRetentionDays', () => {
  it('falls back to the default for empty or invalid values', () => {
    assertEquals(parseContainerLogRetentionDays(undefined), CONTAINER_LOG_RETENTION_DAYS)
    assertEquals(parseContainerLogRetentionDays(''), CONTAINER_LOG_RETENTION_DAYS)
    assertEquals(parseContainerLogRetentionDays('0'), CONTAINER_LOG_RETENTION_DAYS)
    assertEquals(parseContainerLogRetentionDays('-5'), CONTAINER_LOG_RETENTION_DAYS)
    assertEquals(parseContainerLogRetentionDays('7.5'), CONTAINER_LOG_RETENTION_DAYS)
  })

  it('accepts a positive integer override', () => {
    assertEquals(parseContainerLogRetentionDays('7'), 7)
    assertEquals(parseContainerLogRetentionDays(90), 90)
  })
})

describe('resolveContainerLogStore', () => {
  it('is disabled by default even with a complete backend config', () => {
    const warnings = captureWarnings(() => {
      const store = resolveContainerLogStore({
        runtime: 'deno',
        enabled: false,
        clickhouse: FULL_CLICKHOUSE,
      })
      assert(store instanceof DisabledContainerLogStore)
    })
    assertEquals(warnings, [])
  })

  it('is disabled by default on Workers too, silently', () => {
    const warnings = captureWarnings(() => {
      const store = resolveContainerLogStore({ runtime: 'workers', enabled: false })
      assert(store instanceof DisabledContainerLogStore)
    })
    assertEquals(warnings, [])
  })

  it('returns the ClickHouse store when enabled on Deno with full config', () => {
    const store = resolveContainerLogStore({
      runtime: 'deno',
      enabled: true,
      clickhouse: { ...FULL_CLICKHOUSE, retentionDays: 7 },
    })
    assert(store instanceof ClickHouseContainerLogStore)
  })

  it('warns once and disables when enabled on Deno with incomplete config', () => {
    const warnings = captureWarnings(() => {
      const incomplete = [undefined, { url: ' ', database: 'db', user: 'u', password: 'p' }]
      for (const clickhouse of incomplete) {
        const store = resolveContainerLogStore({ runtime: 'deno', enabled: true, clickhouse })
        assert(store instanceof DisabledContainerLogStore)
      }
    })
    assertEquals(warnings.length, 1)
    assert(warnings[0]!.includes('ClickHouse config is incomplete'))
  })

  it('returns the Pipelines/Iceberg store when enabled on Workers with full config', () => {
    const warnings = captureWarnings(() => {
      const store = resolveContainerLogStore({
        runtime: 'workers',
        enabled: true,
        pipeline: PIPELINE,
        r2Sql: FULL_R2_SQL,
      })
      assert(store instanceof PipelinesIcebergContainerLogStore)
    })
    assertEquals(warnings, [])
  })

  it('warns once and disables when the Workers config is incomplete', () => {
    const warnings = captureWarnings(() => {
      const incomplete: Array<Parameters<typeof resolveContainerLogStore>[0]> = [
        { runtime: 'workers', enabled: true },
        { runtime: 'workers', enabled: true, pipeline: PIPELINE, r2Sql: null },
        { runtime: 'workers', enabled: true, r2Sql: FULL_R2_SQL },
      ]
      for (const input of incomplete) {
        assert(resolveContainerLogStore(input) instanceof DisabledContainerLogStore)
      }
    })
    assertEquals(warnings.length, 1)
    assert(warnings[0]!.includes('Pipelines/R2 SQL config is incomplete'))
  })
})
