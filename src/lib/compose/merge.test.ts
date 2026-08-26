import { assertEquals } from '@std/assert'
import { mergeComposeDocuments, mergeComposeOverlay } from './merge.ts'
import {
  COMPOSE_TAG_KEY,
  isComposeTaggedValue,
  makeComposeTag,
} from './tags.ts'
import {
  emptyComposeDocument,
  type ComposeDocument,
} from './types.ts'
import { yamlToComposeDocument } from './convert.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function docFrom(data: Record<string, unknown>): ComposeDocument {
  return {
    version: 1,
    data,
    presentation: { keyOrder: Object.keys(data), comments: {} },
  }
}

function servicesOf(merged: ComposeDocument): Record<string, Record<string, unknown>> {
  const services = merged.data.services
  if (typeof services !== 'object' || services === null || Array.isArray(services)) {
    throw new TypeError('expected services mapping')
  }
  return services as Record<string, Record<string, unknown>>
}

test('ports: append + unique-key replacement (short syntax)', () => {
  const base = docFrom({
    services: {
      web: {
        image: 'nginx',
        ports: ['8080:80', '127.0.0.1:9000:90'],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        ports: ['8080:80', '3000:3000'],
      },
    },
  })
  const web = servicesOf(mergeComposeOverlay(base, overlay)).web
  assertEquals(web.ports, ['8080:80', '127.0.0.1:9000:90', '3000:3000'])
})

test('ports: long syntax distinct host_ip / protocol keep separate keys', () => {
  const base = docFrom({
    services: {
      web: {
        ports: [
          { target: 80, published: 8080, protocol: 'tcp' },
          { target: 80, published: 8080, protocol: 'udp' },
        ],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        ports: [
          { target: 80, published: 8080, protocol: 'tcp', host_ip: '127.0.0.1' },
          { target: 80, published: 8080, protocol: 'tcp' },
        ],
      },
    },
  })
  const ports = servicesOf(mergeComposeOverlay(base, overlay)).web.ports as unknown[]
  assertEquals(ports.length, 3)
  // Same key as first base entry → overlay entry wins in place.
  assertEquals(ports[0], {
    target: 80,
    published: 8080,
    protocol: 'tcp',
  })
  assertEquals(ports[1], {
    target: 80,
    published: 8080,
    protocol: 'udp',
  })
  assertEquals(ports[2], {
    target: 80,
    published: 8080,
    protocol: 'tcp',
    host_ip: '127.0.0.1',
  })
})

test('volumes: dedup by container target', () => {
  const base = docFrom({
    services: {
      web: {
        volumes: ['data:/var/lib/data', './src:/app:ro'],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        volumes: [
          'cache:/var/lib/data',
          { type: 'volume', source: 'logs', target: '/var/log' },
        ],
      },
    },
  })
  const volumes = servicesOf(mergeComposeOverlay(base, overlay)).web.volumes as unknown[]
  assertEquals(volumes, [
    'cache:/var/lib/data',
    './src:/app:ro',
    { type: 'volume', source: 'logs', target: '/var/log' },
  ])
})

test('secrets and configs: unique key target ?? source', () => {
  const base = docFrom({
    services: {
      web: {
        secrets: ['db_password', { source: 'token', target: '/run/token' }],
        configs: ['app.conf'],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        secrets: [
          // short-syntax key is the string itself (= default target)
          { source: 'db_password' },
          { source: 'token', target: '/run/token' },
          'extra',
        ],
        configs: [
          // default target for short form is source name → replaces app.conf
          { source: 'app.conf', mode: 0o444 },
        ],
      },
    },
  })
  const web = servicesOf(mergeComposeOverlay(base, overlay)).web
  assertEquals(web.secrets, [
    { source: 'db_password' },
    { source: 'token', target: '/run/token' },
    'extra',
  ])
  assertEquals(web.configs, [{ source: 'app.conf', mode: 0o444 }])
})

test('secrets and configs: short and long syntax dedupe by source or target key', () => {
  const base = docFrom({
    services: {
      web: {
        secrets: ['shared_secret', { source: 'mounted', target: '/run/mounted' }],
        configs: ['shared_conf', { source: 'mounted_conf', target: '/etc/mounted' }],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        secrets: [
          { source: 'shared_secret', target: '/run/shared' },
          'mounted',
          { source: 'overlay_only', target: '/run/overlay' },
        ],
        configs: [
          { source: 'shared_conf', mode: 0o444 },
          { source: 'mounted_conf' },
          'overlay_conf',
        ],
      },
    },
  })
  const web = servicesOf(mergeComposeOverlay(base, overlay)).web
  // Short syntax keys on source name; long syntax with explicit target dedupes on target.
  assertEquals(web.secrets, [
    'shared_secret',
    { source: 'mounted', target: '/run/mounted' },
    { source: 'shared_secret', target: '/run/shared' },
    'mounted',
    { source: 'overlay_only', target: '/run/overlay' },
  ])
  assertEquals(web.configs, [
    { source: 'shared_conf', mode: 0o444 },
    { source: 'mounted_conf', target: '/etc/mounted' },
    { source: 'mounted_conf' },
    'overlay_conf',
  ])
})

test('expose / extra_hosts scalar-dedup; dns / tmpfs / env_file plain-append preserves duplicates', () => {
  const base = docFrom({
    services: {
      web: {
        expose: ['80', '443'],
        dns: ['1.1.1.1'],
        dns_search: ['example.com'],
        tmpfs: ['/tmp'],
        env_file: ['.env'],
        extra_hosts: ['db:host-gateway'],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        expose: ['443', '8080'],
        dns: ['1.1.1.1', '8.8.8.8'],
        dns_search: ['example.com', 'internal'],
        tmpfs: ['/tmp', '/run'],
        env_file: ['.env', '.env.local'],
        extra_hosts: ['db:host-gateway', 'cache:host-gateway'],
      },
    },
  })
  const web = servicesOf(mergeComposeOverlay(base, overlay)).web
  // Unique expose / extra_hosts entries are de-duplicated (first position kept).
  assertEquals(web.expose, ['80', '443', '8080'])
  assertEquals(web.extra_hosts, ['db:host-gateway', 'cache:host-gateway'])
  // Docker Compose preserves duplicate entries on these attributes.
  assertEquals(web.dns, ['1.1.1.1', '1.1.1.1', '8.8.8.8'])
  assertEquals(web.dns_search, ['example.com', 'example.com', 'internal'])
  assertEquals(web.tmpfs, ['/tmp', '/tmp', '/run'])
  assertEquals(web.env_file, ['.env', '.env', '.env.local'])
})

test('labels / environment: list form keyed dedup (overlay wins value)', () => {
  const base = docFrom({
    services: {
      web: {
        labels: ['com.example.foo=a', 'com.example.bar=b'],
        environment: ['FOO=1', 'BAR'],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        labels: ['com.example.foo=z', 'com.example.baz=c'],
        environment: ['FOO=2', 'BAZ=3'],
      },
    },
  })
  const web = servicesOf(mergeComposeOverlay(base, overlay)).web
  assertEquals(web.labels, [
    'com.example.foo=z',
    'com.example.bar=b',
    'com.example.baz=c',
  ])
  assertEquals(web.environment, ['FOO=2', 'BAR', 'BAZ=3'])
})

test('labels / environment: list-base + map-overlay merge via duality', () => {
  const base = docFrom({
    services: {
      web: {
        labels: ['com.example.foo=a'],
        environment: ['FOO=1'],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        labels: { 'com.example.foo': 'z', 'com.example.bar': 'b' },
        environment: { FOO: '2', BAR: '3' },
      },
    },
  })
  const web = servicesOf(mergeComposeOverlay(base, overlay)).web
  assertEquals(web.labels, {
    'com.example.foo': 'z',
    'com.example.bar': 'b',
  })
  assertEquals(web.environment, { FOO: '2', BAR: '3' })
})

test('command / entrypoint / healthcheck.test fully replace', () => {
  const base = docFrom({
    services: {
      web: {
        command: ['nginx', '-g', 'daemon off;'],
        entrypoint: ['/entry.sh'],
        healthcheck: { test: ['CMD', 'curl', '-f', 'http://localhost'] },
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        command: ['sleep', 'infinity'],
        entrypoint: ['/bin/sh'],
        healthcheck: { test: ['CMD-SHELL', 'exit 0'] },
      },
    },
  })
  const web = servicesOf(mergeComposeOverlay(base, overlay)).web
  assertEquals(web.command, ['sleep', 'infinity'])
  assertEquals(web.entrypoint, ['/bin/sh'])
  assertEquals(web.healthcheck, { test: ['CMD-SHELL', 'exit 0'] })
})

test('nested mapping recursion and scalar override', () => {
  const base = docFrom({
    services: {
      web: {
        image: 'nginx:alpine',
        deploy: { replicas: 1, resources: { limits: { cpus: '0.5' } } },
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        image: 'nginx:mainline',
        deploy: { resources: { limits: { memory: '128M' } } },
      },
    },
  })
  const web = servicesOf(mergeComposeOverlay(base, overlay)).web
  assertEquals(web.image, 'nginx:mainline')
  assertEquals(web.deploy, {
    replicas: 1,
    resources: { limits: { cpus: '0.5', memory: '128M' } },
  })
})

test('presentation: shifted ports[i] comment paths after append', () => {
  const base: ComposeDocument = {
    version: 1,
    data: {
      services: {
        web: { image: 'nginx', ports: ['80:80'] },
      },
    },
    presentation: {
      keyOrder: ['services'],
      comments: {
        'services.web.ports[0]': { inline: 'base-port' },
      },
    },
  }
  const overlay: ComposeDocument = {
    version: 1,
    data: {
      services: {
        web: { ports: ['443:443'] },
      },
    },
    presentation: {
      keyOrder: ['services'],
      comments: {
        'services.web.ports[0]': { inline: 'overlay-port' },
      },
    },
  }
  const merged = mergeComposeOverlay(base, overlay)
  assertEquals(
    (servicesOf(merged).web.ports as unknown[]),
    ['80:80', '443:443'],
  )
  assertEquals(merged.presentation.comments['services.web.ports[0]']?.inline, 'base-port')
  assertEquals(
    merged.presentation.comments['services.web.ports[1]']?.inline,
    'overlay-port',
  )
})

test('!reset deletes key; !override replaces without append', () => {
  const base = docFrom({
    services: {
      web: {
        image: 'nginx',
        ports: ['80:80'],
        environment: { FOO: '1' },
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        ports: makeComposeTag('override', ['443:443']),
        environment: makeComposeTag('reset', null),
      },
    },
  })
  const web = servicesOf(mergeComposeOverlay(base, overlay)).web
  assertEquals(web.ports, ['443:443'])
  assertEquals('environment' in web, false)
  assertEquals(web.image, 'nginx')
})

test('mergeComposeDocuments left-folds in order', () => {
  const a = docFrom({ services: { web: { image: 'a', ports: ['80:80'] } } })
  const b = docFrom({ services: { web: { ports: ['443:443'] } } })
  const c = docFrom({ services: { web: { image: 'c' } } })
  const merged = mergeComposeDocuments([a, b, c])
  const web = servicesOf(merged).web
  assertEquals(web.image, 'c')
  assertEquals(web.ports, ['80:80', '443:443'])
})

test('base tagged subtree unwrapped when overlay never visits that path', () => {
  const base = docFrom({
    services: {
      web: {
        image: 'nginx',
        ports: makeComposeTag('override', ['80:80']),
      },
    },
  })
  const overlay = docFrom({
    services: {
      db: { image: 'postgres' },
    },
  })
  const merged = mergeComposeOverlay(base, overlay)
  const services = servicesOf(merged)
  assertEquals(services.web.ports, ['80:80'])
  assertEquals(isComposeTaggedValue(services.web.ports), false)
  assertEquals(services.db.image, 'postgres')
})

test('blank overlay returns base with tags resolved', () => {
  const base = docFrom({
    services: {
      web: {
        ports: makeComposeTag('override', [
          makeComposeTag('override', '80:80'),
        ]),
      },
    },
  })
  const merged = mergeComposeOverlay(base, emptyComposeDocument())
  const ports = servicesOf(merged).web.ports
  assertEquals(ports, ['80:80'])
  assertEquals(isComposeTaggedValue(ports), false)
})

test('mergeComposeDocuments single layer resolves base tags', () => {
  const only = docFrom({
    services: {
      web: {
        ports: makeComposeTag('override', ['80:80']),
      },
    },
  })
  const merged = mergeComposeDocuments([only])
  assertEquals(servicesOf(merged).web.ports, ['80:80'])
  assertEquals(isComposeTaggedValue(servicesOf(merged).web.ports), false)
})

test('!override recursively resolves nested sentinels in overlay payload', () => {
  const base = docFrom({
    services: {
      web: { image: 'nginx', ports: ['80:80'] },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        ports: makeComposeTag('override', [
          makeComposeTag('override', '443:443'),
        ]),
      },
    },
  })
  const ports = servicesOf(mergeComposeOverlay(base, overlay)).web.ports
  assertEquals(ports, ['443:443'])
  assertEquals(isComposeTaggedValue(ports), false)
  assertEquals(isComposeTaggedValue((ports as unknown[])[0]), false)
})

test('service name with dots uses ports unique-key and healthcheck.test replace', () => {
  const base = docFrom({
    services: {
      'api.v1': {
        image: 'api',
        ports: ['8080:80'],
        healthcheck: { test: ['CMD', 'curl', '-f', 'http://localhost/old'] },
      },
    },
  })
  const overlay = docFrom({
    services: {
      'api.v1': {
        ports: ['8080:80', '3000:3000'],
        healthcheck: { test: ['CMD-SHELL', 'exit 0'] },
      },
    },
  })
  const svc = servicesOf(mergeComposeOverlay(base, overlay))['api.v1']
  assertEquals(svc.ports, ['8080:80', '3000:3000'])
  assertEquals(svc.healthcheck, { test: ['CMD-SHELL', 'exit 0'] })
})

test('presentation: replaced port keeps overlay comment at replaced index', () => {
  const base: ComposeDocument = {
    version: 1,
    data: {
      services: {
        web: { image: 'nginx', ports: ['80:80'] },
      },
    },
    presentation: {
      keyOrder: ['services'],
      comments: {
        'services.web.ports[0]': { inline: 'base-port' },
      },
    },
  }
  const overlay: ComposeDocument = {
    version: 1,
    data: {
      services: {
        web: { ports: ['80:80'] },
      },
    },
    presentation: {
      keyOrder: ['services'],
      comments: {
        'services.web.ports[0]': { inline: 'overlay-replacement' },
      },
    },
  }
  const merged = mergeComposeOverlay(base, overlay)
  assertEquals(servicesOf(merged).web.ports, ['80:80'])
  assertEquals(
    merged.presentation.comments['services.web.ports[0]']?.inline,
    'overlay-replacement',
  )
  assertEquals(merged.presentation.comments['services.web.ports[1]'], undefined)
})

test('presentation: scalar dedup drops overlay comment for discarded entry', () => {
  const base: ComposeDocument = {
    version: 1,
    data: {
      services: {
        web: { image: 'nginx', expose: ['80'] },
      },
    },
    presentation: {
      keyOrder: ['services'],
      comments: {
        'services.web.expose[0]': { inline: 'base-expose' },
      },
    },
  }
  const overlay: ComposeDocument = {
    version: 1,
    data: {
      services: {
        web: { expose: ['80', '443'] },
      },
    },
    presentation: {
      keyOrder: ['services'],
      comments: {
        'services.web.expose[0]': { inline: 'dup-dropped' },
        'services.web.expose[1]': { inline: 'new-expose' },
      },
    },
  }
  const merged = mergeComposeOverlay(base, overlay)
  assertEquals(servicesOf(merged).web.expose, ['80', '443'])
  assertEquals(
    merged.presentation.comments['services.web.expose[0]']?.inline,
    'base-expose',
  )
  assertEquals(
    merged.presentation.comments['services.web.expose[1]']?.inline,
    'new-expose',
  )
  // No leftover shifted comment from the dropped overlay[0] path.
  assertEquals(
    Object.keys(merged.presentation.comments).sort((a, b) => a.localeCompare(b)),
    ['services.web.expose[0]', 'services.web.expose[1]'],
  )
})

test('yaml overlay ports append onto base image service', () => {
  const base = yamlToComposeDocument(`
services:
  web:
    image: nginx:alpine
    ports:
      - "80:80"  # http
`)
  const overlay = yamlToComposeDocument(`
services:
  web:
    ports:
      - "443:443"  # https
`)
  const merged = mergeComposeOverlay(base, overlay)
  assertEquals(servicesOf(merged).web.ports, ['80:80', '443:443'])
  assertEquals(
    merged.presentation.comments['services.web.ports[1]']?.inline?.includes('https'),
    true,
  )
})

// Keep COMPOSE_TAG_KEY referenced so typos in this file are caught by tsc.
test('COMPOSE_TAG_KEY is stable', () => {
  assertEquals(COMPOSE_TAG_KEY, '__turbopanelComposeTag')
  assertEquals(emptyComposeDocument().data, {})
})

test('depends_on: list form keyed dedup with overlay winning values', () => {
  const base = docFrom({
    services: {
      web: {
        image: 'nginx',
        depends_on: ['db', 'cache'],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        depends_on: ['db:service_healthy', 'redis'],
      },
    },
  })
  const dependsOn = servicesOf(mergeComposeOverlay(base, overlay)).web.depends_on
  assertEquals(dependsOn, ['db:service_healthy', 'cache', 'redis'])
})

test('depends_on: map overlay replaces list base via duality merge', () => {
  const base = docFrom({
    services: {
      web: {
        image: 'nginx',
        depends_on: ['db'],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        depends_on: {
          db: { condition: 'service_healthy' },
          cache: { condition: 'service_started' },
        },
      },
    },
  })
  const dependsOn = servicesOf(mergeComposeOverlay(base, overlay)).web.depends_on
  assertEquals(dependsOn, {
    db: { condition: 'service_healthy' },
    cache: { condition: 'service_started' },
  })
})

test('!reset on overlay service removes service from merged result', () => {
  const base = docFrom({
    services: {
      web: { image: 'nginx' },
      db: { image: 'postgres' },
    },
  })
  const overlay = docFrom({
    services: {
      db: makeComposeTag('reset', null),
    },
  })
  const services = servicesOf(mergeComposeOverlay(base, overlay))
  assertEquals('db' in services, false)
  assertEquals(services.web.image, 'nginx')
})

test('ports: IPv6 bracket host_ip keeps distinct protocol keys', () => {
  const base = docFrom({
    services: {
      web: {
        ports: ['[::1]:8080:80'],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        ports: ['[::1]:8080:80/tcp'],
      },
    },
  })
  const ports = servicesOf(mergeComposeOverlay(base, overlay)).web.ports as string[]
  assertEquals(ports.length, 2)
  assertEquals(ports[0], '[::1]:8080:80')
  assertEquals(ports[1], '[::1]:8080:80/tcp')
})

test('networks at root level deep-merge across overlay', () => {
  const base = docFrom({
    networks: {
      front: { driver: 'bridge' },
    },
    services: {
      web: { image: 'nginx', networks: ['front'] },
    },
  })
  const overlay = docFrom({
    networks: {
      front: { name: 'custom-front' },
      back: {},
    },
  })
  const merged = mergeComposeOverlay(base, overlay)
  const front = (merged.data.networks as Record<string, Record<string, unknown>>).front
  assertEquals(front.driver, 'bridge')
  assertEquals(front.name, 'custom-front')
  assertEquals('back' in (merged.data.networks as object), true)
})

test('root-level secrets mapping deep-merges unique keys', () => {
  const base = docFrom({
    secrets: {
      db_password: { file: './secrets/db.txt' },
      api_token: { file: './secrets/api.txt' },
    },
    services: {
      web: { image: 'nginx', secrets: ['db_password'] },
    },
  })
  const overlay = docFrom({
    secrets: {
      db_password: { file: './overlay/db.txt' },
      extra: { file: './overlay/extra.txt' },
    },
  })
  const merged = mergeComposeOverlay(base, overlay)
  const secrets = merged.data.secrets as Record<string, Record<string, unknown>>
  assertEquals(secrets.db_password, { file: './overlay/db.txt' })
  assertEquals(secrets.api_token, { file: './secrets/api.txt' })
  assertEquals(secrets.extra, { file: './overlay/extra.txt' })
})

test('root-level configs mapping deep-merges unique keys', () => {
  const base = docFrom({
    configs: {
      app_conf: { file: './configs/app.yml' },
    },
    services: {
      web: { image: 'nginx', configs: ['app_conf'] },
    },
  })
  const overlay = docFrom({
    configs: {
      app_conf: { file: './overlay/app.yml', mode: 0o444 },
      extra_conf: { file: './overlay/extra.yml' },
    },
  })
  const merged = mergeComposeOverlay(base, overlay)
  const configs = merged.data.configs as Record<string, Record<string, unknown>>
  assertEquals(configs.app_conf, { file: './overlay/app.yml', mode: 0o444 })
  assertEquals(configs.extra_conf, { file: './overlay/extra.yml' })
})

test('depends_on: bare service names append without condition suffixes', () => {
  const base = docFrom({
    services: {
      web: {
        image: 'nginx',
        depends_on: ['db'],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        depends_on: ['cache', 'redis'],
      },
    },
  })
  const dependsOn = servicesOf(mergeComposeOverlay(base, overlay)).web.depends_on
  assertEquals(dependsOn, ['db', 'cache', 'redis'])
})

test('depends_on: bare duplicate service name lets overlay win keyed slot', () => {
  const base = docFrom({
    services: {
      web: {
        image: 'nginx',
        depends_on: ['db', 'cache'],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        depends_on: ['db'],
      },
    },
  })
  const dependsOn = servicesOf(mergeComposeOverlay(base, overlay)).web.depends_on
  assertEquals(dependsOn, ['db', 'cache'])
})

test('mergeComposeDocuments([]) yields empty compose document', () => {
  const merged = mergeComposeDocuments([])
  assertEquals(merged.data, {})
  assertEquals(merged.presentation.keyOrder, [])
})

test('document whose data is a non-mapping override tag resolves to empty data', () => {
  const tagged = makeComposeTag('override', 'not-a-mapping')
  const doc: ComposeDocument = {
    version: 1,
    data: tagged as unknown as Record<string, unknown>,
    presentation: { keyOrder: [], comments: {} },
  }
  assertEquals(mergeComposeDocuments([doc]).data, {})
})
test('merge unwraps a tagged base scalar when overlay visits the same leaf', () => {
  const base = docFrom({
    services: {
      web: {
        image: makeComposeTag('override', 'nginx'),
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        image: 'httpd',
      },
    },
  })
  assertEquals(servicesOf(mergeComposeOverlay(base, overlay)).web.image, 'httpd')
})

test('ports: number published/target stringify; non-port entries keep a null unique key', () => {
  const base = docFrom({
    services: {
      web: {
        image: 'nginx',
        ports: [{ published: 80, target: 8080 }],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        ports: [
          true,
          { published: { nested: true }, target: 9 },
          { published: 81, target: 8081 },
        ],
      },
    },
  })
  assertEquals(servicesOf(mergeComposeOverlay(base, overlay)).web.ports, [
    { published: 80, target: 8080 },
    true,
    { published: { nested: true }, target: 9 },
    { published: 81, target: 8081 },
  ])
})

test('ports: short form without host; slash protocol; bare IPv6 host', () => {
  const base = docFrom({
    services: {
      web: {
        image: 'nginx',
        ports: ['80'],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        ports: ['8080:80/udp', '[::1]', '90'],
      },
    },
  })
  assertEquals(servicesOf(mergeComposeOverlay(base, overlay)).web.ports, [
    '80',
    '8080:80/udp',
    '[::1]',
    '90',
  ])
})

test('volumes / secrets: skip non-objects; target-less volume; source-only secret', () => {
  const base = docFrom({
    services: {
      web: {
        image: 'nginx',
        volumes: [{ type: 'volume', source: 'data', target: '/data' }],
        secrets: [{ source: 'db' }],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        volumes: [
          12,
          { type: 'volume', source: 'logs' },
          { type: 'bind', source: './a', target: '/a' },
        ],
        secrets: [true, { source: 'api' }, { source: 'db' }],
      },
    },
  })
  const web = servicesOf(mergeComposeOverlay(base, overlay)).web
  assertEquals(web.volumes, [
    { type: 'volume', source: 'data', target: '/data' },
    12,
    { type: 'volume', source: 'logs' },
    { type: 'bind', source: './a', target: '/a' },
  ])
  assertEquals(web.secrets, [{ source: 'db' }, true, { source: 'api' }])
})

test('labels / environment list: non-strings append; colon separator keys', () => {
  const base = docFrom({
    services: {
      web: {
        image: 'nginx',
        labels: ['app=web'],
        environment: ['FOO=1'],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        labels: [42, 'role:api', 'app=web'],
        environment: [null, 'BAR:2', 'FOO=1'],
      },
    },
  })
  const web = servicesOf(mergeComposeOverlay(base, overlay)).web
  assertEquals(web.labels, ['app=web', 42, 'role:api'])
  assertEquals(web.environment, ['FOO=1', null, 'BAR:2'])
})

test('expose: non-primitive entries dedup via JSON.stringify', () => {
  const base = docFrom({
    services: {
      web: {
        image: 'nginx',
        expose: ['80', { port: 81 }],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        expose: [{ port: 81 }, { port: 82 }, '80'],
      },
    },
  })
  assertEquals(servicesOf(mergeComposeOverlay(base, overlay)).web.expose, [
    '80',
    { port: 81 },
    { port: 82 },
  ])
})

test('presentation blankLines: indexed path without a finite index is left alone', () => {
  const base = docFrom({ services: { web: { image: 'nginx' } } })
  const overlay = docFrom({ services: { web: { image: 'httpd' } } })
  overlay.presentation = {
    keyOrder: [],
    comments: {},
    blankLines: { 'services.web[not-an-index].image': 2 },
  }
  const merged = mergeComposeOverlay(base, overlay)
  assertEquals(
    merged.presentation.blankLines?.['services.web[not-an-index].image'],
    2,
  )
})

test('mergeComposeOverlay with omitted or null overlay returns the resolved base', () => {
  const base = docFrom({
    services: {
      web: { image: makeComposeTag('override', 'nginx') },
    },
  })
  assertEquals(servicesOf(mergeComposeOverlay(base)).web.image, 'nginx')
  assertEquals(servicesOf(mergeComposeOverlay(base, null)).web.image, 'nginx')
})

test('overlay comments merge onto base when overlay data is not blank', () => {
  const base = docFrom({ services: { web: { image: 'nginx' } } })
  const overlay: ComposeDocument = {
    version: 1,
    data: { name: 'app' },
    presentation: {
      keyOrder: ['name'],
      comments: { name: { inline: 'kept' } },
    },
  }
  const merged = mergeComposeOverlay(base, overlay)
  assertEquals(merged.data.name, 'app')
  assertEquals(servicesOf(merged).web.image, 'nginx')
  assertEquals(merged.presentation.comments.name?.inline, 'kept')
})

test('undefined overlay children are skipped; type-mismatch overlay wins', () => {
  const base = docFrom({
    services: {
      web: { image: 'nginx', ports: ['80:80'] },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        image: undefined,
        ports: '8080:80',
      },
    },
  })
  const web = servicesOf(mergeComposeOverlay(base, overlay)).web
  assertEquals(web.image, 'nginx')
  assertEquals(web.ports, '8080:80')
})

test('root-level command / entrypoint replace; root-level ports append', () => {
  const base = docFrom({
    command: ['nginx'],
    entrypoint: ['/entry.sh'],
    ports: ['80:80'],
    services: { web: { image: 'nginx' } },
  })
  const overlay = docFrom({
    command: ['sleep', 'infinity'],
    entrypoint: ['/bin/sh'],
    ports: ['443:443'],
  })
  const merged = mergeComposeOverlay(base, overlay)
  assertEquals(merged.data.command, ['sleep', 'infinity'])
  assertEquals(merged.data.entrypoint, ['/bin/sh'])
  assertEquals(merged.data.ports, ['80:80', '443:443'])
})

test('extra_hosts list-base + map-overlay merge via duality', () => {
  const base = docFrom({
    services: {
      web: {
        image: 'nginx',
        extra_hosts: ['db:host-gateway'],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        extra_hosts: { cache: 'host-gateway' },
      },
    },
  })
  assertEquals(servicesOf(mergeComposeOverlay(base, overlay)).web.extra_hosts, {
    db: 'host-gateway',
    cache: 'host-gateway',
  })
})

test('presentation: overlay editorView wins; document comments fall back', () => {
  const base: ComposeDocument = {
    version: 1,
    data: { services: { web: { image: 'nginx' } } },
    presentation: {
      keyOrder: ['services'],
      comments: {},
      documentComment: '# base trailing',
      editorView: 'editor',
    },
  }
  const overlay: ComposeDocument = {
    version: 1,
    data: { services: { web: { image: 'httpd' } } },
    presentation: {
      keyOrder: ['services'],
      comments: {},
      documentCommentBefore: '# overlay leading',
      editorView: 'visual',
    },
  }
  const merged = mergeComposeOverlay(base, overlay)
  assertEquals(merged.presentation.editorView, 'visual')
  assertEquals(merged.presentation.documentComment, '# base trailing')
  assertEquals(merged.presentation.documentCommentBefore, '# overlay leading')
})

test('presentation: #key blank-line suffix remaps with sequence append', () => {
  const base: ComposeDocument = {
    version: 1,
    data: { services: { web: { image: 'nginx', ports: ['80:80'] } } },
    presentation: { keyOrder: ['services'], comments: {} },
  }
  const overlay: ComposeDocument = {
    version: 1,
    data: { services: { web: { ports: ['443:443'] } } },
    presentation: {
      keyOrder: ['services'],
      comments: {},
      blankLines: { 'services.web.ports[0]#key': 2 },
    },
  }
  const merged = mergeComposeOverlay(base, overlay)
  assertEquals(
    merged.presentation.blankLines?.['services.web.ports[1]#key'],
    2,
  )
})

test('volumes single-segment short syntax keys on the whole string', () => {
  const base = docFrom({
    services: {
      web: {
        image: 'nginx',
        volumes: ['data'],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        volumes: ['data', 'logs'],
      },
    },
  })
  assertEquals(servicesOf(mergeComposeOverlay(base, overlay)).web.volumes, [
    'data',
    'logs',
  ])
})

test('secrets with an empty target fall back to source as the unique key', () => {
  const base = docFrom({
    services: {
      web: {
        image: 'nginx',
        secrets: [{ source: 'db', target: '' }],
      },
    },
  })
  const overlay = docFrom({
    services: {
      web: {
        secrets: [{ source: 'db', mode: 0o444 }],
      },
    },
  })
  assertEquals(servicesOf(mergeComposeOverlay(base, overlay)).web.secrets, [
    { source: 'db', mode: 0o444 },
  ])
})

test('ports: numeric short entries stringify for the unique key', () => {
  const base = docFrom({
    services: {
      web: { image: 'nginx', ports: [80] },
    },
  })
  const overlay = docFrom({
    services: {
      web: { ports: [80, 443] },
    },
  })
  assertEquals(servicesOf(mergeComposeOverlay(base, overlay)).web.ports, [80, 443])
})

test('ports: unclosed IPv6 bracket falls back to colon split', () => {
  const base = docFrom({
    services: {
      web: { image: 'nginx', ports: ['[::1:8080:80'] },
    },
  })
  const overlay = docFrom({
    services: {
      web: { ports: ['[::1:8080:80', '90'] },
    },
  })
  assertEquals(servicesOf(mergeComposeOverlay(base, overlay)).web.ports, [
    '[::1:8080:80',
    '90',
  ])
})

test('mergeKeyOrder appends merged keys that were missing from both orders', () => {
  const base: ComposeDocument = {
    version: 1,
    data: { services: { web: { image: 'nginx' } }, networks: { front: {} } },
    presentation: { keyOrder: ['services'], comments: {} },
  }
  const overlay: ComposeDocument = {
    version: 1,
    data: { volumes: { data: {} } },
    presentation: { keyOrder: [], comments: {} },
  }
  const merged = mergeComposeOverlay(base, overlay)
  assertEquals(merged.presentation.keyOrder, ['services', 'networks', 'volumes'])
})

test('expose boolean entries scalar-dedup via String()', () => {
  const base = docFrom({
    services: {
      web: { image: 'nginx', expose: [true, '80'] },
    },
  })
  const overlay = docFrom({
    services: {
      web: { expose: [true, false] },
    },
  })
  assertEquals(servicesOf(mergeComposeOverlay(base, overlay)).web.expose, [
    true,
    '80',
    false,
  ])
})
