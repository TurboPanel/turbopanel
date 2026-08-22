import { assert, assertEquals } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_RANGE_SECONDS,
  CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_UNSELECTIVE_RANGE_SECONDS,
  CONTAINER_LOGS_R2_SQL_RETENTION_RANGE_SECONDS,
  DEFAULT_CONTAINER_LOGS_ICEBERG_TABLE,
  parseContainerLogsMaxRangeSeconds,
  resolveContainerLogsCloudflareConfig,
} from './config.ts'
import { CONTAINER_LOG_RETENTION_DAYS, MAX_CONTAINER_LOG_QUERY_LIMIT } from '../types.ts'

const COMPLETE = {
  CLOUDFLARE_ACCOUNT_ID: 'acct',
  TURBOPANEL_CONTAINER_LOGS_R2_SQL_API_TOKEN: 'token',
  TURBOPANEL_CONTAINER_LOGS_R2_SQL_BUCKET: 'bucket',
}

describe('parseContainerLogsMaxRangeSeconds', () => {
  it('ignores empty and non-positive-integer values', () => {
    assertEquals(parseContainerLogsMaxRangeSeconds(undefined), undefined)
    assertEquals(parseContainerLogsMaxRangeSeconds(null), undefined)
    assertEquals(parseContainerLogsMaxRangeSeconds(' '), undefined)
    assertEquals(parseContainerLogsMaxRangeSeconds('0'), undefined)
    assertEquals(parseContainerLogsMaxRangeSeconds('-1'), undefined)
    assertEquals(parseContainerLogsMaxRangeSeconds('1.5'), undefined)
  })

  it('accepts a positive integer', () => {
    assertEquals(parseContainerLogsMaxRangeSeconds(' 60 '), 60)
    assertEquals(parseContainerLogsMaxRangeSeconds(3600), 3600)
  })
})

describe('resolveContainerLogsCloudflareConfig', () => {
  it('returns null when any credential or the bucket is missing', () => {
    assertEquals(resolveContainerLogsCloudflareConfig({}), null)
    assertEquals(
      resolveContainerLogsCloudflareConfig({ ...COMPLETE, CLOUDFLARE_ACCOUNT_ID: '  ' }),
      null
    )
    assertEquals(
      resolveContainerLogsCloudflareConfig({
        ...COMPLETE,
        TURBOPANEL_CONTAINER_LOGS_R2_SQL_API_TOKEN: '',
      }),
      null
    )
    assertEquals(
      resolveContainerLogsCloudflareConfig({
        ...COMPLETE,
        TURBOPANEL_CONTAINER_LOGS_R2_SQL_BUCKET: undefined,
      }),
      null
    )
  })

  it('defaults the table identifier and both range bounds', () => {
    assertEquals(resolveContainerLogsCloudflareConfig(COMPLETE), {
      accountId: 'acct',
      apiToken: 'token',
      bucket: 'bucket',
      table: DEFAULT_CONTAINER_LOGS_ICEBERG_TABLE,
      maxRangeSeconds: CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_RANGE_SECONDS,
      maxUnselectiveRangeSeconds: CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_UNSELECTIVE_RANGE_SECONDS,
    })
  })

  it('never lets the unselective bound exceed the selective one', () => {
    const resolved = resolveContainerLogsCloudflareConfig({
      ...COMPLETE,
      TURBOPANEL_CONTAINER_LOGS_R2_SQL_MAX_RANGE_SECONDS: '120',
      TURBOPANEL_CONTAINER_LOGS_R2_SQL_MAX_UNSELECTIVE_RANGE_SECONDS: '99999',
    })!
    assertEquals(resolved.maxRangeSeconds, 120)
    assertEquals(resolved.maxUnselectiveRangeSeconds, 120)
  })

  it('honors the table and max-range overrides', () => {
    assertEquals(
      resolveContainerLogsCloudflareConfig({
        ...COMPLETE,
        TURBOPANEL_CONTAINER_LOGS_ICEBERG_TABLE: ' logs.container_logs ',
        TURBOPANEL_CONTAINER_LOGS_R2_SQL_MAX_RANGE_SECONDS: '900',
        TURBOPANEL_CONTAINER_LOGS_R2_SQL_MAX_UNSELECTIVE_RANGE_SECONDS: '60',
      }),
      {
        accountId: 'acct',
        apiToken: 'token',
        bucket: 'bucket',
        table: 'logs.container_logs',
        maxRangeSeconds: 900,
        maxUnselectiveRangeSeconds: 60,
      }
    )
  })
})

describe('enforceable query budget', () => {
  // R2 SQL's HTTP API accepts only `{ query }` — no scanned-bytes cap, no cost
  // ceiling, no timeout. These assertions pin the two proxies we *can* enforce
  // so a future refactor cannot quietly widen either one.
  it('carries no scanned-bytes budget, because the API accepts none', () => {
    const resolved = resolveContainerLogsCloudflareConfig(COMPLETE)!
    assertEquals(Object.keys(resolved).sort(), [
      'accountId',
      'apiToken',
      'bucket',
      'maxRangeSeconds',
      'maxUnselectiveRangeSeconds',
      'table',
    ])
  })

  it('defaults the window bound well inside the retention period', () => {
    // With no scanned-bytes ceiling to send, defaulting the read budget to
    // "everything we retain" would make the accidental query the expensive
    // one. A day is the interactive window; wider is an explicit override.
    assertEquals(CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_RANGE_SECONDS, 24 * 60 * 60)
    assert(
      CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_RANGE_SECONDS < CONTAINER_LOGS_R2_SQL_RETENTION_RANGE_SECONDS
    )
    assertEquals(
      CONTAINER_LOGS_R2_SQL_RETENTION_RANGE_SECONDS,
      CONTAINER_LOG_RETENTION_DAYS * 24 * 60 * 60
    )
  })

  it('caps an unfiltered read far harder than a filtered one', () => {
    assert(
      CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_UNSELECTIVE_RANGE_SECONDS <
        CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_RANGE_SECONDS
    )
    assertEquals(CONTAINER_LOGS_R2_SQL_DEFAULT_MAX_UNSELECTIVE_RANGE_SECONDS, 60 * 60)
  })

  it('keeps the row cap inside R2 SQL\'s own 1-10,000 LIMIT bound', () => {
    assert(MAX_CONTAINER_LOG_QUERY_LIMIT >= 1)
    assert(MAX_CONTAINER_LOG_QUERY_LIMIT <= 10_000)
  })
})
