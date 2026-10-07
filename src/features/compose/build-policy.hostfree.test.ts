/**
 * `build-policy.ts` on its own: which build options are refused, at which
 * path, with which code — and the ordinary builds that are not.
 */

import { assertEquals } from '@std/assert'
import { collectBuildRefusals, internalAddressReason, isBuildRefusalCode } from './build-policy.ts'
import { lintComposeYaml } from './lint.ts'
import { makeComposeTag } from './tags.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

function built(build: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { services: { web: { image: 'x', build } }, ...extra }
}

/** `[path, code]` pairs, in the order they were found. */
function found(data: unknown): Array<[string, string]> {
  return collectBuildRefusals(data).map((r) => [r.path, r.code])
}

const B = 'services.web.build'

const REFUSED: Array<[string, unknown, Array<[string, string]>, Record<string, unknown>?]> = [
  // --- network / privileged / entitlements ---
  ['network host', { network: 'host' }, [[`${B}.network`, 'build_network_refused']]],
  ['a container network', { network: 'container:db' }, [[`${B}.network`, 'build_network_refused']]],
  ['a named network', { network: 'backend' }, [[`${B}.network`, 'build_network_refused']]],
  ['privileged true', { privileged: true }, [[`${B}.privileged`, 'build_privileged_refused']]],
  ['privileged "true"', { privileged: 'true' }, [[`${B}.privileged`, 'build_privileged_refused']]],
  [
    'entitlements',
    { entitlements: ['security.insecure'] },
    [[`${B}.entitlements`, 'build_entitlements_refused']],
  ],
  [
    'empty entitlements',
    { entitlements: [] },
    [[`${B}.entitlements`, 'build_entitlements_refused']],
  ],

  // --- ssh ---
  ['ssh agent, list', { ssh: ['default'] }, [[`${B}.ssh[0]`, 'build_ssh_refused']]],
  ['ssh agent, named id', { ssh: ['github'] }, [[`${B}.ssh[0]`, 'build_ssh_refused']]],
  ['ssh agent, mapping', { ssh: { default: null } }, [[`${B}.ssh.default`, 'build_ssh_refused']]],
  [
    'ssh key outside',
    { ssh: ['deploy=/root/.ssh/id_rsa'] },
    [[`${B}.ssh[0]`, 'build_ssh_refused']],
  ],
  [
    'ssh key climbing, mapping',
    { ssh: { deploy: '../key' } },
    [[`${B}.ssh.deploy`, 'build_ssh_refused']],
  ],
  ['ssh as a scalar', { ssh: 'default' }, [[`${B}.ssh`, 'build_ssh_refused']]],

  // --- secrets ---
  [
    'secret from an absolute file',
    { secrets: ['k'] },
    [[`${B}.secrets[0]`, 'build_secret_outside_project']],
    { secrets: { k: { file: '/etc/shadow' } } },
  ],
  [
    'secret, long form, climbing',
    { secrets: [{ source: 'k', target: 't' }] },
    [[`${B}.secrets[0]`, 'build_secret_outside_project']],
    { secrets: { k: { file: '../../k' } } },
  ],
  [
    'secret from an interpolated file',
    { secrets: ['k'] },
    [[`${B}.secrets[0]`, 'build_secret_outside_project']],
    { secrets: { k: { file: '${HOME}/k' } } },
  ],

  // --- extra_hosts ---
  [
    'extra host, metadata',
    { extra_hosts: ['m:169.254.169.254'] },
    [[`${B}.extra_hosts[0]`, 'build_extra_host_internal']],
  ],
  [
    'extra host, loopback with =',
    { extra_hosts: ['l=127.0.0.1'] },
    [[`${B}.extra_hosts[0]`, 'build_extra_host_internal']],
  ],
  [
    'extra host, IPv6 loopback',
    { extra_hosts: ['l=::1'] },
    [[`${B}.extra_hosts[0]`, 'build_extra_host_internal']],
  ],
  [
    'extra host, bracketed IPv6',
    { extra_hosts: ['l:[::1]'] },
    [[`${B}.extra_hosts[0]`, 'build_extra_host_internal']],
  ],
  [
    'extra host, mapped IPv4',
    { extra_hosts: { l: '::ffff:127.0.0.1' } },
    [[`${B}.extra_hosts.l`, 'build_extra_host_internal']],
  ],
  [
    'extra host, unspecified',
    { extra_hosts: { z: '0.0.0.0' } },
    [[`${B}.extra_hosts.z`, 'build_extra_host_internal']],
  ],
  [
    'extra host, IPv6 link-local',
    { extra_hosts: { l: 'fe80::1' } },
    [[`${B}.extra_hosts.l`, 'build_extra_host_internal']],
  ],
  [
    'extra host, AWS IPv6 metadata',
    { extra_hosts: { m: 'fd00:ec2::254' } },
    [[`${B}.extra_hosts.m`, 'build_extra_host_internal']],
  ],
  [
    'extra host, Alibaba metadata',
    { extra_hosts: { m: '100.100.100.200' } },
    [[`${B}.extra_hosts.m`, 'build_extra_host_internal']],
  ],
  [
    'extra host, host-gateway',
    { extra_hosts: ['gw:host-gateway'] },
    [[`${B}.extra_hosts[0]`, 'build_extra_host_internal']],
  ],
  [
    'extra host, interpolated',
    { extra_hosts: ['x:${IP}'] },
    [[`${B}.extra_hosts[0]`, 'build_extra_host_internal']],
  ],
  [
    'extra host, a name',
    { extra_hosts: ['x:metadata.google.internal'] },
    [[`${B}.extra_hosts[0]`, 'build_extra_host_internal']],
  ],

  // --- context / dockerfile / additional_contexts ---
  ['string context, absolute', '/', [[B, 'build_context_outside_project']]],
  ['string context, climbing', '../app', [[B, 'build_context_outside_project']]],
  ['context in a home', { context: '~/src' }, [[`${B}.context`, 'build_context_outside_project']]],
  [
    'context interpolated',
    { context: '${SRC}' },
    [[`${B}.context`, 'build_context_outside_project']],
  ],
  ['context not a string', { context: null }, [[`${B}.context`, 'build_context_outside_project']]],
  [
    'dockerfile absolute',
    { dockerfile: '/etc/passwd' },
    [[`${B}.dockerfile`, 'build_context_outside_project']],
  ],
  [
    'oci-layout outside',
    { additional_contexts: { o: 'oci-layout:///var/lib/x' } },
    [[`${B}.additional_contexts.o`, 'build_context_outside_project']],
  ],
  [
    'additional context climbing',
    { additional_contexts: { up: '../..' } },
    [[`${B}.additional_contexts.up`, 'build_context_outside_project']],
  ],
  [
    'additional contexts as a list',
    { additional_contexts: ['a=/etc'] },
    [[`${B}.additional_contexts`, 'build_context_outside_project']],
  ],
  ['URL on metadata', 'http://169.254.169.254/latest', [[B, 'build_context_internal_url']]],
  [
    'a public remote context',
    'https://github.com/example/api.git#main',
    [[B, 'build_remote_source_refused']],
  ],
  [
    'github.com shorthand',
    { context: 'github.com/x/y' },
    [[`${B}.context`, 'build_remote_source_refused']],
  ],
  [
    'git@ on a public host',
    { context: 'git@github.com:x/y.git' },
    [[`${B}.context`, 'build_remote_source_refused']],
  ],
  [
    'a public remote additional context',
    { additional_contexts: { r: 'https://example.com/x.tar' } },
    [[`${B}.additional_contexts.r`, 'build_remote_source_refused']],
  ],
  [
    'URL on loopback',
    { context: 'https://127.0.0.1/x.tar' },
    [[`${B}.context`, 'build_context_internal_url']],
  ],
  [
    'URL on decimal loopback',
    { context: 'http://2130706433/x' },
    [[`${B}.context`, 'build_context_internal_url']],
  ],
  [
    'git URL on a numeric host',
    { context: 'git://0x7f.1/x.git' },
    [[`${B}.context`, 'build_context_internal_url']],
  ],
  [
    'URL on RFC 1918',
    { context: 'https://10.0.0.5/x.git' },
    [[`${B}.context`, 'build_context_internal_url']],
  ],
  [
    'URL on localhost',
    { context: 'https://localhost/x.git' },
    [[`${B}.context`, 'build_context_internal_url']],
  ],
  [
    'URL on localhost with a trailing dot',
    { context: 'https://localhost./x.git' },
    [[`${B}.context`, 'build_context_internal_url']],
  ],
  [
    'URL on .internal with a trailing dot',
    { context: 'https://metadata.google.internal./x' },
    [[`${B}.context`, 'build_context_internal_url']],
  ],
  [
    'git@ on localhost with a trailing dot',
    { context: 'git@localhost.:x/y.git' },
    [[`${B}.context`, 'build_context_internal_url']],
  ],
  [
    'URL on .internal',
    { context: 'https://metadata.google.internal/x' },
    [[`${B}.context`, 'build_context_internal_url']],
  ],
  [
    'ssh URL on a bare name',
    { context: 'ssh://gitlab/x.git' },
    [[`${B}.context`, 'build_context_internal_url']],
  ],
  [
    'git@ on loopback',
    { context: 'git@127.0.0.1:x/y.git' },
    [[`${B}.context`, 'build_context_internal_url']],
  ],
  [
    'URL on IPv6 loopback',
    { additional_contexts: { a: 'https://[::1]/x' } },
    [[`${B}.additional_contexts.a`, 'build_context_internal_url']],
  ],
]

for (const [what, build, expected, extra] of REFUSED) {
  test(`refused: ${what}`, () => {
    assertEquals(found(built(build, extra)), expected)
  })
}

const ALLOWED: Array<[string, unknown, Record<string, unknown>?]> = [
  ['nothing', null],
  ['a relative string context', './app'],
  ['the service directory', '.'],
  ['network default and none', { network: 'none' }],
  ['network default', { network: 'default' }],
  ['privileged false', { privileged: false }],
  ['an ssh key inside', { ssh: ['deploy=./keys/deploy'] }],
  [
    'a secret from a file inside',
    { secrets: ['k'] },
    {
      secrets: { k: { file: './k.txt' } },
    },
  ],
  [
    'a secret from the environment',
    { secrets: ['k'] },
    { secrets: { k: { environment: 'TOKEN' } } },
  ],
  ['a secret with no top-level definition', { secrets: ['missing'] }],
  [
    'extra hosts on public and private addresses',
    {
      extra_hosts: ['a:203.0.113.7', 'b=10.1.2.3'],
    },
  ],
  [
    'image and stage contexts',
    {
      additional_contexts: {
        a: 'docker-image://alpine',
        b: 'service:base',
        c: 'target:deps',
        d: './vendor',
      },
    },
  ],
  ['a scalar build that is not a string', 5],
]

for (const [what, build, extra] of ALLOWED) {
  test(`allowed: ${what}`, () => {
    assertEquals(found(built(build, extra)), [])
  })
}

test('a value hidden in an !override is judged like any other', () => {
  const data = built(makeComposeTag('override', { context: '.', network: 'host' }))
  assertEquals(found(data), [[`${B}.network`, 'build_network_refused']])
})

test('services that are not mappings, and documents without services, are skipped', () => {
  assertEquals(found(null), [])
  assertEquals(found({ services: { a: 'x', b: null } }), [])
})

test('every message says no opt-in reaches it', () => {
  for (const refusal of collectBuildRefusals(built({ network: 'host', privileged: true }))) {
    assertEquals(refusal.message.endsWith('whatever the organization allows'), true)
  }
})

test('isBuildRefusalCode accepts the build codes only', () => {
  assertEquals(isBuildRefusalCode('build_ssh_refused'), true)
  assertEquals(isBuildRefusalCode('field_requires_org_opt_in'), false)
  assertEquals(isBuildRefusalCode(undefined), false)
})

test('internalAddressReason leaves public and private unicast addresses alone', () => {
  assertEquals(internalAddressReason('203.0.113.7'), null)
  assertEquals(internalAddressReason('192.168.1.10'), null)
  assertEquals(typeof internalAddressReason('not-an-ip'), 'string')
})

test('lint: advice while editing, an error under strict, with the rule code and line', () => {
  const yaml =
    'services:\n  web:\n    image: x\n    build:\n      context: .\n      network: host\n'
  const relaxed = lintComposeYaml(yaml).filter((i) => i.code === 'build_network_refused')
  assertEquals(
    relaxed.map((i) => [i.path, i.level, i.blocking, i.line]),
    [[`${B}.network`, 'warning', false, 6]]
  )
  const strict = lintComposeYaml(yaml, { strict: true }).filter(
    (i) => i.code === 'build_network_refused'
  )
  assertEquals(
    strict.map((i) => [i.level, i.blocking]),
    [['error', undefined]]
  )
})
