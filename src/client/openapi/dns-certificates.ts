import { resourceErrorResponses } from './shared.ts'

/**
 * OpenAPI for certificates this panel orders itself and proves by a DNS
 * challenge (`client/organizations/dns-certificate-routes.ts`). Owners and
 * managers only. Ordering takes minutes: a new certificate answers `pending`
 * and the periodic sweep, or "check now", moves it on.
 */

const ORG_ID_PARAM = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const TLS_ID_PARAM = {
  name: 'tlsId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

export const dnsCertificateSchemas = {
  DnsCertificate: {
    type: 'object',
    description:
      'A library certificate ordered by TurboPanel through a DNS challenge. It is pinned to a site like any library certificate.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      names: { type: 'array', items: { type: 'string' } },
      wildcard: { type: 'boolean' },
      status: {
        type: 'string',
        enum: ['pending', 'ready', 'failed', 'expired'],
        description: '`failed` after three failed orders; try again with `retry`.',
      },
      stage: {
        type: 'string',
        description:
          'Where an order stands: queued, presented, validating, finalizing, issued, backoff or failed.',
      },
      staging: {
        type: 'boolean',
        description:
          "A Test Certificate, ordered from the test directory. Test certificates are only for trying out ordering. Browsers show a security warning for them, so they can't be attached to a site (`tls_pin_staging`).",
      },
      lastError: { type: 'string', nullable: true },
      warning: {
        type: 'string',
        nullable: true,
        description: 'Something that will stop the next renewal, in plain words.',
      },
      attempts: { type: 'integer' },
      nextAttemptAt: { type: 'string', format: 'date-time', nullable: true },
      renewAt: { type: 'string', format: 'date-time', nullable: true },
      notAfter: { type: 'string', format: 'date-time', nullable: true },
      issuer: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  DnsCertificateCreate: {
    type: 'object',
    title: 'Order A Certificate',
    required: ['carrierId', 'names'],
    properties: {
      carrierId: {
        type: 'string',
        format: 'uuid',
        description: 'The connected account that hosts the DNS.',
      },
      names: {
        type: 'array',
        maxItems: 10,
        items: { type: 'string' },
        description: 'Exact names. A wildcard (`*.example.com`) only when it is asked for by name.',
      },
      staging: {
        type: 'boolean',
        default: false,
        description: 'Use the authority’s test directory (tests only).',
      },
    },
  },
} as const

function errors(extra?: { badRequest?: boolean }) {
  return resourceErrorResponses({
    badRequest: extra?.badRequest,
    notFound: true,
  }) as Record<string, unknown>
}

function ok(description: string, schema: Record<string, unknown>, status = '200') {
  return { [status]: { description, content: { 'application/json': { schema } } } }
}

const ONE = {
  type: 'object',
  properties: { certificate: { $ref: '#/components/schemas/DnsCertificate' } },
}

export const dnsCertificatePaths: Record<string, unknown> = {
  '/api/client/v1/organizations/{id}/dns-certificates': {
    get: {
      tags: ['Organizations'],
      summary: 'List the certificates TurboPanel ordered through a DNS challenge',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM],
      responses: {
        ...ok('Certificates', {
          type: 'object',
          properties: {
            certificates: { type: 'array', items: { $ref: '#/components/schemas/DnsCertificate' } },
          },
        }),
        ...errors(),
      },
    },
    post: {
      tags: ['Organizations'],
      summary: 'Order a certificate by DNS challenge',
      description:
        'Owners and managers only; the organization must allow Let’s Encrypt. 201 starts an order (`pending`); 200 returns a certificate that already covers the names (`reused: true`) or an order already running for them. Errors: 400 `names_invalid`, `carrier_invalid`, `no_dns_token`, `zone_not_found` (with `hostnames`), `badge_rejected`; 403 `lets_encrypt_not_enabled`; 429 `dns_certificate_limit` (10 new certificates a day); 502 `provider_unavailable`; 503 `secrets_unavailable`.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/DnsCertificateCreate' } },
        },
      },
      responses: {
        ...ok(
          'Started',
          { ...ONE, properties: { ...ONE.properties, reused: { type: 'boolean' } } },
          '201'
        ),
        ...errors({ badRequest: true }),
      },
    },
  },
  '/api/client/v1/organizations/{id}/dns-certificates/{tlsId}/check': {
    post: {
      tags: ['Organizations'],
      summary: 'Move an order on now',
      description:
        'Does the next step or two of the order and returns where it stands (`outcome`: busy, waiting, issued, failed, backoff).',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, TLS_ID_PARAM],
      responses: {
        ...ok('Certificate', {
          ...ONE,
          properties: { ...ONE.properties, outcome: { type: 'string' } },
        }),
        ...errors(),
      },
    },
  },
  '/api/client/v1/organizations/{id}/dns-certificates/{tlsId}/retry': {
    post: {
      tags: ['Organizations'],
      summary: 'Try a failed order again',
      description:
        'Only for a certificate that gave up (`failed`), and not within 15 minutes of the last failure: 409 `not_failed`, 429 `retry_too_soon`.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, TLS_ID_PARAM],
      responses: { ...ok('Certificate', ONE), ...errors() },
    },
  },
}
