const errorJson = {
  'application/json': { schema: { $ref: '#/components/schemas/DaemonErrorResponse' } },
}
const notConfigured = { description: 'Panel identity not configured', content: errorJson }
const dbDown = { description: 'Database unavailable', content: errorJson }
const jwt = [{ bearerAuth: [] }]

export const identityPaths: Record<string, unknown> = {
  '/api/daemon/v1/instance/identity': {
    get: {
      tags: ['Daemon'],
      summary: 'Signed panel identity document',
      description:
        'Public. The document lists the panel URLs and the key-set chain state. The signature is in the `X-TurboPanel-Signature` header, over the exact body bytes.',
      responses: {
        '200': {
          description: 'The signed identity document',
          headers: { 'X-TurboPanel-Signature': { schema: { type: 'string' } } },
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        '404': notConfigured,
        '503': dbDown,
      },
    },
  },
  '/api/daemon/v1/instance/identity/statements': {
    get: {
      tags: ['Daemon'],
      summary: 'Key-set chain of the panel identity',
      description:
        'Public. Live statements after the key-set number in `after`, ascending. Statements authenticate themselves, so the answer is not signed.',
      parameters: [
        {
          name: 'after',
          in: 'query',
          required: false,
          description: 'Only statements after this key-set number; default 0.',
          schema: { type: 'integer', minimum: 0 },
        },
      ],
      responses: {
        '200': {
          description: 'Statements',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['statements'],
                properties: { statements: { type: 'array', items: { type: 'object' } } },
              },
            },
          },
        },
        '400': { description: '`after` is not a non-negative integer', content: errorJson },
        '404': notConfigured,
        '429': { description: 'Too many requests from this address' },
        '503': dbDown,
      },
    },
  },
  '/api/daemon/v1/instance/identity/statements/waiting/{fingerprint}': {
    get: {
      tags: ['Daemon'],
      summary: 'Whether an approved key change waits for a key',
      description:
        'Public. Asked before a new key is stored, so no key is stored that no approved change leads to. Carries no approval.',
      parameters: [
        {
          name: 'fingerprint',
          in: 'path',
          required: true,
          description: 'Fingerprint of the new key.',
          schema: { type: 'string' },
        },
      ],
      responses: {
        '200': {
          description: 'A change waits for this key',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['keyset', 'kind', 'prev', 'current'],
                properties: {
                  keyset: { type: 'integer' },
                  kind: { type: 'string' },
                  prev: { type: 'string' },
                  current: { type: 'string' },
                },
              },
            },
          },
        },
        '400': { description: 'Not a fingerprint', content: errorJson },
        '404': {
          description: 'No change waits for this key, or identity not configured',
          content: errorJson,
        },
        '429': { description: 'Too many requests from this address' },
        '503': dbDown,
      },
    },
  },
  '/api/daemon/v1/ping': {
    get: {
      tags: ['Daemon'],
      summary: 'Authenticated round trip',
      description:
        'Called after a firewall change goes live to prove the daemon still reaches the control plane with a valid token. Reads nothing.',
      security: jwt,
      responses: {
        '200': {
          description: 'Reachable',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'at'],
                properties: {
                  ok: { type: 'boolean', const: true },
                  at: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
        '401': { description: 'Missing, invalid or expired daemon token' },
        '429': { description: 'Rate limited' },
      },
    },
  },
  '/api/daemon/v1/tls/issued': {
    post: {
      tags: ['Daemon'],
      summary: 'Report a certificate Caddy issued',
      description:
        'The certificate and private key issued on the calling server for one hostname. An optional `requestId` answers an open issue request. Stored sealed. The body is never logged and nothing from it comes back.',
      security: jwt,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['hostname', 'certificatePem'],
              properties: {
                hostname: { type: 'string' },
                certificatePem: {
                  type: 'string',
                  description: 'Certificate chain, 32 KiB at most.',
                },
                privateKeyPem: { type: 'string', description: 'Private key, 8 KiB at most.' },
                privateKeyEnvelope: {
                  type: 'object',
                  description: 'The key sealed to the panel, instead of `privateKeyPem`.',
                },
                requestId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Stored',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'stored'],
                properties: { ok: { type: 'boolean', const: true }, stored: { type: 'boolean' } },
              },
            },
          },
        },
        '400': { description: 'Invalid body, hostname, certificate or key' },
        '401': { description: 'Missing, invalid or expired daemon token' },
        '413': { description: 'Body too large' },
        '429': { description: 'Rate limited' },
        '503': { description: 'Storage unavailable' },
      },
    },
  },
}
