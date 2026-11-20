import { clientErrorJson, resourceErrorResponses } from './shared.ts'

/**
 * OpenAPI for certificates ordered through a DNS proof
 * (`client/organizations/dns-certificate-routes.ts`): one name, several names
 * or a wildcard. A server that serves the organization places the order; the
 * control plane publishes and removes the challenge records with the
 * organization's DNS token and never talks to the certificate authority.
 */

const ORDER_REFUSED = {
  '400': {
    description: 'The names are not valid (`Invalid request`, with a plain `message`).',
    content: { 'application/json': { schema: clientErrorJson } },
  },
  '401': {
    description: 'Unauthorized: no session.',
    content: { 'application/json': { schema: clientErrorJson } },
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
    required: ['names'],
    properties: {
      names: {
        type: 'array',
        minItems: 1,
        maxItems: 10,
        items: { type: 'string' },
        description:
          'Exact names and wildcards (`*.example.com`). A wildcard is proved over DNS only. The organization needs a connected account whose token can edit DNS for each name.',
      },
      autoRenew: { type: 'boolean', default: true },
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
      summary: 'Order a certificate through a DNS proof',
      description:
        'Starts an order for one name, several names or a wildcard. A server that serves the organization places it; the certificate appears in the list while it is ordered.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/DnsCertificateCreate' } },
        },
      },
      responses: {
        ...ok('The certificate being ordered', {
          type: 'object',
          properties: { certificate: { $ref: '#/components/schemas/DnsCertificate' } },
        }),
        ...ORDER_REFUSED,
        ...errors(),
      },
    },
  },
  '/api/client/v1/organizations/{id}/dns-certificates/{tlsId}/check': {
    post: {
      tags: ['Organizations'],
      summary: 'Read the state of an order',
      description: 'The certificate as it stands now; the sweep moves an order on every minute.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, TLS_ID_PARAM],
      responses: {
        ...ok('The certificate', {
          type: 'object',
          properties: { certificate: { $ref: '#/components/schemas/DnsCertificate' } },
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
        'Lifts the wait after a failed order so the next sweep places it again. While the certificate authority is rate limiting the organization the wait stays and the call answers 409 `rate_limited` with the time to try again (`retryAt`).',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, TLS_ID_PARAM],
      responses: {
        ...ok('The certificate', {
          type: 'object',
          properties: { certificate: { $ref: '#/components/schemas/DnsCertificate' } },
        }),
        ...errors(),
        409: {
          description: 'rate_limited: the certificate authority asked for a wait; see `retryAt`.',
        },
      },
    },
  },
}
