import { assert, assertEquals, assertFalse } from '@std/assert'
import { yamlToComposeDocument } from './convert.ts'
import {
  buildEnvironmentConfigView,
  buildVariableConfig,
  type ConfigVariableInput,
  environmentStandsAlone,
} from './config-view.ts'
import { isComposeChainError, resolveComposeLayerChain } from './layer-chain.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

// Placeholder credentials, assembled at run time so no literal credential sits in the source.
const BASE_VALUE = ['placeholder', 'base', 'one'].join('-')
const ENV_VALUE = ['placeholder', 'env', 'two'].join('-')
const TOKEN_VALUE = ['placeholder', 'tok', 'three'].join('-')
const URL_VALUE = ['postgres:', '', `app:${['placeholder', 'url'].join('-')}@db/app`].join('/')

const BASE = `
services:
  web:
    image: nginx:1
    command: serve --port 80
    ports: ["80:80"]
    environment:
      MODE: production
      DB_PASSWORD: ${BASE_VALUE}
    x-turbopanel:
      hosting:
        - hostname: Example.com
  worker:
    image: busybox
  blog:
    x-turbopanel:
      serviceKind: site
      principal: deploy
x-turbopanel:
  principals:
    deploy:
      access: sftp
`

function layers(base: string | null, env: string | null, projectOverlays: string[] = []) {
  const chain = resolveComposeLayerChain({
    projectOptions: {
      compose: base === null ? null : yamlToComposeDocument(base),
      composeOverlays: projectOverlays.map((yaml, index) => ({
        id: `p${index}`,
        name: `p${index}`,
        filename: `p${index}.yml`,
        document: yamlToComposeDocument(yaml),
      })),
    },
    environmentOptions: { compose: env === null ? null : yamlToComposeDocument(env) },
    environmentFilename: 'env.yml',
  })
  if (isComposeChainError(chain)) throw new Error('chain failed')
  return chain
}

function view(
  base: string | null,
  env: string | null,
  variables: { project?: ConfigVariableInput[]; env?: ConfigVariableInput[] } = {},
  projectOverlays: string[] = []
) {
  return buildEnvironmentConfigView({
    layers: layers(base, env, projectOverlays),
    serviceIds: new Map([['web', 'svc-web-id']]),
    projectVariables: variables.project ?? [],
    environmentVariables: variables.env ?? [],
  })
}

function variable(key: string, value: string, isSecret = false): ConfigVariableInput {
  return { id: `id-${key}`, key, value, isSecret, forBuild: false, forRuntime: true }
}

test('an environment with no compose of its own follows the Base and has no changes', () => {
  const result = view(BASE, null)
  assertEquals(result.followsBase, true)
  assertEquals(result.changes, [])
  assertEquals(
    result.effective.services.map((s) => s.name),
    ['web', 'worker', 'blog']
  )
  assert(result.effective.services.every((s) => s.source === 'base'))
  assert(result.effective.services.every((s) => s.rows.every((r) => r.source === 'base')))
  assertEquals(result.effective.services[0]!.serviceId, 'svc-web-id')
  assertEquals(result.effective.services[1]!.serviceId, null)
  assertEquals(result.base.services[0]!.serviceId, null)
})

test('a changed field is reported with both values and where each comes from', () => {
  const result = view(
    BASE,
    `
services:
  web:
    image: nginx:1
    command: serve --port 8080
    environment:
      EXTRA: "1"
`
  )
  assertEquals(result.followsBase, true)
  const byKey = new Map(result.changes.map((c) => [c.key, c]))
  assertEquals(byKey.size, 2)
  const command = byKey.get('svc:web:command')!
  assertEquals(command.kind, 'changed')
  assertEquals(command.label, 'Start command')
  assertEquals(command.baseValue, 'serve --port 80')
  assertEquals(command.baseSource, 'base')
  assertEquals(command.envValue, 'serve --port 8080')
  assertEquals(command.envSource, 'environment')
  assertEquals(command.serviceName, 'web')
  assertEquals(command.serviceId, 'svc-web-id')
  const extra = byKey.get('svc:web:environment.EXTRA')!
  assertEquals(extra.kind, 'added')
  assertEquals(extra.baseValue, null)
  assertEquals(extra.baseSource, null)
  const rows = new Map(result.effective.services[0]!.rows.map((r) => [r.key, r]))
  assertEquals(rows.get('svc:web:command')!.source, 'environment')
  assertEquals(rows.get('svc:web:image')!.source, 'base')
})

test('a service added or removed in the environment is one change, not one per field', () => {
  const result = view(
    BASE,
    `
services:
  cache:
    image: redis:7
  worker: !reset null
`
  )
  const changes = result.changes.map((c) => `${c.kind}:${c.key}`)
  assertEquals(changes, ['added:svc:cache', 'removed:svc:worker'])
  const cache = result.effective.services.find((s) => s.name === 'cache')!
  assertEquals(cache.source, 'environment')
  assertEquals(cache.rows[0]!.source, 'environment')
  assertEquals(result.changes[1]!.baseValue, 'container')
  assertEquals(result.changes[1]!.envValue, null)
})

test('!reset on one field removes it and is reported as removed', () => {
  const result = view(
    BASE,
    `
services:
  web:
    image: nginx:1
    command: !reset null
`
  )
  const command = result.changes.find((c) => c.key === 'svc:web:command')!
  assertEquals(command.kind, 'removed')
  assertEquals(command.baseValue, 'serve --port 80')
  assertEquals(command.envValue, null)
  assertEquals(command.envSource, null)
  assertFalse(result.effective.services[0]!.rows.some((r) => r.key === 'svc:web:command'))
})

test('services: !override stands alone, and the whole environment is its own', () => {
  const env = `
services: !override
  web:
    image: nginx:1
    command: serve --port 80
    ports: ["80:80"]
`
  const result = view(BASE, env)
  assertEquals(result.followsBase, false)
  assert(result.effective.services.every((s) => s.source === 'environment'))
  assert(result.effective.services[0]!.rows.every((r) => r.source === 'environment'))
  const kinds = result.changes.filter((c) => c.serviceName === 'worker').map((c) => c.kind)
  assertEquals(kinds, ['removed'])
  assertEquals(environmentStandsAlone(layers(BASE, env)), true)
  assertEquals(environmentStandsAlone(layers(BASE, 'services: !reset null')), true)
  assertEquals(
    environmentStandsAlone(
      layers(BASE, 'services:\n  web:\n    image: nginx:1\n    restart: always')
    ),
    false
  )
})

test('an extra environment layer can make the environment stand alone', () => {
  const chain = resolveComposeLayerChain({
    projectOptions: { compose: yamlToComposeDocument(BASE) },
    environmentOptions: {
      compose: null,
      composeOverlays: [
        {
          id: 'e1',
          name: 'e1',
          filename: 'e1.yml',
          document: yamlToComposeDocument('services: !override\n  solo:\n    image: alpine'),
        },
      ],
    },
    environmentFilename: 'env.yml',
  })
  if (isComposeChainError(chain)) throw new Error('chain failed')
  assertEquals(environmentStandsAlone(chain), true)
})

test('a project overlay belongs to the Base, not to the environment', () => {
  const result = view(BASE, null, {}, [
    `
services:
  web:
    image: nginx:1
    restart: always
`,
  ])
  assertEquals(result.changes, [])
  const web = result.base.services.find((s) => s.name === 'web')!
  assert(web.rows.some((r) => r.key === 'svc:web:restart' && r.value === 'always'))
})

test('reordering keys or the environment map is not a change', () => {
  const result = view(
    BASE,
    `
services:
  web:
    image: nginx:1
    environment:
      DB_PASSWORD: ${BASE_VALUE}
      MODE: production
`
  )
  assertEquals(result.changes, [])
})

test('x-turbopanel is never returned as such; its useful parts become plain fields', () => {
  const result = view(
    BASE,
    `
services:
  blog:
    x-turbopanel:
      serviceKind: site
      principal: other
  web:
    image: nginx:1
    x-turbopanel:
      hosting:
        - hostname: staging.example.com
          pathPrefix: /app
x-turbopanel:
  principals:
    other:
      access: ssh
`
  )
  const text = JSON.stringify(result)
  assertFalse(text.includes('x-turbopanel'))
  const web = result.effective.services[0]!
  const blog = result.effective.services[2]!
  const user = blog.rows.find((r) => r.field === 'linuxUser')!
  assertEquals(
    [user.label, user.value, user.area, user.source],
    ['Linux user', 'other', 'linuxUser', 'environment']
  )
  const domains = web.rows.filter((r) => r.area === 'domain').map((r) => r.value)
  assertEquals(domains, ['example.com', 'staging.example.com/app'])
  const changeKeys = result.changes.map((c) => c.key).sort()
  assertEquals(changeKeys, [
    'svc:blog:linuxUser',
    'svc:web:domain:staging.example.com/app',
    'user:other',
  ])
  assertEquals(
    result.effective.linuxUsers.map((u) => [u.name, u.access, u.source, u.usedBy]),
    [
      ['deploy', 'sftp', 'base', []],
      ['other', 'ssh', 'environment', ['blog']],
    ]
  )
  assertEquals(result.base.linuxUsers[0]!.usedBy, ['blog'])
})

test('a changed Linux user access level is a change; placement is ignored', () => {
  const result = view(
    BASE,
    `
x-turbopanel:
  principals:
    deploy:
      access: ssh
services:
  web:
    image: nginx:1
    x-turbopanel:
      placement:
        constraints: ["node.labels.zone==a"]
`
  )
  assertEquals(result.changes.length, 1)
  const change = result.changes[0]!
  assertEquals(
    [change.key, change.kind, change.baseValue, change.envValue],
    ['user:deploy', 'changed', 'sftp', 'ssh']
  )
})

test('values that look like credentials are masked but still compared', () => {
  const result = view(
    BASE,
    `
services:
  web:
    image: nginx:1
    command: run --token=${TOKEN_VALUE}
    environment:
      DB_PASSWORD: ${ENV_VALUE}
      DATABASE_URL: ${URL_VALUE}
`
  )
  const text = JSON.stringify(result)
  for (const secret of [BASE_VALUE, ENV_VALUE, TOKEN_VALUE, URL_VALUE]) {
    assertFalse(text.includes(secret), secret)
  }
  const password = result.changes.find((c) => c.key === 'svc:web:environment.DB_PASSWORD')!
  assertEquals(
    [password.kind, password.masked, password.baseValue, password.envValue],
    ['changed', true, null, null]
  )
  const url = result.changes.find((c) => c.key === 'svc:web:environment.DATABASE_URL')!
  assertEquals([url.kind, url.masked], ['added', true])
  const row = result.effective.services[0]!.rows.find(
    (r) => r.key === 'svc:web:environment.DB_PASSWORD'
  )!
  assertEquals([row.value, row.masked], [null, true])
})

test('a service changing kind is reported as a change of kind', () => {
  const result = view(
    BASE,
    `
services:
  blog:
    image: nginx:1
    x-turbopanel:
      serviceKind: container
`
  )
  const change = result.changes.find((c) => c.key === 'svc:blog:kind')!
  assertEquals([change.kind, change.baseValue, change.envValue], ['changed', 'site', 'container'])
})

test('variables: project values are the Base, the environment wins, secrets never carry a value', () => {
  const result = buildVariableConfig(
    [variable('A', '1'), variable('B', 'same'), variable('S', '', true)],
    [variable('B', 'same'), variable('A', '2'), variable('C', 'new'), variable('S', '', true)]
  )
  assertEquals(
    result.base.map((v) => [v.name, v.source]),
    [
      ['A', 'project'],
      ['B', 'project'],
      ['S', 'project'],
    ]
  )
  assertEquals(
    result.effective.map((v) => [v.name, v.value, v.source]),
    [
      ['A', '2', 'environment'],
      ['B', 'same', 'environment'],
      ['C', 'new', 'environment'],
      ['S', null, 'environment'],
    ]
  )
  assertEquals(
    result.changes.map((c) => [c.key, c.kind, c.baseValue, c.baseSource, c.envValue, c.masked]),
    [
      ['var:A', 'changed', '1', 'project', '2', false],
      ['var:C', 'added', null, null, 'new', false],
      ['var:S', 'changed', null, 'project', null, true],
    ]
  )
})

test('variables are part of the full view and follow the same rules', () => {
  const result = view(BASE, null, {
    project: [variable('A', '1')],
    env: [variable('A', '2')],
  })
  assertEquals(
    result.changes.map((c) => c.key),
    ['var:A']
  )
  assertEquals(result.base.variables[0]!.value, '1')
  assertEquals(result.effective.variables[0]!.source, 'environment')
})

test('an empty project and an empty environment give an empty view', () => {
  const result = view(null, null)
  assertEquals(result.followsBase, true)
  assertEquals(result.base, { services: [], variables: [], linuxUsers: [] })
  assertEquals(result.effective, { services: [], variables: [], linuxUsers: [] })
  assertEquals(result.changes, [])
})

test('list-form environment, labels and deep keys flatten into readable rows', () => {
  const result = view(
    `
services:
  web:
    image: nginx
    environment:
      - MODE=prod
      - BARE
    labels:
      a.b: c
    deploy:
      replicas: 2
      resources:
        limits:
          cpus: "1"
`,
    null
  )
  const rows = new Map(result.base.services[0]!.rows.map((r) => [r.field, r]))
  assertEquals(rows.get('environment.MODE')!.value, 'prod')
  assertEquals(rows.get('environment.MODE')!.label, 'Environment variable MODE')
  assertEquals(rows.get('environment.BARE')!.value, '')
  assertEquals(rows.get('labels')!.value, '{ a.b: c }')
  assertEquals(rows.get('deploy.replicas')!.label, 'Instances')
  assertEquals(rows.get('deploy.resources.limits.cpus')!.label, 'Deploy resources limits cpus')
})
