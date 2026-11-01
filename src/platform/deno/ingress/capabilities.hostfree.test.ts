import { assertEquals } from '@std/assert'
import { EDGE_MODES } from '../../../features/install/heartbeat-policy.ts'
import { INGRESS_MODES } from '../../../features/install/ingress-modes.ts'
import { INSTANCE_HOSTNAME_SOURCES } from '../../../features/install/instance-hostnames.ts'
import { edgeModes, INGRESS_CAPABILITIES, listIngressCapabilities } from './capabilities.ts'

const test = Deno.test.bind(Deno)

// Columns: implemented, originMustBePublic, issuer, originCertificate, ipSource, port,
// heartbeat, idleLimit, apiDriven, provider, certificate sources, isEdge.
const EXPECTED: Record<string, unknown[]> = {
  direct: [
    true,
    true,
    'panel',
    'same',
    'socket-peer',
    8443,
    60,
    null,
    'none',
    null,
    ['platform-ca', 'uploaded', 'lets-encrypt', 'dns-01'],
    false,
  ],
  'lan-only': [
    true,
    false,
    'panel',
    'same',
    'socket-peer',
    8443,
    60,
    null,
    'none',
    null,
    ['platform-ca', 'uploaded', 'dns-01'],
    false,
  ],
  'cloudflare-tunnel': [
    true,
    false,
    'edge',
    'optional',
    'cf-connecting-ip-loopback',
    8443,
    25,
    100,
    'token',
    'cloudflare',
    ['platform-ca', 'uploaded', 'dns-01'],
    true,
  ],
  'cloudflare-proxy': [
    false,
    true,
    'edge',
    'required-strict',
    'cf-connecting-ip-ranges',
    8443,
    25,
    100,
    'token',
    'cloudflare',
    ['uploaded', 'dns-01'],
    true,
  ],
  'bunny-proxy': [
    false,
    true,
    'edge',
    'required-public',
    'x-real-ip-edge-list',
    443,
    25,
    null,
    'account-key',
    'bunny',
    ['uploaded', 'dns-01'],
    true,
  ],
  'private-overlay': [
    false,
    false,
    'overlay',
    'required-strict',
    'overlay-peer',
    8443,
    60,
    null,
    'none',
    null,
    ['platform-ca', 'uploaded', 'dns-01'],
    false,
  ],
  passthrough: [
    false,
    false,
    'panel-passthrough',
    'required-strict',
    'proxy-protocol',
    443,
    25,
    null,
    'none',
    null,
    ['uploaded', 'dns-01'],
    true,
  ],
}

function row(mode: (typeof INGRESS_MODES)[number]): unknown[] {
  const c = INGRESS_CAPABILITIES[mode]
  return [
    c.implemented,
    c.originMustBePublic,
    c.visitorCertificateIssuer,
    c.originCertificate,
    c.visitorIpSource,
    c.defaultPublicPort,
    c.heartbeatSeconds,
    c.idleLimitSeconds,
    c.apiDriven,
    c.provider,
    [...c.allowedCertificateSources],
    c.isEdge,
  ]
}

test('every mode has a record whose cells match the table', () => {
  assertEquals(Object.keys(EXPECTED).sort(), [...INGRESS_MODES].sort())
  for (const mode of INGRESS_MODES) {
    assertEquals(INGRESS_CAPABILITIES[mode].mode, mode)
    assertEquals(row(mode), EXPECTED[mode], mode)
  }
  assertEquals(listIngressCapabilities().length, INGRESS_MODES.length)
})

test('direct, lan-only and cloudflare-tunnel are implemented', () => {
  const implemented = INGRESS_MODES.filter((mode) => INGRESS_CAPABILITIES[mode].implemented)
  assertEquals(implemented, ['direct', 'lan-only', 'cloudflare-tunnel'])
})

test('edge modes advertise the short heartbeat, the others the default', () => {
  for (const mode of INGRESS_MODES) {
    const { isEdge, heartbeatSeconds } = INGRESS_CAPABILITIES[mode]
    assertEquals(heartbeatSeconds, isEdge ? 25 : 60, mode)
  }
})

test('certificate sources are known sources', () => {
  for (const mode of INGRESS_MODES) {
    for (const source of INGRESS_CAPABILITIES[mode].allowedCertificateSources) {
      assertEquals(INSTANCE_HOSTNAME_SOURCES.includes(source), true, `${mode} ${source}`)
    }
  }
})

test('the heartbeat policy edge set equals the capability table edge set', () => {
  assertEquals([...EDGE_MODES].sort(), [...edgeModes()].sort())
})
