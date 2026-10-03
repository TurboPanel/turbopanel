/**
 * The deploy-time host-level gate, through the real `validateComposeForDeploy`
 * and `lintComposeYaml` — no stand-ins. Every refused case here deployed on
 * trunk before the gate covered it (audit S1, 2026-09-25): these tests are the
 * list of ways a document could reach the daemon host.
 */

import { assertEquals } from '@std/assert'
import { lintComposeYaml } from './lint.ts'
import { composeDocumentToYaml } from './convert.ts'
import { classifyServiceKey } from './field-policy.ts'
import type { ComposeDocument } from './types.ts'
import { validateComposeForDeploy } from './validate-for-deploy.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function doc(data: Record<string, unknown>): ComposeDocument {
  return {
    version: 1,
    data,
    presentation: { keyOrder: Object.keys(data), comments: {} },
  }
}

function web(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    services: {
      web: { image: 'nginx:alpine', mem_limit: '256m', ...extra },
    },
  }
}

/** Refused with the gate off, at `path`; allowed with the gate on. */
function assertGated(data: Record<string, unknown>, path: string): void {
  const off = validateComposeForDeploy(doc(data), {
    composeGatedFieldsEnabled: false,
  })
  assertEquals(off?.kind, 'compose_field_requires_org_opt_in', path)
  assertEquals(
    off?.issues.some((issue) => issue.path === path),
    true,
    `expected an issue at ${path}, got ${JSON.stringify(off?.issues)}`
  )
  assertEquals(
    validateComposeForDeploy(doc(data), { composeGatedFieldsEnabled: true }),
    null,
    `${path} should deploy once the organization turns the gate on`
  )
}

/** Deploys with the gate off: an ordinary document. */
function assertOrdinary(data: Record<string, unknown>): void {
  assertEquals(validateComposeForDeploy(doc(data), { composeGatedFieldsEnabled: false }), null)
}

// --- keys ------------------------------------------------------------------

const NEWLY_GATED_KEYS: Array<[string, unknown]> = [
  ['use_api_socket', true],
  ['volumes_from', ['other']],
  ['uts', 'host'],
  ['cgroup', 'host'],
  ['runtime', 'nvidia'],
  ['device_cgroup_rules', ['c 1:3 mr']],
]

for (const [key, value] of NEWLY_GATED_KEYS) {
  test(`${key} is a gated field`, () => {
    assertEquals(classifyServiceKey(key)?.state, 'gated')
  })

  test(`${key} is refused at deploy until the organization opts in`, () => {
    const data =
      key === 'volumes_from'
        ? {
            services: {
              web: { image: 'nginx:alpine', mem_limit: '256m', [key]: value },
              other: { image: 'busybox', mem_limit: '64m' },
            },
          }
        : web({ [key]: value })
    assertGated(data, `services.web.${key}`)
  })
}

// --- binds -----------------------------------------------------------------

const OUTSIDE_BINDS: Array<[string, unknown]> = [
  ['host root', '/:/host'],
  ['docker socket', '/var/run/docker.sock:/var/run/docker.sock'],
  ['docker socket under /run', '/run/docker.sock:/var/run/docker.sock'],
  ['absolute path', '/etc:/host-etc:ro'],
  ['home directory', '~/.ssh:/root/.ssh'],
  ['parent climb', '../../etc:/e'],
  ['climb hidden mid-path', './a/../../b:/b'],
  ['interpolated source', '${HOME}:/h'],
  ['long syntax bind', { type: 'bind', source: '/etc', target: '/e' }],
  [
    'long syntax npipe',
    {
      type: 'npipe',
      source: '//./pipe/docker_engine',
      target: '//./pipe/docker_engine',
    },
  ],
]

for (const [label, spec] of OUTSIDE_BINDS) {
  test(`a ${label} bind is refused until the organization opts in`, () => {
    assertGated(
      web({ volumes: [spec] }),
      'services.web.volumes[0]' +
        (typeof spec === 'object' && (spec as { type: string }).type === 'bind'
          ? '.source'
          : typeof spec === 'object'
            ? '.type'
            : '')
    )
  })
}

test('binds inside the service directory and named volumes stay ordinary', () => {
  assertOrdinary({
    services: {
      web: {
        image: 'nginx:alpine',
        mem_limit: '256m',
        volumes: [
          './data:/data',
          './config/nginx.conf:/etc/nginx/nginx.conf:ro',
          'data:/var/lib/data',
          '/anonymous',
          { type: 'bind', source: './logs', target: '/logs' },
          { type: 'volume', source: 'data', target: '/more' },
          { type: 'tmpfs', target: '/tmp' },
        ],
      },
    },
    volumes: { data: {} },
  })
})

// --- binds in disguise -----------------------------------------------------

test('a top-level volume that is a bind in disguise is refused', () => {
  assertGated(
    {
      ...web({ volumes: ['hostetc:/e'] }),
      volumes: {
        hostetc: {
          driver: 'local',
          driver_opts: { type: 'none', o: 'bind', device: '/etc' },
        },
      },
    },
    'volumes.hostetc.driver_opts'
  )
})

test('a local volume device on a host path is refused', () => {
  assertGated(
    {
      ...web({ volumes: ['disk:/d'] }),
      volumes: { disk: { driver_opts: { device: '/dev/sda1' } } },
    },
    'volumes.disk.driver_opts.device'
  )
})

test('an NFS volume is ordinary network storage', () => {
  assertOrdinary({
    ...web({ volumes: ['share:/s'] }),
    volumes: {
      share: {
        driver_opts: { type: 'nfs', o: 'addr=10.0.0.5,rw', device: ':/export' },
      },
    },
  })
})

test('a config file outside the service directory is refused', () => {
  assertGated(
    {
      ...web({ configs: ['passwd'] }),
      configs: { passwd: { file: '/etc/passwd' } },
    },
    'configs.passwd.file'
  )
})

test('a secret file that climbs out is refused', () => {
  assertGated(
    {
      ...web({ secrets: ['key'] }),
      secrets: { key: { file: '../../other-tenant/secret' } },
    },
    'secrets.key.file'
  )
})

test('configs and secrets inside the service directory stay ordinary', () => {
  assertOrdinary({
    ...web({ configs: ['app'], secrets: ['key'] }),
    configs: { app: { file: './app.conf' } },
    secrets: { key: { file: 'secret.txt' } },
  })
})

test('an env_file outside the service directory is refused', () => {
  assertGated(web({ env_file: ['/etc/environment'] }), 'services.web.env_file[0]')
})

test('an env_file entry in long form is checked too', () => {
  assertGated(
    web({ env_file: [{ path: '/root/.env', required: false }] }),
    'services.web.env_file[0].path'
  )
})

test('a label_file outside the service directory is refused', () => {
  assertGated(web({ label_file: '/etc/labels' }), 'services.web.label_file')
})

test('a relative env_file stays ordinary', () => {
  assertOrdinary(web({ env_file: ['.env', 'config/app.env'] }))
})

/**
 * Refused with no opt-in: the gate on or off, the deploy is refused with
 * `compose_build_refused`, and the issue at `path` carries `code`.
 */
function assertBuildRefused(data: Record<string, unknown>, path: string, code: string): void {
  for (const composeGatedFieldsEnabled of [false, true]) {
    const refused = validateComposeForDeploy(doc(data), {
      composeGatedFieldsEnabled,
    })
    assertEquals(refused?.kind, 'compose_build_refused', path)
    assertEquals(
      refused?.issues.some(
        (issue) => issue.path === path && 'code' in issue && issue.code === code
      ),
      true,
      `expected ${code} at ${path}, got ${JSON.stringify(refused?.issues)}`
    )
  }
}

function built(build: unknown, extra: Record<string, unknown> = {}) {
  return {
    services: { web: { build, mem_limit: '256m' } },
    ...extra,
  }
}

const BUILD_REFUSALS: Array<[string, unknown, string, string, Record<string, unknown>?]> = [
  ['a build context on the host root', '/', 'services.web.build', 'build_context_outside_project'],
  [
    'a Dockerfile that climbs out',
    { context: '.', dockerfile: '../../Dockerfile' },
    'services.web.build.dockerfile',
    'build_context_outside_project',
  ],
  [
    'a context that climbs out',
    { context: '../other' },
    'services.web.build.context',
    'build_context_outside_project',
  ],
  [
    'an additional build context on a host path',
    { context: '.', additional_contexts: { hostetc: '/etc' } },
    'services.web.build.additional_contexts.hostetc',
    'build_context_outside_project',
  ],
  [
    'a remote context on the metadata address',
    { context: 'http://169.254.169.254/latest/' },
    'services.web.build.context',
    'build_context_internal_url',
  ],
  [
    'an additional context on localhost',
    { context: '.', additional_contexts: { lib: 'https://localhost/lib.tar' } },
    'services.web.build.additional_contexts.lib',
    'build_context_internal_url',
  ],
  [
    'build ssh agent forwarding',
    { context: '.', ssh: ['default'] },
    'services.web.build.ssh[0]',
    'build_ssh_refused',
  ],
  [
    'a build on the host network',
    { context: '.', network: 'host' },
    'services.web.build.network',
    'build_network_refused',
  ],
  [
    'a privileged build',
    { context: '.', privileged: true },
    'services.web.build.privileged',
    'build_privileged_refused',
  ],
  [
    'build entitlements',
    { context: '.', entitlements: ['network.host'] },
    'services.web.build.entitlements',
    'build_entitlements_refused',
  ],
  [
    'an extra host on the metadata address',
    { context: '.', extra_hosts: ['meta:169.254.169.254'] },
    'services.web.build.extra_hosts[0]',
    'build_extra_host_internal',
  ],
  [
    'an extra host on the build host',
    { context: '.', extra_hosts: { gw: 'host-gateway' } },
    'services.web.build.extra_hosts.gw',
    'build_extra_host_internal',
  ],
  [
    'a build secret read from a host file',
    { context: '.', secrets: ['key'] },
    'services.web.build.secrets[0]',
    'build_secret_outside_project',
    { secrets: { key: { file: '/root/.ssh/id_ed25519' } } },
  ],
]

for (const [what, build, path, code, extra] of BUILD_REFUSALS) {
  test(`${what} is refused even with host-level features on`, () => {
    assertBuildRefused(built(build, extra), path, code)
  })
}

test('a relative or remote build context stays ordinary', () => {
  assertOrdinary({
    services: {
      web: { build: { context: './app', dockerfile: 'Dockerfile' }, mem_limit: '256m' },
      api: { build: 'https://github.com/example/api.git#main', mem_limit: '256m' },
      worker: {
        build: {
          context: '.',
          network: 'none',
          extra_hosts: ['db=203.0.113.7'],
          secrets: ['token'],
        },
        mem_limit: '256m',
      },
    },
    secrets: { token: { file: './token.txt' } },
  })
})

test('extends from a file outside the service directory is refused', () => {
  assertGated(
    web({ extends: { service: 'base', file: '/srv/other/compose.yaml' } }),
    'services.web.extends.file'
  )
})

test('the lint pass reports host reach as a non-blocking advisory at save', () => {
  const issues = lintComposeYaml(
    composeDocumentToYaml(doc(web({ volumes: ['/var/run/docker.sock:/var/run/docker.sock'] })))
  )
  const advisory = issues.find((issue) => issue.path === 'services.web.volumes[0]')
  assertEquals(advisory?.code, 'field_requires_org_opt_in')
  assertEquals(advisory?.blocking, false)
  assertEquals(advisory?.message.includes('Docker engine socket'), true)
})
