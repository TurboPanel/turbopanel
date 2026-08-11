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
