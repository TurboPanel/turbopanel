import { assertEquals } from '@std/assert'
import {
  collectRootExtensionValidationIssues,
  DEFAULT_PRINCIPAL_ACCESS,
  isPrincipalAccess,
  isPrincipalAlias,
  parseRootExtension,
  PLACEMENT_NOT_STORED_MESSAGE,
  principalAccessOf,
  type TurbopanelRootExtension,
} from './root-extension.ts'
import type { TurbopanelRuntimeRootExtension } from './placement.ts'
import { validateComposeDocument } from './validate.ts'
import { stripComposeTurbopanelExtensions } from './extensions.ts'
import type { ComposeDocument } from './types.ts'

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

function messagesFor(extension: unknown): string[] {
  return collectRootExtensionValidationIssues('x-turbopanel', extension)
    .map((issue) => `${issue.path}: ${issue.message}`)
}

test('parseRootExtension keeps principals and drops malformed entries', () => {
  const parsed = parseRootExtension({
    principals: {
      web: { description: '  serves the site  ', access: 'sftp' },
      empty: {},
      'not a valid alias': { access: 'ssh' },
      wrongShape: ['nope'],
    },
  })

  assertEquals(parsed, {
    principals: {
      web: { description: 'serves the site', access: 'sftp' },
      empty: {},
    },
  })
})

test('parseRootExtension treats absent and empty values as an empty root', () => {
  assertEquals(parseRootExtension(null), {})
  assertEquals(parseRootExtension(undefined), {})
  assertEquals(parseRootExtension({}), {})
  assertEquals(parseRootExtension({ principals: {} }), {})
  assertEquals(parseRootExtension('x-turbopanel'), null)
  assertEquals(parseRootExtension(['principals']), null)
})

test('principal access helpers default to none', () => {
  assertEquals(DEFAULT_PRINCIPAL_ACCESS, 'none')
  assertEquals(principalAccessOf({}), 'none')
  assertEquals(principalAccessOf({ access: 'ssh' }), 'ssh')
  assertEquals(isPrincipalAccess('sftp'), true)
  assertEquals(isPrincipalAccess('shell'), false)
  assertEquals(isPrincipalAlias('web-1_a'), true)
  assertEquals(isPrincipalAlias('1web'), false)
  assertEquals(isPrincipalAlias('a'.repeat(65)), false)
})

test('collectRootExtensionValidationIssues accepts a principals-only root', () => {
  assertEquals(
    messagesFor({
      principals: {
        web: { description: 'serves the site', access: 'sftp' },
        worker: {},
        jobs: null,
      },
    }),
    [],
  )
})

test('collectRootExtensionValidationIssues rejects placement', () => {
  assertEquals(
    messagesFor({ placement: { server_id: 'anything' } }),
    [`x-turbopanel.placement: ${PLACEMENT_NOT_STORED_MESSAGE}`],
  )
})

test('collectRootExtensionValidationIssues redirects principal-record keys', () => {
  const messages = messagesFor({
    uid: 10001,
    gid: 10001,
    home: '/srv/users/web',
    shell: '/bin/bash',
    password: 'hunter2',
    authorized_keys: ['ssh-ed25519 AAAA'],
    server_id: '11111111-1111-4111-8111-111111111111',
    cgroup: 'tenant.slice',
  })

  assertEquals(messages, [
    'x-turbopanel.uid: uid is not authored in compose; operator id overrides live on principal.options',
    'x-turbopanel.gid: gid is not authored in compose; operator id overrides live on principal.options',
    "x-turbopanel.home: home is not authored in compose; the daemon derives a principal's home directory (turbopaneld ensure-principal.ts)",
    'x-turbopanel.shell: shell is not authored in compose; the access level is encoded by principal.options.shell',
    'x-turbopanel.password: password is not authored in compose; principal credentials live on the ssh table',
    'x-turbopanel.authorized_keys: authorized_keys is not authored in compose; principal keys live on the ssh table',
    `x-turbopanel.server_id: ${PLACEMENT_NOT_STORED_MESSAGE}`,
    'x-turbopanel.cgroup: cgroup is not authored in compose; resource limits are org and server policy',
  ])
})

test('collectRootExtensionValidationIssues reports any other unknown root key', () => {
  assertEquals(
    messagesFor({ schemaVersion: 1 }),
    ['x-turbopanel.schemaVersion: unknown x-turbopanel key "schemaVersion"; supported: principals'],
  )
})

test('collectRootExtensionValidationIssues rejects a non-mapping principals block', () => {
  assertEquals(
    messagesFor({ principals: ['web'] }),
    ['x-turbopanel.principals: principals must be a mapping of alias to principal'],
  )
})

test('collectRootExtensionValidationIssues rejects a bad alias charset', () => {
  assertEquals(
    messagesFor({ principals: { 'web site': {} } }),
    [
      'x-turbopanel.principals.web site: principal alias must start with a letter and contain only letters, digits, "-", and "_" (at most 64 characters)',
    ],
  )
})

test('collectRootExtensionValidationIssues validates a principal body', () => {
  assertEquals(
    messagesFor({
      principals: {
        web: { description: 12, access: 'shell' },
        api: { description: 'x'.repeat(501) },
        jobs: 'sftp',
        keys: { uid: 10001, nickname: 'w' },
      },
    }),
    [
      'x-turbopanel.principals.web.description: description must be a string',
      'x-turbopanel.principals.web.access: access must be "none", "sftp", or "ssh"',
      'x-turbopanel.principals.api.description: description must be at most 500 characters',
      'x-turbopanel.principals.jobs: principal must be a mapping',
      'x-turbopanel.principals.keys.uid: uid is not authored in compose; operator id overrides live on principal.options',
      'x-turbopanel.principals.keys.nickname: unknown principal key "nickname"; supported: access, description',
    ],
  )
})

test('validateComposeDocument accepts a document with root principals', () => {
  const result = validateComposeDocument(doc({
    services: { web: { image: 'nginx' } },
    'x-turbopanel': {
      principals: { web: { description: 'serves the site', access: 'sftp' } },
    },
  }))
  assertEquals(result.ok, true)
})

test('validateComposeDocument rejects an unknown root extension key', () => {
  const result = validateComposeDocument(doc({
    services: { web: { image: 'nginx' } },
    'x-turbopanel': { principals: { web: {} }, cgroup: 'tenant.slice' },
  }))
  assertEquals(result.ok, false)
  if (result.ok) return
  assertEquals(result.issues, [{
    path: 'x-turbopanel.cgroup',
    message:
      'cgroup is not authored in compose; resource limits are org and server policy',
  }])
})

test('stripComposeTurbopanelExtensions removes a mixed-key root extension whole', () => {
  const stripped = stripComposeTurbopanelExtensions(doc({
    services: { web: { image: 'nginx', 'x-turbopanel': { serviceKind: 'container' } } },
    'x-turbopanel': {
      principals: { web: { access: 'sftp' } },
      placement: { server_id: '11111111-1111-4111-8111-111111111111' },
    },
  }))

  assertEquals(stripped.data, { services: { web: { image: 'nginx' } } })
  assertEquals(stripped.presentation.keyOrder, ['services'])
})

/**
 * The authored root and the runtime root are separate types on purpose (see
 * `./root-extension.ts`). This is the compile-time half of that guarantee: a
 * `placement`-bearing object must not satisfy the authored shape, and the
 * authored type must have no `placement` key to reach for.
 */
test('the authored root extension type has no placement key', () => {
  type AuthoredKeys = keyof TurbopanelRootExtension
  type NoPlacement = Extract<AuthoredKeys, 'placement'> extends never ? true
    : false
  const authoredHasNoPlacement: NoPlacement = true
  assertEquals(authoredHasNoPlacement, true)

  const authored: TurbopanelRootExtension = { principals: { web: {} } }
  const runtime: TurbopanelRuntimeRootExtension = {
    placement: { server_id: '11111111-1111-4111-8111-111111111111' },
  }
  // A runtime root is not assignable to the authored one: excess-property
  // checking on the literal above is what makes that a compile error, and the
  // two values below are only here so both types are actually inhabited.
  assertEquals(Object.keys(authored), ['principals'])
  assertEquals(Object.keys(runtime), ['placement'])
})
