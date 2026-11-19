/**
 * The `nameTls` field of a deploy hosting: what the panel-side parser keeps and
 * refuses. A name may be a served name or a www redirect name; anything else,
 * or an unknown mode, is refused.
 */
import { assertEquals, assertThrows } from '@std/assert'
import { parseEnvironmentDeployPayload } from './schemas.ts'

/** Sonar only recognises `test()`; see the note in the other suites. */
const test = Deno.test.bind(Deno)

function payload(hosting: Record<string, unknown>): unknown {
  return {
    environmentId: 'env-1',
    projectId: 'proj-1',
    organizationId: 'org-1',
    projectName: 'tp-demo',
    hostingIngressNetwork: 'tp-hosting-ingress',
    composeFiles: [{ filename: 'compose.yaml', role: 'runtime', content: 'services: {}\n' }],
    hostings: [
      {
        hostingId: 'h1',
        serviceId: 's1',
        composeServiceName: 'web',
        hostnames: ['a.example.net'],
        targetPort: 80,
        ...hosting,
      },
    ],
  }
}

function nameTlsOf(hosting: Record<string, unknown>) {
  return parseEnvironmentDeployPayload(payload(hosting)).hostings?.[0]?.nameTls
}

test('a row without nameTls parses without the field', () => {
  assertEquals(nameTlsOf({}), undefined)
})

test('entries for served names keep their pin or mode', () => {
  assertEquals(
    nameTlsOf({
      hostnames: ['a.example.net', 'b.example.net'],
      nameTls: [
        { hostname: 'a.example.net', tlsId: 't1' },
        { hostname: 'b.example.net', tlsMode: 'internal' },
      ],
    }),
    [
      { hostname: 'a.example.net', tlsId: 't1' },
      { hostname: 'b.example.net', tlsMode: 'internal' },
    ]
  )
  assertEquals(nameTlsOf({ nameTls: [{ hostname: 'a.example.net', tlsMode: 'acme' }] }), [
    { hostname: 'a.example.net', tlsMode: 'acme' },
  ])
})

test('a www name the www mode adds, served or redirect-only, is a valid entry', () => {
  for (const www of ['both', 'www-to-root', 'root-to-www']) {
    const hostnames = www === 'root-to-www' ? ['www.a.example.net'] : ['a.example.net']
    const name = www === 'root-to-www' ? 'a.example.net' : 'www.a.example.net'
    assertEquals(nameTlsOf({ hostnames, www, nameTls: [{ hostname: name, tlsId: 't1' }] }), [
      { hostname: name, tlsId: 't1' },
    ])
  }
})

test('a name the row does not answer on is refused', () => {
  assertThrows(
    () => nameTlsOf({ nameTls: [{ hostname: 'other.example.net', tlsId: 't1' }] }),
    TypeError
  )
  assertThrows(
    () => nameTlsOf({ nameTls: [{ hostname: 'www.a.example.net', tlsId: 't1' }] }),
    TypeError
  )
})

test('a malformed entry is refused', () => {
  for (const nameTls of [
    'x',
    [null],
    [{ tlsId: 't1' }],
    [{ hostname: 'a.example.net', tlsId: 5 }],
    [{ hostname: 'a.example.net', tlsMode: 'dns' }],
  ]) {
    assertThrows(() => nameTlsOf({ nameTls }), TypeError)
  }
})
