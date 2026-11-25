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
        '`unsafe` or `none`) and `pinReport`: its last signed pin report ' +
        '`{ fingerprint, keyset, reportedAt, matches }`, or null before one arrives. ' +
        '`matches` false means the server pinned another key. Public values only; no key ' +
        'material is ever returned.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: 'Fingerprints and pinned-by state' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/identity/rotation`]: {
    get: {
      tags: ['Instance'],
      summary: 'Read rotation passkeys and the key-set chain',
      description:
        'Superadmin only. The rotation `rpId`, key set, every superadmin sign-in passkey with ' +
        'whether it can approve key changes and whether it is marked, a waiting High ' +
        'Availability statement, and the newest statements.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: '`{ ok: true, rpId, keyset, passkeys, statements, canRotate }`' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden' },
        '404': { description: 'Control plane identity is off' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/identity/statements/prepare`]: {
    post: {
      tags: ['Instance'],
      summary: 'Prepare a key-set statement for passkey approval',
      description:
        'Body `{ kind: "rotate" | "revoke" | "passkeys", mark?, unmark?, newKey? }`. Returns ' +
        'the exact statement bytes (base64url) and the WebAuthn challenge (SHA-256 of them). ' +
        'Rotate and revoke need two marked passkeys; on High Availability `newKey` is the ' +
        'public key the rotation command printed. `approvalsNeeded` is 2 for a revoke (no ' +
        'signature by the old key, so two different marked passkeys approve it), else 1. ' +
        'Superadmin, step-up.',
      security: [...cookieSecurity],
      responses: {
        '200': {
          description: '`{ ok: true, statement, challenge, rpId, keyset, approvalsNeeded }`',
        },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden, or `reauth_required`' },
        '409': {
          description:
            'Not enough passkeys marked, a change awaits its key, or no primary hostname is set',
        },
        '422': { description: 'Malformed body or a passkey that cannot be marked' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/identity/statements`]: {
    post: {
      tags: ['Instance'],
      summary: 'Approve a key-set statement with passkey assertions',
      description:
        'Body `{ statement, approvals: [{ credentialId, authenticatorData, clientDataJSON, ' +
        'signature }] }`. Checked exactly as servers check it; then, except for a revoke, the ' +
        'current key signs the statement (`keySig`), and it is stored; self-hosted moves ' +
        'to the new key at once, High Availability waits for the secret. Audited; ' +
        'superadmins are emailed. The answer carries `keySig` only once the change is live. ' +
        'Superadmin, step-up.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: '`{ ok: true, keyset, kind, state, envelope }`' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden, or `reauth_required`' },
        '409': {
          description:
            'Another change was approved first, the approval expired, or a change awaits its key',
        },
        '422': { description: 'The approvals do not verify' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/identity/statements/{keyset}`]: {
    get: {
      tags: ['Instance'],
      summary: 'Download one key-set statement',
      description:
        'The stored envelope, for hand-applying on a server with ' +
        '`tp-host panel-identity-write statement`. Superadmin only.',
      security: [...cookieSecurity],
      parameters: [{ name: 'keyset', in: 'path', required: true, schema: { type: 'integer' } }],
      responses: {
        '200': {
          description: 'The envelope `{ statement, approvals, keySig? }` (`keySig` once live)',
        },
        '404': { description: 'Not found' },
      },
    },
    delete: {
      tags: ['Instance'],
      summary: 'Cancel a key change that waits for its key',
      description:
        'High Availability: removes an approved rotate or revoke statement that still waits ' +
        'for the rotation command to store its key, so a new change can be prepared. Refused ' +
        'once the control plane signs with that key. Audited. Superadmin, step-up.',
      security: [...cookieSecurity],
      parameters: [{ name: 'keyset', in: 'path', required: true, schema: { type: 'integer' } }],
      responses: {
        '200': { description: '`{ ok: true, keyset, cancelled: true }`' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden, or `reauth_required`' },
        '404': { description: 'Not found' },
        '409': { description: 'The change is live and cannot be cancelled' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/daemon`]: {
    get: {
      tags: ['Instance'],
      summary: "Read the co-located daemon's certificate capability",
      description:
        'Resolves the co-located daemon and returns `{ applicable, connected, ' +
        'serverId, version }`. On Workers the body is ' +
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
}

/** Self-hosted only: the Workers spec leaves it out, as the route is not mounted there. */
export const INSTANCE_TUNNEL_TOKEN_PATH = {
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
        '403': {
          description:
            'Forbidden — requires admin or superadmin role, or `tunnel_token_colocated_only` ' +
            'when the daemon is not on the control plane host',
        },
        '500': { description: 'The daemon rejected the token or timed out' },
        '503': { description: 'No co-located daemon is connected' },
      },
    },
  },
}
