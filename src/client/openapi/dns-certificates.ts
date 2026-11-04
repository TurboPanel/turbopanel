import { resourceErrorResponses } from './shared.ts'

/**
 * OpenAPI for certificates the panel ordered itself and proved by a DNS
 * challenge (`client/organizations/dns-certificate-routes.ts`). The control
 * plane no longer orders them: the three order routes answer 422
 * `certificate_ordering_off`. The list stays, for owners and managers.
 */

const ORDERING_OFF = {
  '422': {
    description:
      'Ordering certificates from the control plane is turned off (`certificate_ordering_off`, with a plain `message`). Certificates will be ordered by the server that runs the site in a coming release.',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['error', 'message'],
          properties: {
            error: { type: 'string', enum: ['certificate_ordering_off'] },
            message: { type: 'string' },
          },
        },
      },
    },
  },
} as const

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
      'A library certificate ordered by TurboPanel through a DNS challenge. It is pinned to a site like any library certificate, and keeps serving until it expires: it is not renewed from the control plane.',
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
        description:
          'In plain words: something wrong with the certificate, or that it will not renew from the control plane.',
      },
      attempts: { type: 'integer' },
      nextAttemptAt: {
        type: 'string',
        format: 'date-time',
        nullable: true,
        description: 'Always null: nothing is tried again from the control plane.',
      },
      renewAt: {
        type: 'string',
        format: 'date-time',
        nullable: true,
        description: 'Always null: the certificate is not renewed from the control plane.',
      },
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

function errors() {
  return resourceErrorResponses({ notFound: true }) as Record<string, unknown>
}

function ok(description: string, schema: Record<string, unknown>) {
  return { '200': { description, content: { 'application/json': { schema } } } }
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
      summary: 'Order a certificate by DNS challenge (turned off)',
      description:
        'Always refused: the control plane no longer orders certificates. 401 without a session.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM],
      requestBody: {
        required: false,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/DnsCertificateCreate' } },
        },
      },
      responses: { ...ORDERING_OFF },
    },
  },
  '/api/client/v1/organizations/{id}/dns-certificates/{tlsId}/check': {
    post: {
      tags: ['Organizations'],
      summary: 'Move an order on now (turned off)',
      description:
        'Always refused: the control plane no longer orders certificates. 401 without a session.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, TLS_ID_PARAM],
      responses: { ...ORDERING_OFF },
    },
  },
  '/api/client/v1/organizations/{id}/dns-certificates/{tlsId}/retry': {
    post: {
      tags: ['Organizations'],
      summary: 'Try a failed order again (turned off)',
      description:
        'Always refused: the control plane no longer orders certificates. 401 without a session.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, TLS_ID_PARAM],
      responses: { ...ORDERING_OFF },
    },
  },
}
