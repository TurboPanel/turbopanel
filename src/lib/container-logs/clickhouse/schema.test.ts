import { assertEquals, assertThrows } from '@std/assert'
import { describe, it } from '@std/testing/bdd'
import {
  buildContainerLogSchemaStatements,
  CONTAINER_LOGS_TABLE,
  DEFAULT_CONTAINER_LOG_RETENTION_DAYS,
} from './schema.ts'

describe('buildContainerLogSchemaStatements', () => {
  it('creates only the container_logs table', () => {
    const statements = buildContainerLogSchemaStatements({
      retentionDays: DEFAULT_CONTAINER_LOG_RETENTION_DAYS,
    })
    assertEquals(statements.length, 2)
    assertEquals(CONTAINER_LOGS_TABLE, 'container_logs')
    assertEquals(
      statements[0]!.includes(`CREATE TABLE IF NOT EXISTS ${CONTAINER_LOGS_TABLE}`),
      true
    )
  })

  it('declares the identity columns with the documented types', () => {
    const ddl = buildContainerLogSchemaStatements({ retentionDays: 30 })[0]!
    assertEquals(ddl.includes("timestamp DateTime64(3, 'UTC')"), true)
    assertEquals(ddl.includes('organization_id UUID'), true)
    assertEquals(ddl.includes('server_id UUID'), true)
    assertEquals(ddl.includes('environment_id Nullable(UUID)'), true)
    assertEquals(ddl.includes('service_id Nullable(UUID)'), true)
    assertEquals(ddl.includes('container_id String'), true)
    assertEquals(ddl.includes('stream LowCardinality(String)'), true)
    assertEquals(ddl.includes('message String'), true)
  })

  it('orders by organization, server, service, then time', () => {
    const ddl = buildContainerLogSchemaStatements({ retentionDays: 30 })[0]!
    assertEquals(
      ddl.includes('ORDER BY (organization_id, server_id, service_id, timestamp)'),
      true
    )
    assertEquals(ddl.includes('PARTITION BY toYYYYMM(timestamp)'), true)
    assertEquals(ddl.includes('ENGINE = MergeTree'), true)
  })

  it('embeds configured retentionDays in the TTL on create and alter', () => {
    const statements = buildContainerLogSchemaStatements({ retentionDays: 42 })
    assertEquals(statements[0]!.includes('TTL timestamp + INTERVAL 42 DAY DELETE'), true)
    assertEquals(
      statements.some((sql) => sql.includes('MODIFY TTL timestamp + INTERVAL 42 DAY DELETE')),
      true
    )
  })

  it('rejects non-positive retentionDays', () => {
    assertThrows(
      () => buildContainerLogSchemaStatements({ retentionDays: 0 }),
      TypeError,
      'retentionDays'
    )
    assertThrows(
      () => buildContainerLogSchemaStatements({ retentionDays: 1.5 }),
      TypeError,
      'retentionDays'
    )
  })
})
