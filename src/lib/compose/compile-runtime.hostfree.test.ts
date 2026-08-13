import { assertEquals } from 'jsr:@std/assert'
import { compileRuntimeComposeDocument } from './compile-runtime.ts'
import { emptyComposeDocument, type ComposeDocument } from './types.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function doc(data: Record<string, unknown>): ComposeDocument {
  return { version: 1, data, presentation: { keyOrder: Object.keys(data), comments: {} } }
}

test('compileRuntimeComposeDocument strips scheduler-only deploy keys', () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: 'nginx',
          deploy: {
            mode: 'replicated',
            replicas: 3,
            placement: { constraints: ['node.labels.role == web'] },
            update_config: { parallelism: 1 },
            rollback_config: { parallelism: 1 },
            endpoint_mode: 'vip',
            resources: { limits: { cpus: '0.5' } },
            restart_policy: { condition: 'on-failure' },
          },
        },
      },
    }),
  )
  const web = compiled.data.services as Record<string, Record<string, unknown>>
  assertEquals(web.web?.image, 'nginx')
  assertEquals(web.web?.deploy, {
    resources: { limits: { cpus: '0.5' } },
    restart_policy: { condition: 'on-failure' },
  })
})

test('compileRuntimeComposeDocument drops empty deploy after stripping', () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: 'nginx',
          deploy: { replicas: 2, mode: 'replicated' },
        },
      },
    }),
  )
  const web = compiled.data.services as Record<string, Record<string, unknown>>
  assertEquals('deploy' in (web.web ?? {}), false)
})

test('compileRuntimeComposeDocument filters to local services and strips remote depends_on', () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: {
          image: 'nginx',
          depends_on: { db: { condition: 'service_started' }, cache: {} },
        },
        db: { image: 'postgres' },
        cache: { image: 'redis' },
      },
    }),
    { localServiceNames: new Set(['web']) },
  )
  const services = compiled.data.services as Record<string, unknown>
  assertEquals(Object.keys(services).sort((a, b) => a.localeCompare(b)), ['web'])
  const web = services.web as Record<string, unknown>
  assertEquals('depends_on' in web, false)
})

test('compileRuntimeComposeDocument sets scale and drops container_name for local replicas > 1', () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: 'nginx', container_name: 'web-uuid' },
      },
    }),
    {
      environmentId: 'env-1',
      localReplicaCounts: new Map([['web', 3]]),
    },
  )
  const web = (compiled.data.services as Record<string, Record<string, unknown>>).web
  assertEquals(web?.scale, 3)
  assertEquals('container_name' in (web ?? {}), false)
  assertEquals(web?.labels, {
    'com.turbopanel.service': 'web',
    'com.turbopanel.environment': 'env-1',
  })
})

test('compileRuntimeComposeDocument rewrites spanning networks as external tpn_* names', () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: 'nginx', networks: ['frontend'] },
      },
      networks: {
        frontend: { driver: 'bridge' },
        unused: { driver: 'bridge' },
      },
    }),
    {
      spanningNetworks: new Map([['frontend', 'tpn_net1']]),
    },
  )
  assertEquals(compiled.data.networks, {
    frontend: { external: true, name: 'tpn_net1' },
  })
})

test('compileRuntimeComposeDocument returns empty document when no services remain', () => {
  const compiled = compileRuntimeComposeDocument(
    doc({ services: { web: { image: 'nginx' } } }),
    { localServiceNames: new Set(['other']) },
  )
  assertEquals(compiled.data, emptyComposeDocument().data)
})

test('compileRuntimeComposeDocument injects spanning default as an external network', () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      services: {
        web: { image: 'nginx' },
      },
    }),
    {
      spanningNetworks: new Map([['default', 'tpn_net_default']]),
    },
  )
  const web = (compiled.data.services as Record<string, Record<string, unknown>>).web
  assertEquals(web?.networks, ['default'])
  assertEquals(compiled.data.networks, {
    default: { external: true, name: 'tpn_net_default' },
  })
})

test('compileRuntimeComposeDocument prunes secrets not referenced by remaining services', () => {
  const compiled = compileRuntimeComposeDocument(
    doc({
      secrets: {
        web_token: { file: '/run/secrets/web' },
        db_token: { file: '/run/secrets/db' },
      },
      services: {
        web: {
          image: 'nginx',
          secrets: [{ source: 'web_token', target: 'token' }],
        },
        db: {
          image: 'postgres',
          secrets: ['db_token'],
        },
      },
    }),
    { localServiceNames: new Set(['web']) },
  )
  assertEquals(compiled.data.secrets, {
    web_token: { file: '/run/secrets/web' },
  })
})
