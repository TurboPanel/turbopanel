/**
 * `host-access.ts` on its own: what it finds, and the fingerprint an automated
 * deploy's approval is checked against.
 */

import { assertEquals, assertNotEquals } from '@std/assert'
import {
  collectHostAccessFindings,
  hostAccessCanonical,
  hostAccessFingerprint,
  hostAccessIssues,
} from './host-access.ts'
import { GATED_SERVICE_FIELD_KEYS, HOST_LEVEL_OPT_IN_SENTENCE } from './field-policy.ts'
import { makeComposeTag } from './tags.ts'

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno)

const SOCKET = '/var/run/docker.sock:/var/run/docker.sock'

function stack(web: Record<string, unknown>): Record<string, unknown> {
  return { services: { web: { image: 'traefik:v3', ...web } } }
}

test('an ordinary document has no findings and no fingerprint', async () => {
  const data = stack({ volumes: ['./data:/data', 'cache:/cache'] })
  assertEquals(collectHostAccessFindings(data), [])
  assertEquals(await hostAccessFingerprint(data), null)
})

test('an unrelated edit keeps the fingerprint, so an approval survives it', async () => {
  const before = await hostAccessFingerprint(stack({ volumes: [SOCKET] }))
  const after = await hostAccessFingerprint(
    stack({ image: 'traefik:v3.1', ports: ['80:80'], volumes: [SOCKET] })
  )
  assertNotEquals(before, null)
  assertEquals(after, before)
})

test('changing where a bind points changes the fingerprint', async () => {
  const socket = await hostAccessFingerprint(stack({ volumes: [SOCKET] }))
  const root = await hostAccessFingerprint(stack({ volumes: ['/:/host'] }))
  assertNotEquals(root, socket)
})

test('adding a gated key changes the fingerprint', async () => {
  const bindOnly = await hostAccessFingerprint(stack({ volumes: [SOCKET] }))
  const privileged = await hostAccessFingerprint(stack({ volumes: [SOCKET], privileged: true }))
  assertNotEquals(privileged, bindOnly)
})

test("changing a gated key's value changes the fingerprint", async () => {
  const a = await hostAccessFingerprint(stack({ cap_add: ['NET_ADMIN'] }))
  const b = await hostAccessFingerprint(stack({ cap_add: ['SYS_ADMIN'] }))
  assertNotEquals(a, b)
})

test('the fingerprint does not depend on key order', async () => {
  const a = await hostAccessFingerprint({
    services: {
      web: { image: 'x', volumes: [SOCKET], privileged: true },
      db: { image: 'y', pid: 'host' },
    },
  })
  const b = await hostAccessFingerprint({
    services: {
      db: { pid: 'host', image: 'y' },
      web: { privileged: true, volumes: [SOCKET], image: 'x' },
    },
  })
  assertEquals(a, b)
})

test('a bind hidden inside an !override tag is still found', () => {
  const data = stack({ volumes: makeComposeTag('override', [SOCKET]) })
  assertEquals(
    collectHostAccessFindings(data).map((finding) => finding.path),
    ['services.web.volumes[0]']
  )
})

test("an include of another project's file is found", () => {
  const data = {
    include: ['/srv/users/other/compose.yaml', { path: ['./local.yaml', '/etc/x.yaml'] }],
    services: { web: { image: 'x' } },
  }
  assertEquals(
    collectHostAccessFindings(data).map((finding) => finding.path),
    ['include[0]', 'include[1]']
  )
})

test('an include inside the service directory is found: its content is never checked', () => {
  const data = {
    include: ['./local.yaml', { path: 'data/extra.yaml' }],
    services: { web: { image: 'x' } },
  }
  assertEquals(
    collectHostAccessFindings(data).map((finding) => finding.path),
    ['include[0]', 'include[1]']
  )
})

test('an extends file inside the service directory is found: its content is never checked', () => {
  const findings = collectHostAccessFindings(
    stack({ extends: { service: 'base', file: './data/base.yaml' } })
  )
  assertEquals(
    findings.map((finding) => finding.path),
    ['services.web.extends.file']
  )
})

test('extends without a file (same document) is not host-level', () => {
  assertEquals(
    collectHostAccessFindings({
      services: {
        base: { image: 'x' },
        web: { extends: { service: 'base' } },
      },
    }),
    []
  )
})

test("a bind of the service's own directory is found, in every spelling", () => {
  for (const volume of ['.:/app', './:/app', './.:/app', './/:/app:ro']) {
    assertEquals(
      collectHostAccessFindings(stack({ volumes: [volume] })).map((f) => f.path),
      ['services.web.volumes[0]'],
      volume
    )
  }
  assertEquals(
    collectHostAccessFindings(
      stack({ volumes: [{ type: 'bind', source: './', target: '/app' }] })
    ).map((f) => f.path),
    ['services.web.volumes[0].source']
  )
})

test('a build context of the service directory stays allowed: it only reads', () => {
  assertEquals(collectHostAccessFindings(stack({ build: { context: '.' } })), [])
  assertEquals(collectHostAccessFindings(stack({ build: './' })), [])
})

test('subdirectory binds stay allowed', () => {
  assertEquals(
    collectHostAccessFindings(stack({ volumes: ['./data:/data', './data/sub:/sub', 'data/x:/x'] })),
    []
  )
})

test('hostAccessIssues lists gated keys and value-level reach together', () => {
  const issues = hostAccessIssues(stack({ volumes: [SOCKET], uts: 'host' }))
  assertEquals(issues.map((issue) => issue.path).sort(), [
    'services.web.uts',
    'services.web.volumes[0]',
  ])
})

test('a non-string path is refused rather than trusted', () => {
  const findings = collectHostAccessFindings({
    services: { web: { image: 'x', env_file: [{ path: 42 }] } },
  })
  assertEquals(
    findings.map((finding) => finding.path),
    ['services.web.env_file[0].path']
  )
})

test('the fingerprint is pinned: a recorded approval must keep matching across releases', async () => {
  // Mixed-case, non-ASCII and underscore keys exercise the key ordering the
  // canonical form depends on. If this value changes, every stored approval
  // (environment.metadata.composeHostAccessApproval) silently stops matching.
  const data = {
    services: {
      web: {
        image: 'x',
        privileged: true,
        volumes: [
          {
            type: 'bind',
            source: '/srv',
            target: '/h',
            bind: { propagation: 'rslave', Zeta: 1, élan: 2, _x: 3 },
          },
          '/var/run/docker.sock:/var/run/docker.sock',
        ],
        cap_add: ['SYS_ADMIN'],
      },
      Api: { image: 'y', volumes: ['/etc:/etc:ro'] },
    },
  }
  assertEquals(
    await hostAccessFingerprint(data),
    '34f3b32381ef273e289ed0c9e3da3ff40b8a607fb341b9f6b5a9ec87b5812e7c'
  )
})

// --- every rule, every spelling ---------------------------------------------
//
// Table tests for the host-access gate. Each row is a whole document and the
// exact findings it must produce: path, segments, message text and the authored
// value (the approval fingerprint hashes the value). A row with no findings is
// an allow; every other row is a deny. These pin the gate so a refactor of
// `host-access.ts` cannot change a decision or a sentence unnoticed.

type Segments = Array<string | number>
/** [segments, "what", "reason", authored value] */
type Expected = [Segments, string, string, unknown]

const EMPTY = 'is empty, so it cannot be resolved'
const INTERPOLATED = 'is interpolated, so where it points cannot be checked before deploy'
const BACKSLASH = 'contains a backslash, so where it points cannot be checked'
const ENGINE_SOCKET = 'is the Docker engine socket, which controls every container on the host'
const ABSOLUTE = 'is an absolute path on the host'
const HOME = 'is in a home directory on the host'
const CLIMBS = "climbs out of the service's directory with `..`"
const WHOLE_DIRECTORY =
  "is the service's own directory, which holds the files the daemon deploys from"
const NOT_PLAIN = 'is not a plain path, so it cannot be checked'
const PULLS_UNCHECKED =
  'is read on the host at deploy time, so what it adds never passes this check'

function dotted(segments: Segments): string {
  let out = ''
  for (const segment of segments) {
    if (typeof segment === 'number') out += `[${segment}]`
    else out += out === '' ? segment : `.${segment}`
  }
  return out
}

function findingFor([segments, what, reason, value]: Expected) {
  return {
    path: dotted(segments),
    segments,
    message: `${what} ${reason} \u2014 ${HOST_LEVEL_OPT_IN_SENTENCE}`,
    value,
  }
}

const WEB = ['services', 'web']

const GATE_CASES: Array<[string, unknown, Expected[]]> = [
  // --- services.<name>.volumes, short syntax ---
  [
    'short bind: interpolated spec',
    stack({ volumes: ['${DIR}:/d'] }),
    [[[...WEB, 'volumes', 0], 'bind `${DIR}:/d`', INTERPOLATED, '${DIR}:/d']],
  ],
  [
    'short bind: interpolation with surrounding space',
    stack({ volumes: [' $X:/d '] }),
    [[[...WEB, 'volumes', 0], 'bind ` $X:/d `', INTERPOLATED, ' $X:/d ']],
  ],
  [
    'short bind: absolute',
    stack({ volumes: ['/etc:/e:ro'] }),
    [[[...WEB, 'volumes', 0], 'bind source `/etc`', ABSOLUTE, '/etc:/e:ro']],
  ],
  [
    'short bind: leading space is trimmed',
    stack({ volumes: ['  /etc:/e'] }),
    [[[...WEB, 'volumes', 0], 'bind source `/etc`', ABSOLUTE, '  /etc:/e']],
  ],
  [
    'short bind: engine socket',
    stack({ volumes: [SOCKET] }),
    [[[...WEB, 'volumes', 0], 'bind source `/var/run/docker.sock`', ENGINE_SOCKET, SOCKET]],
  ],
  [
    'short bind: engine socket under /run',
    stack({ volumes: ['/run/docker.sock:/s'] }),
    [
      [
        [...WEB, 'volumes', 0],
        'bind source `/run/docker.sock`',
        ENGINE_SOCKET,
        '/run/docker.sock:/s',
      ],
    ],
  ],
  [
    'short bind: engine socket with trailing slashes',
    stack({ volumes: ['/run/docker.sock//:/s'] }),
    [
      [
        [...WEB, 'volumes', 0],
        'bind source `/run/docker.sock//`',
        ENGINE_SOCKET,
        '/run/docker.sock//:/s',
      ],
    ],
  ],
  [
    'short bind: home directory',
    stack({ volumes: ['~/.ssh:/s'] }),
    [[[...WEB, 'volumes', 0], 'bind source `~/.ssh`', HOME, '~/.ssh:/s']],
  ],
  [
    'short bind: climbs out',
    stack({ volumes: ['../x:/x'] }),
    [[[...WEB, 'volumes', 0], 'bind source `../x`', CLIMBS, '../x:/x']],
  ],
  [
    'short bind: climbs out mid-path',
    stack({ volumes: ['./a/../../b:/x'] }),
    [[[...WEB, 'volumes', 0], 'bind source `./a/../../b`', CLIMBS, './a/../../b:/x']],
  ],
  [
    'short bind: backslash in a dotted source',
    stack({ volumes: ['.\\x:/x'] }),
    [[[...WEB, 'volumes', 0], 'bind source `.\\x`', BACKSLASH, '.\\x:/x']],
  ],
  [
    'short bind: backslash in a bare source',
    stack({ volumes: ['C\\data:/x'] }),
    [[[...WEB, 'volumes', 0], 'bind source `C\\data`', BACKSLASH, 'C\\data:/x']],
  ],
  [
    'short bind: the service directory itself',
    stack({ volumes: ['.:/app'] }),
    [[[...WEB, 'volumes', 0], 'bind source `.`', WHOLE_DIRECTORY, '.:/app']],
  ],
  [
    'short bind: a dot-named subdirectory stays inside',
    stack({ volumes: ['.hidden:/x', './.cache:/c'] }),
    [],
  ],
  ['short volume: anonymous volume', stack({ volumes: ['/anonymous'] }), []],
  ['short volume: named volume', stack({ volumes: ['data:/d', 'data:/d:ro'] }), []],
  ['short volume: named volume with an empty source', stack({ volumes: [':/x'] }), []],
  ['short volume: a slash in a bare source is not a path here', stack({ volumes: ['a/b:/x'] }), []],
  ['short volume: not an array', stack({ volumes: '/etc:/e' }), []],
  [
    'volumes: an entry that is not a string or a mapping',
    stack({ volumes: [42, null, ['/etc:/e']] }),
    [
      [[...WEB, 'volumes', 0], 'volume', 'is not a volume Compose accepts', 42],
      [[...WEB, 'volumes', 1], 'volume', 'is not a volume Compose accepts', null],
      [[...WEB, 'volumes', 2], 'volume', 'is not a volume Compose accepts', ['/etc:/e']],
    ],
  ],

  // --- services.<name>.volumes, long syntax ---
  [
    'long bind: absolute',
    stack({ volumes: [{ type: 'bind', source: '/etc', target: '/e' }] }),
    [[[...WEB, 'volumes', 0, 'source'], 'bind source `/etc`', ABSOLUTE, '/etc']],
  ],
  [
    'long bind: engine socket',
    stack({
      volumes: [{ type: 'bind', source: '/run/docker.sock/', target: '/s' }],
    }),
    [
      [
        [...WEB, 'volumes', 0, 'source'],
        'bind source `/run/docker.sock/`',
        ENGINE_SOCKET,
        '/run/docker.sock/',
      ],
    ],
  ],
  [
    'long bind: no source',
    stack({ volumes: [{ type: 'bind', target: '/e' }] }),
    [[[...WEB, 'volumes', 0, 'source'], 'bind source', NOT_PLAIN, undefined]],
  ],
  [
    'long bind: source is not a string',
    stack({ volumes: [{ type: 'bind', source: 42, target: '/e' }] }),
    [[[...WEB, 'volumes', 0, 'source'], 'bind source', NOT_PLAIN, 42]],
  ],
  [
    'long bind: empty source',
    stack({ volumes: [{ type: 'bind', source: '', target: '/e' }] }),
    [[[...WEB, 'volumes', 0, 'source'], 'bind source ``', EMPTY, '']],
  ],
  [
    'long bind: whitespace source',
    stack({ volumes: [{ type: 'bind', source: '  ', target: '/e' }] }),
    [[[...WEB, 'volumes', 0, 'source'], 'bind source `  `', EMPTY, '  ']],
  ],
  [
    'long bind: interpolated source',
    stack({ volumes: [{ type: 'bind', source: '${X}/d', target: '/e' }] }),
    [[[...WEB, 'volumes', 0, 'source'], 'bind source `${X}/d`', INTERPOLATED, '${X}/d']],
  ],
  [
    'long bind: home directory',
    stack({ volumes: [{ type: 'bind', source: '~', target: '/e' }] }),
    [[[...WEB, 'volumes', 0, 'source'], 'bind source `~`', HOME, '~']],
  ],
  [
    'long bind: climbs out',
    stack({ volumes: [{ type: 'bind', source: '..', target: '/e' }] }),
    [[[...WEB, 'volumes', 0, 'source'], 'bind source `..`', CLIMBS, '..']],
  ],
  [
    'long bind: backslash',
    stack({ volumes: [{ type: 'bind', source: 'a\\b', target: '/e' }] }),
    [[[...WEB, 'volumes', 0, 'source'], 'bind source `a\\b`', BACKSLASH, 'a\\b']],
  ],
  [
    'long bind: the service directory itself, any spelling',
    stack({
      volumes: [
        { type: 'bind', source: '.', target: '/a' },
        { type: 'bind', source: './', target: '/b' },
        { type: 'bind', source: '././', target: '/c' },
      ],
    }),
    [
      [[...WEB, 'volumes', 0, 'source'], 'bind source `.`', WHOLE_DIRECTORY, '.'],
      [[...WEB, 'volumes', 1, 'source'], 'bind source `./`', WHOLE_DIRECTORY, './'],
      [[...WEB, 'volumes', 2, 'source'], 'bind source `././`', WHOLE_DIRECTORY, '././'],
    ],
  ],
  [
    'long bind: a subdirectory stays inside',
    stack({ volumes: [{ type: 'bind', source: './logs', target: '/l' }] }),
    [],
  ],
  [
    'long mount: npipe reaches the host',
    stack({ volumes: [{ type: 'npipe', source: '//./pipe/x', target: '/p' }] }),
    [
      [
        [...WEB, 'volumes', 0, 'type'],
        'mount type `npipe`',
        'reaches the host outside a named volume',
        { type: 'npipe', source: '//./pipe/x', target: '/p' },
      ],
    ],
  ],
  [
    'long mount: an unknown type reaches the host',
    stack({ volumes: [{ type: 'cluster', target: '/p' }] }),
    [
      [
        [...WEB, 'volumes', 0, 'type'],
        'mount type `cluster`',
        'reaches the host outside a named volume',
        { type: 'cluster', target: '/p' },
      ],
    ],
  ],
  [
    'long mount: volume, tmpfs, image and no type never touch the host',
    stack({
      volumes: [
        { type: 'volume', source: 'data', target: '/a' },
        { type: 'tmpfs', target: '/b' },
        { type: 'image', source: 'img', target: '/c' },
        { source: 'data', target: '/d' },
        { type: 7, source: 'data', target: '/e' },
      ],
    }),
    [],
  ],

  // --- env_file / label_file ---
  [
    'env_file: a string outside',
    stack({ env_file: '/etc/env' }),
    [[[...WEB, 'env_file'], 'env_file `/etc/env`', ABSOLUTE, '/etc/env']],
  ],
  ['env_file: a relative string', stack({ env_file: '.env' }), []],
  ['env_file: absent or null', stack({ env_file: null }), []],
  [
    'env_file: a list of strings and mappings',
    stack({
      env_file: [
        'ok.env',
        '../x.env',
        { path: '~/x.env' },
        {
          path: 'y.env',
          required: false,
        },
      ],
    }),
    [
      [[...WEB, 'env_file', 1], 'env_file `../x.env`', CLIMBS, '../x.env'],
      [[...WEB, 'env_file', 2, 'path'], 'env_file `~/x.env`', HOME, '~/x.env'],
    ],
  ],
  [
    'env_file: entries that are not paths',
    stack({ env_file: [null, 5, {}] }),
    [
      [[...WEB, 'env_file', 0], 'env_file', NOT_PLAIN, null],
      [[...WEB, 'env_file', 1], 'env_file', NOT_PLAIN, 5],
      [[...WEB, 'env_file', 2, 'path'], 'env_file', NOT_PLAIN, undefined],
    ],
  ],
  [
    'env_file: a scalar that is not a string',
    stack({ env_file: 5 }),
    [[[...WEB, 'env_file'], 'env_file', NOT_PLAIN, 5]],
  ],
  [
    'env_file: empty string',
    stack({ env_file: [''] }),
    [[[...WEB, 'env_file', 0], 'env_file ``', EMPTY, '']],
  ],
  [
    'env_file: interpolated',
    stack({ env_file: ['${DIR}/e'] }),
    [[[...WEB, 'env_file', 0], 'env_file `${DIR}/e`', INTERPOLATED, '${DIR}/e']],
  ],
  [
    'env_file: backslash',
    stack({ env_file: ['a\\e'] }),
    [[[...WEB, 'env_file', 0], 'env_file `a\\e`', BACKSLASH, 'a\\e']],
  ],
  [
    'env_file: engine socket',
    stack({ env_file: ['/var/run/docker.sock'] }),
    [
      [
        [...WEB, 'env_file', 0],
        'env_file `/var/run/docker.sock`',
        ENGINE_SOCKET,
        '/var/run/docker.sock',
      ],
    ],
  ],
  [
    'label_file: a list, checked like env_file',
    stack({ label_file: ['l.txt', '/etc/labels', { path: '../l' }] }),
    [
      [[...WEB, 'label_file', 1], 'label_file `/etc/labels`', ABSOLUTE, '/etc/labels'],
      [[...WEB, 'label_file', 2, 'path'], 'label_file `../l`', CLIMBS, '../l'],
    ],
  ],
  [
    'label_file: a string outside',
    stack({ label_file: '/etc/labels' }),
    [[[...WEB, 'label_file'], 'label_file `/etc/labels`', ABSOLUTE, '/etc/labels']],
  ],

  // --- services.<name>.build ---
  ['build: nothing', stack({ build: null }), []],
  ['build: a string that is not a path or URL type', stack({ build: 5 }), []],
  ['build: a list is not checked', stack({ build: ['/'] }), []],
  [
    'build: a string context outside',
    stack({ build: '/' }),
    [[[...WEB, 'build'], 'build context `/`', ABSOLUTE, '/']],
  ],
  [
    'build: a string context that climbs',
    stack({ build: '../app' }),
    [[[...WEB, 'build'], 'build context `../app`', CLIMBS, '../app']],
  ],
  ['build: remote string contexts', stack({ build: 'git@github.com:x/y.git' }), []],
  [
    'build: remote URL, github.com and git@ contexts',
    {
      services: {
        a: { build: 'https://example.com/x.git#main' },
        b: { build: 'github.com/x/y' },
        c: { build: { context: 'GITHUB.com/x/y' } },
        d: { build: { context: 'git@host:x/y.git' } },
        e: { build: { context: 'ssh://host/x' } },
      },
    },
    [],
  ],
  [
    'build: object context outside',
    stack({ build: { context: '/srv' } }),
    [[[...WEB, 'build', 'context'], 'build context `/srv`', ABSOLUTE, '/srv']],
  ],
  [
    'build: object context that is not a string',
    stack({ build: { context: 42 } }),
    [[[...WEB, 'build', 'context'], 'build context', NOT_PLAIN, 42]],
  ],
  [
    'build: object context that is null',
    stack({ build: { context: null } }),
    [[[...WEB, 'build', 'context'], 'build context', NOT_PLAIN, null]],
  ],
  ['build: object without a context', stack({ build: { dockerfile: 'Dockerfile' } }), []],
  ['build: object context inside', stack({ build: { context: './app' } }), []],
  [
    'build: dockerfile outside',
    stack({ build: { context: '.', dockerfile: '/Dockerfile' } }),
    [[[...WEB, 'build', 'dockerfile'], 'Dockerfile `/Dockerfile`', ABSOLUTE, '/Dockerfile']],
  ],
  [
    'build: dockerfile that is not a string',
    stack({ build: { dockerfile: null } }),
    [[[...WEB, 'build', 'dockerfile'], 'Dockerfile', NOT_PLAIN, null]],
  ],
  [
    'build: additional_contexts skips remote, docker-image and service',
    stack({
      build: {
        additional_contexts: {
          a: 'https://x/y.git',
          b: 'docker-image://alpine',
          c: 'service:base',
          d: './local',
        },
      },
    }),
    [],
  ],
  [
    'build: additional_contexts outside, climbing and not a string',
    stack({
      build: {
        additional_contexts: { a: '/etc', b: '../up', c: 7, d: '${X}' },
      },
    }),
    [
      [
        [...WEB, 'build', 'additional_contexts', 'a'],
        'additional build context `/etc`',
        ABSOLUTE,
        '/etc',
      ],
      [
        [...WEB, 'build', 'additional_contexts', 'b'],
        'additional build context `../up`',
        CLIMBS,
        '../up',
      ],
      [[...WEB, 'build', 'additional_contexts', 'c'], 'additional build context', NOT_PLAIN, 7],
      [
        [...WEB, 'build', 'additional_contexts', 'd'],
        'additional build context `${X}`',
        INTERPOLATED,
        '${X}',
      ],
    ],
  ],
  [
    'build: additional_contexts as a list',
    stack({
      build: { additional_contexts: ['a=/etc'] },
    }),
    [
      [
        [...WEB, 'build', 'additional_contexts'],
        'additional build contexts',
        'are a list, so the paths they name cannot be checked',
        ['a=/etc'],
      ],
    ],
  ],
  [
    'build: additional_contexts as a scalar is ignored',
    stack({ build: { additional_contexts: 'x' } }),
    [],
  ],
  [
    'build: ssh, even when empty or false',
    stack({ build: { ssh: ['default'] } }),
    [
      [
        [...WEB, 'build', 'ssh'],
        'build ssh',
        "forwards the host's SSH agent or keys into the build",
        ['default'],
      ],
    ],
  ],
  [
    'build: ssh false is still a finding',
    stack({ build: { ssh: false } }),
    [
      [
        [...WEB, 'build', 'ssh'],
        'build ssh',
        "forwards the host's SSH agent or keys into the build",
        false,
      ],
    ],
  ],
  [
    'build: network host',
    stack({ build: { network: 'host' } }),
    [
      [
        [...WEB, 'build', 'network'],
        'build network `host`',
        "shares the host's network stack",
        'host',
      ],
    ],
  ],
  ['build: other networks', stack({ build: { network: 'none' } }), []],
  [
    'build: privileged true',
    stack({ build: { privileged: true } }),
    [[[...WEB, 'build', 'privileged'], 'privileged build', 'runs with full host privileges', true]],
  ],
  ['build: privileged that is not exactly true', stack({ build: { privileged: 'true' } }), []],
  ['build: privileged false', stack({ build: { privileged: false } }), []],
  [
    'build: entitlements, even when empty',
    stack({ build: { entitlements: [] } }),
    [
      [
        [...WEB, 'build', 'entitlements'],
        'build entitlements',
        'grant the build host-level privileges',
        [],
      ],
    ],
  ],
  [
    'build: every rule at once, in order',
    stack({
      build: {
        context: '/',
        dockerfile: '../D',
        additional_contexts: { x: '/x' },
        ssh: true,
        network: 'host',
        privileged: true,
        entitlements: ['security.insecure'],
      },
    }),
    [
      [[...WEB, 'build', 'context'], 'build context `/`', ABSOLUTE, '/'],
      [[...WEB, 'build', 'dockerfile'], 'Dockerfile `../D`', CLIMBS, '../D'],
      [
        [...WEB, 'build', 'additional_contexts', 'x'],
        'additional build context `/x`',
        ABSOLUTE,
        '/x',
      ],
      [
        [...WEB, 'build', 'ssh'],
        'build ssh',
        "forwards the host's SSH agent or keys into the build",
        true,
      ],
      [
        [...WEB, 'build', 'network'],
        'build network `host`',
        "shares the host's network stack",
        'host',
      ],
      [[...WEB, 'build', 'privileged'], 'privileged build', 'runs with full host privileges', true],
      [
        [...WEB, 'build', 'entitlements'],
        'build entitlements',
        'grant the build host-level privileges',
        ['security.insecure'],
      ],
    ],
  ],

  // --- extends ---
  [
    'extends: a file inside',
    stack({ extends: { file: './base.yaml', service: 'b' } }),
    [[[...WEB, 'extends', 'file'], 'extends file `./base.yaml`', PULLS_UNCHECKED, './base.yaml']],
  ],
  [
    'extends: an empty file name is still a file',
    stack({ extends: { file: '' } }),
    [[[...WEB, 'extends', 'file'], 'extends file ``', PULLS_UNCHECKED, '']],
  ],
  [
    'extends: a number is named as written',
    stack({ extends: { file: 42 } }),
    [[[...WEB, 'extends', 'file'], 'extends file `42`', PULLS_UNCHECKED, 42]],
  ],
  [
    'extends: a null file is still a file',
    stack({ extends: { file: null } }),
    [[[...WEB, 'extends', 'file'], 'extends file `null`', PULLS_UNCHECKED, null]],
  ],
  ['extends: no file', stack({ extends: { service: 'base' } }), []],
  ['extends: not a mapping', stack({ extends: 'base' }), []],

  // --- top-level volumes ---
  ['volumes: not a mapping', { services: {}, volumes: ['a'] }, []],
  [
    'volumes: an entry that is not a mapping, or has no driver_opts',
    {
      volumes: {
        a: null,
        b: 'x',
        c: {},
        d: { driver_opts: 'x' },
        e: { driver_opts: [] },
      },
    },
    [],
  ],
  [
    'volumes: an explicit name reaches a volume the stack may not own',
    { volumes: { a: { name: 'other_stack_data' } } },
    [
      [
        ['volumes', 'a', 'name'],
        'volume `a`',
        'names a Docker volume on the host, which may belong to another stack',
        'other_stack_data',
      ],
    ],
  ],
  [
    'volumes: external uses a volume the stack does not own',
    { volumes: { a: { external: true } } },
    [
      [
        ['volumes', 'a', 'external'],
        'volume `a`',
        'uses a Docker volume the stack does not own',
        true,
      ],
    ],
  ],
  ['volumes: external false is an ordinary volume', { volumes: { a: { external: false } } }, []],
  [
    'volumes: named volume with harmless options',
    {
      volumes: {
        a: { driver_opts: { o: 'rw,noatime', type: 'tmpfs', device: 'tmpfs' } },
      },
    },
    [],
  ],
  [
    'volumes: o: bind',
    { volumes: { a: { driver_opts: { o: 'bind' } } } },
    [
      [
        ['volumes', 'a', 'driver_opts'],
        'volume `a`',
        'is a bind mount of a host path in disguise',
        { o: 'bind' },
      ],
    ],
  ],
  [
    'volumes: o: rbind among other flags, with spaces',
    {
      volumes: { a: { driver_opts: { o: 'ro, rbind ,nosuid' } } },
    },
    [
      [
        ['volumes', 'a', 'driver_opts'],
        'volume `a`',
        'is a bind mount of a host path in disguise',
        { o: 'ro, rbind ,nosuid' },
      ],
    ],
  ],
  [
    'volumes: a flag that merely contains bind',
    {
      volumes: { a: { driver_opts: { o: 'bindx,unbind' } } },
    },
    [],
  ],
  [
    'volumes: type none',
    { volumes: { a: { driver_opts: { type: 'none' } } } },
    [
      [
        ['volumes', 'a', 'driver_opts'],
        'volume `a`',
        'is a bind mount of a host path in disguise',
        { type: 'none' },
      ],
    ],
  ],
  [
    'volumes: type bind, padded',
    {
      volumes: { a: { driver_opts: { type: ' bind ' } } },
    },
    [
      [
        ['volumes', 'a', 'driver_opts'],
        'volume `a`',
        'is a bind mount of a host path in disguise',
        { type: ' bind ' },
      ],
    ],
  ],
  [
    'volumes: an o that is not a string is no flag',
    {
      volumes: { a: { driver_opts: { o: ['bind'] } } },
    },
    [],
  ],
  [
    'volumes: a bind in disguise wins over its device (one finding)',
    {
      volumes: { a: { driver_opts: { o: 'bind', device: '/etc' } } },
    },
    [
      [
        ['volumes', 'a', 'driver_opts'],
        'volume `a`',
        'is a bind mount of a host path in disguise',
        { o: 'bind', device: '/etc' },
      ],
    ],
  ],
  [
    'volumes: host device',
    {
      volumes: { a: { driver_opts: { device: '/dev/sda1' } } },
    },
    [
      [
        ['volumes', 'a', 'driver_opts', 'device'],
        'volume `a` device `/dev/sda1`',
        'mounts a host path',
        { device: '/dev/sda1' },
      ],
    ],
  ],
  [
    'volumes: host device with leading space',
    {
      volumes: { a: { driver_opts: { device: ' /dev/x' } } },
    },
    [
      [
        ['volumes', 'a', 'driver_opts', 'device'],
        'volume `a` device ` /dev/x`',
        'mounts a host path',
        { device: ' /dev/x' },
      ],
    ],
  ],
  [
    'volumes: host device with an unrelated type',
    {
      volumes: { a: { driver_opts: { type: 'ext4', device: '/dev/sda1' } } },
    },
    [
      [
        ['volumes', 'a', 'driver_opts', 'device'],
        'volume `a` device `/dev/sda1`',
        'mounts a host path',
        { type: 'ext4', device: '/dev/sda1' },
      ],
    ],
  ],
  [
    'volumes: a type that is not a string leaves the device a host path',
    {
      volumes: { a: { driver_opts: { type: 1, device: '/x' } } },
    },
    [
      [
        ['volumes', 'a', 'driver_opts', 'device'],
        'volume `a` device `/x`',
        'mounts a host path',
        { type: 1, device: '/x' },
      ],
    ],
  ],
  [
    'volumes: network filesystem types are not host paths',
    {
      volumes: {
        a: { driver_opts: { type: 'nfs', device: '/export' } },
        b: { driver_opts: { type: 'nfs4', device: '/export' } },
        c: { driver_opts: { type: ' cifs ', device: '/export' } },
        d: { driver_opts: { type: 'smb', device: '/export' } },
        e: { driver_opts: { type: 'smb3', device: '/export' } },
        f: { driver_opts: { type: 'glusterfs', device: '/export' } },
        g: { driver_opts: { type: 'ceph', device: '/export' } },
      },
    },
    [],
  ],
  [
    'volumes: the network filesystem type is case sensitive',
    {
      volumes: { a: { driver_opts: { type: 'NFS', device: '/export' } } },
    },
    [
      [
        ['volumes', 'a', 'driver_opts', 'device'],
        'volume `a` device `/export`',
        'mounts a host path',
        { type: 'NFS', device: '/export' },
      ],
    ],
  ],
  [
    'volumes: a relative or remote device is not a host path',
    {
      volumes: {
        a: { driver_opts: { device: ':/export' } },
        b: { driver_opts: { device: 'rel/x' } },
        c: { driver_opts: { device: 5 } },
      },
    },
    [],
  ],

  // --- configs / secrets ---
  ['configs and secrets: not mappings', { configs: ['a'], secrets: 'x' }, []],
  [
    'configs and secrets: entries that are not files',
    {
      configs: { a: null, b: { environment: 'X' }, c: { content: 'x' } },
      secrets: { a: 'x', b: { external: true } },
    },
    [],
  ],
  [
    'configs: file outside',
    { configs: { a: { file: '/etc/passwd' } } },
    [[['configs', 'a', 'file'], 'config file `/etc/passwd`', ABSOLUTE, '/etc/passwd']],
  ],
  [
    'secrets: file climbing',
    { secrets: { a: { file: '../s' } } },
    [[['secrets', 'a', 'file'], 'secret file `../s`', CLIMBS, '../s']],
  ],
  [
    'secrets: file that is not a string',
    { secrets: { a: { file: 3 } } },
    [[['secrets', 'a', 'file'], 'secret file', NOT_PLAIN, 3]],
  ],
  [
    'configs: interpolated and empty files',
    {
      configs: { a: { file: '$X' }, b: { file: '' } },
    },
    [
      [['configs', 'a', 'file'], 'config file `$X`', INTERPOLATED, '$X'],
      [['configs', 'b', 'file'], 'config file ``', EMPTY, ''],
    ],
  ],
  [
    'configs and secrets: files inside',
    {
      configs: { a: { file: './a.conf' } },
      secrets: { a: { file: 's.txt' } },
    },
    [],
  ],

  // --- include ---
  ['include: absent, null', { include: null, services: {} }, []],
  [
    'include: a single string',
    { include: './x.yaml' },
    [[['include', 0], 'included file `./x.yaml`', PULLS_UNCHECKED, './x.yaml']],
  ],
  [
    'include: a single mapping',
    { include: { path: 'x.yaml' } },
    [[['include', 0], 'include entry', PULLS_UNCHECKED, { path: 'x.yaml' }]],
  ],
  [
    'include: a list of strings and mappings',
    {
      include: ['a.yaml', { path: ['b.yaml'] }, 7],
    },
    [
      [['include', 0], 'included file `a.yaml`', PULLS_UNCHECKED, 'a.yaml'],
      [['include', 1], 'include entry', PULLS_UNCHECKED, { path: ['b.yaml'] }],
      [['include', 2], 'include entry', PULLS_UNCHECKED, 7],
    ],
  ],

  // --- document shape ---
  ['shape: a document that is not a mapping', ['services'], []],
  ['shape: null', null, []],
  ['shape: services that is not a mapping', { services: ['web'] }, []],
  [
    'shape: a service that is not a mapping is skipped',
    {
      services: { web: 'x', api: null, db: { volumes: ['/etc:/e'] } },
    },
    [[['services', 'db', 'volumes', 0], 'bind source `/etc`', ABSOLUTE, '/etc:/e']],
  ],
  [
    'shape: findings come service by service, then top-level in a fixed order',
    {
      include: ['i.yaml'],
      secrets: { s: { file: '/s' } },
      configs: { c: { file: '/c' } },
      volumes: { v: { driver_opts: { type: 'none' } } },
      services: {
        a: {
          extends: { file: 'e.yaml' },
          build: '/',
          label_file: '/l',
          env_file: '/e',
          volumes: ['/v:/v'],
        },
      },
    },
    [
      [['services', 'a', 'volumes', 0], 'bind source `/v`', ABSOLUTE, '/v:/v'],
      [['services', 'a', 'env_file'], 'env_file `/e`', ABSOLUTE, '/e'],
      [['services', 'a', 'label_file'], 'label_file `/l`', ABSOLUTE, '/l'],
      [['services', 'a', 'build'], 'build context `/`', ABSOLUTE, '/'],
      [['services', 'a', 'extends', 'file'], 'extends file `e.yaml`', PULLS_UNCHECKED, 'e.yaml'],
      [
        ['volumes', 'v', 'driver_opts'],
        'volume `v`',
        'is a bind mount of a host path in disguise',
        { type: 'none' },
      ],
      [['configs', 'c', 'file'], 'config file `/c`', ABSOLUTE, '/c'],
      [['secrets', 's', 'file'], 'secret file `/s`', ABSOLUTE, '/s'],
      [['include', 0], 'included file `i.yaml`', PULLS_UNCHECKED, 'i.yaml'],
    ],
  ],
]

for (const [label, data, expected] of GATE_CASES) {
  test(`gate: ${label}`, () => {
    assertEquals(collectHostAccessFindings(data), expected.map(findingFor))
  })
}

test("gate: an extends file that is not text is refused without printing '[object Object]'", () => {
  const findings = collectHostAccessFindings(stack({ extends: { file: { nested: true } } }))
  assertEquals(
    findings.map((finding) => finding.path),
    ['services.web.extends.file']
  )
  assertEquals(findings[0].value, { nested: true })
  assertEquals(findings[0].message.includes('[object Object]'), false)
  assertEquals(findings[0].message.endsWith(HOST_LEVEL_OPT_IN_SENTENCE), true)
})

test('gate: hostAccessIssues names every gated key with its fixed sentence', () => {
  for (const key of GATED_SERVICE_FIELD_KEYS) {
    assertEquals(
      hostAccessIssues({ services: { web: { [key]: false } } }),
      [
        {
          path: `services.web.${key}`,
          message: `${key} grants root-equivalent access to the shared daemon host`,
        },
      ],
      key
    )
  }
})

test('gate: hostAccessIssues lists gated keys before value-level findings, per service', () => {
  assertEquals(
    hostAccessIssues({
      services: {
        a: { volumes: ['/x:/x'], privileged: true },
        b: 'not a mapping',
        c: { pid: 'host' },
      },
      configs: { k: { file: '/k' } },
    }).map((issue) => issue.path),
    ['services.a.privileged', 'services.c.pid', 'services.a.volumes[0]', 'configs.k.file']
  )
  assertEquals(hostAccessIssues(null), [])
  assertEquals(hostAccessIssues({ services: 'x' }), [])
  assertEquals(hostAccessIssues({ services: { web: { image: 'x' } } }), [])
})

test('gate: hostAccessIssues sees through tags like the findings do', () => {
  assertEquals(
    hostAccessIssues(stack({ privileged: makeComposeTag('override', true) })).map(
      (issue) => issue.path
    ),
    ['services.web.privileged']
  )
})

test('gate: hostAccessCanonical is the sorted path/value pairs, gated keys included', () => {
  assertEquals(hostAccessCanonical(stack({})), '')
  assertEquals(hostAccessCanonical(null), '')
  assertEquals(
    hostAccessCanonical({
      services: {
        web: {
          privileged: true,
          volumes: ['/z:/z'],
          build: { ssh: { b: 1, a: 2 } },
        },
        api: { pid: 'host', 'not a mapping': 1 },
        gone: 'x',
      },
      include: ['i.yaml'],
    }),
    JSON.stringify([
      ['include[0]', 'i.yaml'],
      ['services.api.pid', 'host'],
      ['services.web.build.ssh', { a: 2, b: 1 }],
      ['services.web.privileged', true],
      ['services.web.volumes[0]', '/z:/z'],
    ])
  )
})

test('gate: no finding, no fingerprint; a finding, a 64-character hex one', async () => {
  assertEquals(await hostAccessFingerprint({ services: { web: { image: 'x' } } }), null)
  const fingerprint = await hostAccessFingerprint(stack({ env_file: ['/e'] }))
  assertEquals(/^[0-9a-f]{64}$/.test(fingerprint ?? ''), true)
})
