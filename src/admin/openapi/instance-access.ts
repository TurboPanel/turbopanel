import { ADMIN_API_PREFIX } from '../../app/surfaces.ts'

const cookieSecurity = [{ cookieAuth: [] }] as const

/**
 * How operators reach this control plane: co-located daemon capability,
 * Platform CA, trusted proxies, and the tunnel token. Beside
 * `INSTANCE_HOSTNAME_PATHS`.
 */
export const INSTANCE_ACCESS_PATHS = {
  [`${ADMIN_API_PREFIX}/instance/identity`]: {
    get: {
      tags: ['Instance'],
      summary: "Read the control plane's key fingerprints",
      description:
        'Returns `{ ok, configured, current, next, seal, urls, installUrl, servers }`. ' +
        '`current` is `{ fingerprint, keyset }`, `next` and `seal` are `{ fingerprint }` or ' +
        'null, and `servers` lists each server with `pinnedBy` (`install`, `upgrade`, ' +
        '`unsafe` or `none`). Public values only; no key material is ever returned.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: 'Fingerprints and pinned-by state' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/identity/next`]: {
    put: {
      tags: ['Instance'],
      summary: "Set or clear the control plane's next key fingerprint",
      description:
        'Body `{ fingerprint: string | null }` (43-character fingerprint, or null to clear). ' +
        'Superadmin only, self-hosted only (Workers answers 422: the next key is the ' +
        '`TURBOPANEL_IDENTITY_KEYS` binding), and behind step-up: a stale session gets 403 ' +
        '`reauth_required`. Audited; superadmins are emailed.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: '`{ ok: true, next }`' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden, or `reauth_required`' },
        '422': { description: 'Malformed fingerprint, or not available on this runtime' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/daemon`]: {
    get: {
      tags: ['Instance'],
      summary: "Read the co-located daemon's certificate capability",
      description:
        'Resolves the co-located daemon and returns `{ applicable, connected, ' +
        'serverId, version, capabilities }`. `capabilities` is ' +
        '`resolveDaemonCapabilities(version)`. On Workers the body is ' +
        '`{ applicable: false }` and no cell is woken. Not a poll.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: 'Capability snapshot, or `{ applicable: false }`' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/platform-ca`]: {
    get: {
      tags: ['Instance'],
      summary: 'Read the Platform CA bundle',
      description:
        'Deno only. Returns `{ ok, fingerprintSha256, subject, notBefore, ' +
        'notAfter, pem }` for the durable Platform CA. A missing or unreadable ' +
        'bundle is `{ ok: false }`. Workers answers 422.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: '`{ ok: true, … }` or `{ ok: false }`' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
        '422': { description: 'Not available on this runtime' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/platform-ca/trust-reconcile`]: {
    post: {
      tags: ['Instance'],
      summary: 'Re-distribute the Platform CA to connected daemons',
      description:
        'Deno only. Enqueues `server.tls.trust.reconcile` for every connected ' +
        'daemon — the same fan-out public-URL apply already performs. ' +
        'Returns `{ ok, enqueued }`.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: '`{ ok: true, enqueued }`' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
        '422': { description: 'Not available on this runtime' },
        '503': { description: 'Database, queue, or bundle unavailable' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/trusted-proxies`]: {
    get: {
      tags: ['Instance'],
      summary: 'Read the effective trusted-proxy CIDRs',
      description:
        '`{ cidrs, isDefault }` from `TURBOPANEL_TRUSTED_PROXY_CIDRS`. ' +
        'Read-only: the value is process env consumed at startup.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: '`{ cidrs, isDefault }`' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/tunnel-token`]: {
    post: {
      tags: ['Instance'],
      summary: 'Set the co-located tunnel token',
      description:
        'Write-only. Body `{ token: string }`. An empty token tears the tunnel ' +
        'down. The stored token is never returned. 503 when no co-located ' +
        'daemon is connected. Self-hosted only: absent on High Availability.',
      security: [...cookieSecurity],
      requestBody: { required: true },
      responses: {
        '200': { description: '`{ ok: true }`' },
        '400': { description: 'Invalid request body' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
        '500': { description: 'The daemon rejected the token or timed out' },
        '503': { description: 'No co-located daemon is connected' },
      },
    },
  },
}
