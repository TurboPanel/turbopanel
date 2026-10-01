import { assertEquals } from '@std/assert'
import {
  collectStrategyFacts,
  computeEffectiveStrategy,
  type FallbackReasonCode,
  previewDeployStrategy,
  type StrategyFacts,
} from './deploy-strategy.ts'

const test = Deno.test.bind(Deno)

const HEALTHCHECK = { test: ['CMD', 'true'] }

/** A compose document blue-green accepts: published nothing, healthchecked web, no state. */
function cleanCompose(): Record<string, unknown> {
  return {
    services: {
      web: {
        image: 'ghcr.io/acme/web:1',
        expose: ['3000'],
        healthcheck: HEALTHCHECK,
        volumes: ['./uploads:/uploads:ro'],
      },
      worker: { image: 'acme/worker', restart: 'unless-stopped' },
    },
  }
}

function cleanFacts(): StrategyFacts {
  return collectStrategyFacts(cleanCompose())
}

function codes(facts: StrategyFacts, migrations: 'none' | 'compatible' = 'none'): string[] {
  return computeEffectiveStrategy({
    requested: 'bluegreen',
    migrations,
    facts,
  }).fallbackReasons.map((reason) => reason.code)
}

test('inplace and sequential are always taken as requested, whatever the facts say', () => {
  const dirty = collectStrategyFacts({
    services: { db: { image: 'postgres:16', ports: ['5432:5432'], container_name: 'db' } },
  })
  for (const requested of ['inplace', 'sequential'] as const) {
    for (const migrations of ['none', 'compatible', 'breaking', 'unknown'] as const) {
      assertEquals(computeEffectiveStrategy({ requested, migrations, facts: dirty }), {
        requested,
        effectiveStrategy: requested,
        fallbackReasons: [],
      })
    }
  }
})

test('bluegreen is kept when nothing refuses it', () => {
  for (const migrations of ['none', 'compatible'] as const) {
    assertEquals(
      computeEffectiveStrategy({ requested: 'bluegreen', migrations, facts: cleanFacts() }),
      { requested: 'bluegreen', effectiveStrategy: 'bluegreen', fallbackReasons: [] }
    )
  }
})

const REFUSALS: Array<{
  name: string
  code: FallbackReasonCode
  services: string[]
  compose: unknown
}> = [
  {
    name: 'short host port',
    code: 'host_published_ports',
    services: ['web'],
    compose: { services: { web: { image: 'a', ports: ['8080:80'], healthcheck: HEALTHCHECK } } },
  },
  {
    name: 'short host port with ip and protocol',
    code: 'host_published_ports',
    services: ['web'],
    compose: {
      services: { web: { image: 'a', ports: ['127.0.0.1:53:53/udp'], healthcheck: HEALTHCHECK } },
    },
  },
  {
    name: 'long-syntax published port',
    code: 'host_published_ports',
    services: ['web'],
    compose: {
      services: {
        web: { image: 'a', ports: [{ target: 80, published: 8080 }], healthcheck: HEALTHCHECK },
      },
    },
  },
  {
    name: 'host network',
    code: 'host_published_ports',
    services: ['agent'],
    compose: { services: { agent: { image: 'a', network_mode: 'host' } } },
  },
  {
    name: 'authored container_name',
    code: 'authored_container_name',
    services: ['web'],
    compose: { services: { web: { image: 'a', container_name: 'web', healthcheck: HEALTHCHECK } } },
  },
  {
    name: 'database with a named volume',
    code: 'stateful_writable_volume',
    services: ['db'],
    compose: {
      services: { db: { image: 'postgres:16', volumes: ['pgdata:/var/lib/postgresql/data'] } },
    },
  },
  {
    name: 'custom image on a database port with a named volume',
    code: 'stateful_writable_volume',
    services: ['store'],
    compose: {
      services: { store: { image: 'acme/store:1', ports: ['5432:5432'], volumes: ['d:/x'] } },
    },
  },
  {
    name: 'custom image mounting a mysql data dir',
    code: 'stateful_writable_volume',
    services: ['store'],
    compose: {
      services: { store: { image: 'acme/store:1', volumes: ['d:/var/lib/mysql'] } },
    },
  },
  {
    name: 'clickhouse with a named volume',
    code: 'stateful_writable_volume',
    services: ['ch'],
    compose: {
      services: { ch: { image: 'clickhouse/clickhouse-server:24', volumes: ['c:/data'] } },
    },
  },
  {
    name: 'registry-prefixed redis with a long-syntax bind',
    code: 'stateful_writable_volume',
    services: ['cache'],
    compose: {
      services: {
        cache: {
          image: 'docker.io/library/redis:7@sha256:abc',
          volumes: [{ type: 'bind', source: '/srv/r', target: '/data' }],
        },
      },
    },
  },
  {
    name: 'traffic-facing service with no healthcheck (hosting)',
    code: 'missing_healthcheck',
    services: ['web'],
    compose: {
      services: {
        web: { image: 'a', 'x-turbopanel': { hosting: [{ hostname: 'a.example.com' }] } },
      },
    },
  },
  {
    name: 'traffic-facing service with no healthcheck (expose)',
    code: 'missing_healthcheck',
    services: ['web'],
    compose: { services: { web: { image: 'a', expose: ['80'] } } },
  },
  {
    name: 'disabled healthcheck',
    code: 'missing_healthcheck',
    services: ['web'],
    compose: { services: { web: { image: 'a', expose: ['80'], healthcheck: { disable: true } } } },
  },
  {
    name: 'site service',
    code: 'native_or_cron_service',
    services: ['site'],
    compose: { services: { site: { 'x-turbopanel': { serviceKind: 'site' } } } },
  },
  {
    name: 'node service',
    code: 'native_or_cron_service',
    services: ['app'],
    compose: {
      services: { app: { 'x-turbopanel': { serviceKind: 'node', source: { sourceId: 's' } } } },
    },
  },
  {
    name: 'cron job',
    code: 'native_or_cron_service',
    services: ['jobs'],
    compose: {
      services: {
        jobs: {
          image: 'a',
          'x-turbopanel': { cron: [{ name: 'n', schedule: '* * * * *', command: 'x' }] },
        },
      },
    },
  },
  {
    name: 'docker socket bind',
    code: 'host_level_binds',
    services: ['proxy'],
    compose: {
      services: { proxy: { image: 'a', volumes: ['/var/run/docker.sock:/var/run/docker.sock'] } },
    },
  },
]

for (const refusal of REFUSALS) {
  test(`bluegreen falls back to sequential: ${refusal.name}`, () => {
    const facts = collectStrategyFacts(refusal.compose as Record<string, unknown>)
    const result = computeEffectiveStrategy({ requested: 'bluegreen', migrations: 'none', facts })
    assertEquals(result.effectiveStrategy, 'sequential')
    const reason = result.fallbackReasons.find((r) => r.code === refusal.code)
    assertEquals(reason?.services, refusal.services)
    assertEquals(typeof reason?.message, 'string')
  })
}

test('things that look similar but are not refusals', () => {
  const ok = collectStrategyFacts({
    services: {
      // container-only port does not publish a host port
      a: { image: 'x', ports: ['80'], healthcheck: HEALTHCHECK },
      // read-only data volume on a database is not a writable shared volume
      db: { image: 'postgres:16', volumes: ['pgdata:/data:ro', { type: 'tmpfs', target: '/tmp' }] },
      // an app image that merely contains a database name
      b: { image: 'acme/postgres-admin:1', volumes: ['d:/data'] },
      // one-shot service with no traffic needs no healthcheck
      migrate: { image: 'x', command: ['migrate'] },
      // healthcheck present and not disabled
      c: { image: 'x', expose: ['80'], healthcheck: { test: ['CMD', 'x'], disable: false } },
    },
  })
  assertEquals(codes(ok), [])
})

test('every applicable refusal is reported, in a stable order, with sorted service names', () => {
  const facts = collectStrategyFacts({
    services: {
      zeta: { image: 'a', ports: ['1:1'], container_name: 'z', healthcheck: HEALTHCHECK },
      alpha: { image: 'a', ports: ['2:2'], healthcheck: HEALTHCHECK },
    },
  })
  const result = computeEffectiveStrategy({ requested: 'bluegreen', migrations: 'none', facts })
  assertEquals(
    result.fallbackReasons.map((r) => [r.code, r.services]),
    [
      ['host_published_ports', ['alpha', 'zeta']],
      ['authored_container_name', ['zeta']],
    ]
  )
})

test('migration status: unknown and breaking refuse blue-green, none and compatible allow it', () => {
  const facts = cleanFacts()
  assertEquals(codes(facts, 'none'), [])
  assertEquals(codes(facts, 'compatible'), [])
  const unknown = computeEffectiveStrategy({ requested: 'bluegreen', migrations: 'unknown', facts })
  assertEquals(unknown.effectiveStrategy, 'sequential')
  assertEquals(
    unknown.fallbackReasons.map((r) => r.code),
    ['migration_unknown']
  )
  const breaking = computeEffectiveStrategy({
    requested: 'bluegreen',
    migrations: 'breaking',
    facts,
  })
  assertEquals(breaking.effectiveStrategy, 'sequential')
  assertEquals(
    breaking.fallbackReasons.map((r) => r.code),
    ['migration_breaking']
  )
})

test('a detected migrator contradicts a declared "none" but not "compatible"', () => {
  const facts = { ...cleanFacts(), migratorDetected: true }
  assertEquals(codes(facts, 'none'), ['migrator_undeclared'])
  assertEquals(codes(facts, 'compatible'), [])
})

test('collectStrategyFacts tolerates missing, empty and malformed documents', () => {
  const empty = {
    hostPublishedPorts: [],
    authoredContainerNames: [],
    statefulWritableVolumes: [],
    missingHealthchecks: [],
    nativeOrCron: [],
    hostLevelBinds: [],
    migratorDetected: false,
  }
  assertEquals(collectStrategyFacts(null), empty)
  assertEquals(collectStrategyFacts(undefined), empty)
  assertEquals(collectStrategyFacts({}), empty)
  assertEquals(collectStrategyFacts({ services: 'nope' }), empty)
  assertEquals(collectStrategyFacts({ services: { a: null, b: 'x', c: [] } }), empty)
  assertEquals(collectStrategyFacts({}, { migratorDetected: true }).migratorDetected, true)
})

test('previewDeployStrategy: an environment with no settings previews as inplace', () => {
  assertEquals(
    previewDeployStrategy({
      environmentOptions: null,
      projectOptions: null,
      composeData: cleanCompose(),
    }),
    {
      requested: 'inplace',
      effectiveStrategy: 'inplace',
      fallbackReasons: [],
      migrations: 'unknown',
    }
  )
})

test('previewDeployStrategy: stored settings and what-if overrides', () => {
  const stored = { deployStrategy: 'bluegreen', migrations: 'compatible' }
  const base = {
    environmentOptions: stored,
    projectOptions: null,
    composeData: cleanCompose(),
  }
  assertEquals(previewDeployStrategy(base).effectiveStrategy, 'bluegreen')
  assertEquals(
    previewDeployStrategy({ ...base, override: { migration: 'breaking' } }).fallbackReasons.map(
      (r) => r.code
    ),
    ['migration_breaking']
  )
  assertEquals(
    previewDeployStrategy({ ...base, override: { strategy: 'sequential' } }).requested,
    'sequential'
  )
  assertEquals(
    previewDeployStrategy({ ...base, override: { strategy: null, migration: null } }).requested,
    'bluegreen'
  )
  // A bluegreen environment that never declared migrations falls back.
  const undeclared = previewDeployStrategy({
    environmentOptions: { deployStrategy: 'bluegreen' },
    projectOptions: null,
    composeData: cleanCompose(),
  })
  assertEquals(undeclared.effectiveStrategy, 'sequential')
  assertEquals(
    undeclared.fallbackReasons.map((r) => r.code),
    ['migration_unknown']
  )
})
