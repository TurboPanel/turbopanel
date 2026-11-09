import { ADMIN_API_PREFIX } from '../../app/surfaces.ts'
import { INSTANCE_HOSTNAME_SOURCES } from '../../features/install/instance-hostnames.ts'

const cookieSecurity = [{ cookieAuth: [] }] as const

/**
 * Control-plane hostname, uploaded-certificate, and instance ACME paths.
 * Shared by Deno and Workers — these routes are mounted on both runtimes.
 */
export const INSTANCE_HOSTNAME_PATHS = {
  [`${ADMIN_API_PREFIX}/instance/hostnames`]: {
    get: {
      tags: ['Instance'],
      summary: 'List control-plane hostnames',
      description:
        'Each entry is a published name with its certificate source ' +
        '(`platform-ca`, `uploaded`, `acme-http-01` or `acme-dns-01`), derived status, and expiry. ' +
        "`tosAccepted` is the server's answer to whether Let's Encrypt terms " +
        'are accepted (stored settings and env overrides alike).',
      security: [...cookieSecurity],
      responses: {
        '200': { description: '`{ ok, hostnames, tosAccepted }`' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
      },
    },
    put: {
      tags: ['Instance'],
      summary: 'Replace the control-plane hostname set',
      description:
        'Body `{ hostnames: [{ host, source, uploadedCertId?, publicPort?, isPrimary? }] }`. ' +
        'Left out, `publicPort` and `isPrimary` keep the stored value (8443 and false for a new name). ' +
        "Let's Encrypt is refused for loopback, private, and wildcard names. " +
        'An `uploaded` source must name a stored pair whose names cover the host. ' +
        "An `acme-http-01` or `acme-dns-01` row is refused while Let's Encrypt terms are not " +
        'accepted, so a row every later apply would reject is never stored. ' +
        'When the save moves the primary public address, the answer carries `warnings`, ' +
        '`previousPrimaryOrigin` and `primaryOrigin`, and the move is written to the activity log.',
      security: [...cookieSecurity],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['hostnames'],
              properties: {
                hostnames: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['host', 'source'],
                    properties: {
                      host: { type: 'string' },
                      source: {
                        type: 'string',
                        enum: [...INSTANCE_HOSTNAME_SOURCES],
                      },
                      uploadedCertId: { type: ['string', 'null'] },
                      publicPort: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 65535,
                        description:
                          'The port visitors use. A self-hosted control plane accepts only 8443.',
                      },
                      isPrimary: {
                        type: 'boolean',
                        description: 'True makes this name the primary and demotes the others.',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: '`{ ok, hostnames }`, plus the primary change fields when it moved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'hostnames'],
                properties: {
                  ok: { type: 'boolean', const: true },
                  hostnames: { type: 'array', items: { type: 'object' } },
                  warnings: {
                    type: 'array',
                    description:
                      '`primary-host-changed`: the primary name moved, so links, OAuth ' +
                      'callbacks, webhook URLs and every registered passkey follow it. ' +
                      '`primary-origin-changed`: only its public port moved. Absent when ' +
                      'the primary address did not change.',
                    items: {
                      type: 'string',
                      enum: ['primary-host-changed', 'primary-origin-changed'],
                    },
                  },
                  previousPrimaryOrigin: {
                    type: 'string',
                    description:
                      'The primary public address before the save. Absent when unchanged.',
                  },
                  primaryOrigin: {
                    type: ['string', 'null'],
                    description:
                      'The primary public address after the save, or null when no name is left. ' +
                      'Absent when unchanged.',
                  },
                },
              },
            },
          },
        },
        '400': { description: 'Invalid request body' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires the superadmin role' },
        '422': {
          description:
            '`{ ok: false, error, invalid }` when a hostname fails validation, or ' +
            '`{ ok: false, error, code: "acme_terms_not_accepted" }` when a ' +
            '`acme-http-01` or `acme-dns-01` row is saved before the terms are accepted',
        },
        '503': { description: 'Database unavailable' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/certificates`]: {
    get: {
      tags: ['Instance'],
      summary: 'List uploaded control-plane certificates',
      description:
        'Label, parsed names, expiry, and the hostnames attached to each pair. ' +
        'The private key is never returned.',
      security: [...cookieSecurity],
      responses: {
        '200': { description: '`{ ok, certificates }`' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
      },
    },
    post: {
      tags: ['Instance'],
      summary: 'Upload a control-plane certificate pair',
      description:
        'Body `{ label, certPem, keyPem }`. The leaf is parsed and the key must ' +
        'match. The key is sealed at rest.',
      security: [...cookieSecurity],
      requestBody: { required: true },
      responses: {
        '201': {
          description: '`{ ok, id, label, dnsNames, hasWildcard, notAfter, fingerprintSha256 }`',
        },
        '400': { description: 'Invalid request body' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires the superadmin role' },
        '422': { description: 'Certificate parse or key match failed' },
        '503': { description: 'Database or encryption unavailable' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/certificates/{id}/hostnames`]: {
    patch: {
      tags: ['Instance'],
      summary: 'Attach or detach hostnames for an uploaded certificate',
      description:
        'Body `{ hosts: string[] }` is the full attachment set. Every host must ' +
        'be covered by the pair. Names dropped from the set stay published as ' +
        '`platform-ca`.',
      security: [...cookieSecurity],
      requestBody: { required: true },
      responses: {
        '200': { description: '`{ ok, hostnames }`' },
        '400': { description: 'Invalid request body' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires the superadmin role' },
        '404': { description: 'Certificate not found' },
        '422': {
          description: 'A hostname is invalid or not covered by the certificate',
        },
        '503': { description: 'Database unavailable' },
      },
    },
  },
  [`${ADMIN_API_PREFIX}/instance/acme`]: {
    get: {
      tags: ['Instance'],
      summary: 'Read instance ACME settings',
      description:
        "Instance-wide Let's Encrypt contact, terms acceptance, directory URL, " +
        "and staging flag. Independent of any organization's ACME opt-in.",
      security: [...cookieSecurity],
      responses: {
        '200': {
          description:
            '`{ settings, tosAccepted }`; `settings` keyed by `TURBOPANEL_INSTANCE_ACME__*`',
        },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
        '503': { description: 'Database unavailable' },
      },
    },
    put: {
      tags: ['Instance'],
      summary: 'Update instance ACME settings',
      description:
        'Partial object of setting keys. Env values win and are not overwritten. ' +
        'Returns 503 when an update would seal a secret and no encryption key is configured.',
      security: [...cookieSecurity],
      requestBody: { required: true },
      responses: {
        '200': { description: '`{ settings, tosAccepted }`' },
        '400': { description: 'Invalid request body' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires the superadmin role' },
        '422': { description: 'A setting value is invalid' },
        '503': {
          description: 'Database unavailable, or encryption is required and missing',
        },
      },
    },
  },
}
