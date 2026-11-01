import { INGRESS_MODES, type IngressMode } from '../../../features/install/ingress-modes.ts'
import type { IngressCapabilities } from './provider.ts'

const NO_ACCOUNT = { apiDriven: 'none', provider: null } as const

/**
 * The capability table: one record per connection mode. Only `direct` and
 * `lan-only` are implemented; the rest are rows so the planner and the
 * heartbeat edge set already know them. `capabilities.hostfree.test.ts` pins
 * every cell.
 */
export const INGRESS_CAPABILITIES: Readonly<Record<IngressMode, IngressCapabilities>> = {
  direct: {
    mode: 'direct',
    implemented: true,
    originMustBePublic: true,
    visitorCertificateIssuer: 'panel',
    originCertificate: 'same',
    visitorIpSource: 'socket-peer',
    defaultPublicPort: 8443,
    heartbeatSeconds: 60,
    idleLimitSeconds: null,
    ...NO_ACCOUNT,
    allowedCertificateSources: ['platform-ca', 'uploaded', 'lets-encrypt', 'dns-01'],
    isEdge: false,
  },
  'lan-only': {
    mode: 'lan-only',
    implemented: true,
    originMustBePublic: false,
    visitorCertificateIssuer: 'panel',
    originCertificate: 'same',
    visitorIpSource: 'socket-peer',
    defaultPublicPort: 8443,
    heartbeatSeconds: 60,
    idleLimitSeconds: null,
    ...NO_ACCOUNT,
    allowedCertificateSources: ['platform-ca', 'uploaded', 'dns-01'],
    isEdge: false,
  },
  'cloudflare-tunnel': {
    mode: 'cloudflare-tunnel',
    implemented: true,
    originMustBePublic: false,
    visitorCertificateIssuer: 'edge',
    originCertificate: 'optional',
    visitorIpSource: 'cf-connecting-ip-loopback',
    defaultPublicPort: 8443,
    heartbeatSeconds: 25,
    idleLimitSeconds: 100,
    apiDriven: 'token',
    provider: 'cloudflare',
    allowedCertificateSources: ['platform-ca', 'uploaded', 'dns-01'],
    isEdge: true,
  },
  'cloudflare-proxy': {
    mode: 'cloudflare-proxy',
    implemented: false,
    originMustBePublic: true,
    visitorCertificateIssuer: 'edge',
    originCertificate: 'required-strict',
    visitorIpSource: 'cf-connecting-ip-ranges',
    defaultPublicPort: 8443,
    heartbeatSeconds: 25,
    idleLimitSeconds: 100,
    apiDriven: 'token',
    provider: 'cloudflare',
    allowedCertificateSources: ['uploaded', 'dns-01'],
    isEdge: true,
  },
  'bunny-proxy': {
    mode: 'bunny-proxy',
    implemented: false,
    originMustBePublic: true,
    visitorCertificateIssuer: 'edge',
    originCertificate: 'required-public',
    visitorIpSource: 'x-real-ip-edge-list',
    defaultPublicPort: 443,
    heartbeatSeconds: 25,
    idleLimitSeconds: null,
    apiDriven: 'account-key',
    provider: 'bunny',
    allowedCertificateSources: ['uploaded', 'dns-01'],
    isEdge: true,
  },
  'private-overlay': {
    mode: 'private-overlay',
    implemented: false,
    originMustBePublic: false,
    visitorCertificateIssuer: 'overlay',
    originCertificate: 'required-strict',
    visitorIpSource: 'overlay-peer',
    defaultPublicPort: 8443,
    heartbeatSeconds: 60,
    idleLimitSeconds: null,
    ...NO_ACCOUNT,
    allowedCertificateSources: ['platform-ca', 'uploaded', 'dns-01'],
    isEdge: false,
  },
  passthrough: {
    mode: 'passthrough',
    implemented: false,
    originMustBePublic: false,
    visitorCertificateIssuer: 'panel-passthrough',
    originCertificate: 'required-strict',
    visitorIpSource: 'proxy-protocol',
    defaultPublicPort: 443,
    heartbeatSeconds: 25,
    idleLimitSeconds: null,
    ...NO_ACCOUNT,
    allowedCertificateSources: ['uploaded', 'dns-01'],
    isEdge: true,
  },
}

export function capabilitiesFor(mode: IngressMode): IngressCapabilities {
  return INGRESS_CAPABILITIES[mode]
}

export function listIngressCapabilities(): IngressCapabilities[] {
  return INGRESS_MODES.map(capabilitiesFor)
}

/** Modes served through an edge. The heartbeat policy's `EDGE_MODES` must equal this. */
export function edgeModes(): IngressMode[] {
  return INGRESS_MODES.filter((mode) => INGRESS_CAPABILITIES[mode].isEdge)
}
