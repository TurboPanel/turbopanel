/**
 * Optional ClickHouse integration test.
 *
 * Skipped unless `TURBOPANEL_TEST_CLICKHOUSE_URL` is set (never required for
 * default `deno test`). Example against a disposable container:
 *
 * ```sh
 * docker run --rm -d --name tp-ch-test -p 18123:8123 -p 19000:9000 \
 *   clickhouse/clickhouse-server:26.5
 * export TURBOPANEL_TEST_CLICKHOUSE_URL=http://127.0.0.1:18123
 * export TURBOPANEL_TEST_CLICKHOUSE_DATABASE=default
 * export TURBOPANEL_TEST_CLICKHOUSE_USER=default
 * export TURBOPANEL_TEST_CLICKHOUSE_PASSWORD=
 * deno test --allow-env --allow-net src/lib/container-logs/clickhouse/store.integration.test.ts
 * docker rm -f tp-ch-test
 * ```
 */

import { assert, assertEquals } from '@std/assert'
import { it } from '@std/testing/bdd'
import { ClickHouseContainerLogStore } from './store.ts'
import type { ContainerLogEvent } from '../types.ts'

function readOptionalEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name)?.trim() || undefined
  } catch {
    // No --allow-env: treat as unset so the suite stays skippable by default.
    return undefined
  }
}

const testUrl = readOptionalEnv('TURBOPANEL_TEST_CLICKHOUSE_URL')

const ORG = '11111111-1111-4111-8111-111111111111'
const SERVER = '22222222-2222-4222-8222-222222222222'
const SERVICE = '33333333-3333-4333-8333-333333333333'

function events(): ContainerLogEvent[] {
  const now = Date.now()
  return [
    {
      timestamp: new Date(now - 1000).toISOString(),
      organizationId: ORG,
      serverId: SERVER,
      environmentId: null,
      serviceId: SERVICE,
      containerId: 'integration-container',
      stream: 'stdout',
      message: 'integration hello',
    },
    {
      timestamp: new Date(now).toISOString(),
      organizationId: ORG,
      serverId: SERVER,
      environmentId: null,
      serviceId: SERVICE,
      containerId: 'integration-container',
      stream: 'stderr',
      message: 'integration ECONNREFUSED',
    },
  ]
}

it({
  name: 'ClickHouse integration: ingest + query round-trip',
  ignore: !testUrl,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const store = new ClickHouseContainerLogStore({
      url: testUrl!,
      database: readOptionalEnv('TURBOPANEL_TEST_CLICKHOUSE_DATABASE') ?? 'default',
      user: readOptionalEnv('TURBOPANEL_TEST_CLICKHOUSE_USER') ?? 'default',
      password: readOptionalEnv('TURBOPANEL_TEST_CLICKHOUSE_PASSWORD') ?? '',
      retentionDays: 7,
    })
    await store.ingest(events())

    const from = new Date(Date.now() - 3_600_000).toISOString()
    const to = new Date(Date.now() + 60_000).toISOString()

    const page = await store.query({ organizationId: ORG, from, to, serverId: SERVER })
    assert(page.events.length >= 2)
    assertEquals(page.events[0]!.organizationId, ORG)

    const stderrOnly = await store.query({
      organizationId: ORG,
      from,
      to,
      stream: 'stderr',
      search: 'econnrefused',
    })
    assert(stderrOnly.events.length >= 1)
    assertEquals(stderrOnly.events[0]!.stream, 'stderr')

    const otherOrg = await store.query({
      organizationId: '44444444-4444-4444-8444-444444444444',
      from,
      to,
    })
    assertEquals(otherOrg.events.length, 0)
  },
})
