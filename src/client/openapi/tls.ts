export const tlsSchemas = {
  TlsMetadata: {
    type: 'object',
    required: [
      'dnsNames',
      'hasWildcard',
      'notBefore',
      'notAfter',
      'fingerprintSha256',
      'subject',
      'issuer',
      'status',
    ],
    properties: {
      dnsNames: { type: 'array', items: { type: 'string' } },
      hasWildcard: { type: 'boolean' },
      notBefore: { type: 'string', format: 'date-time' },
      notAfter: {
        type: 'string',
        format: 'date-time',
        description:
          'Column value mirrored into metadata for API stability (shape unchanged).',
      },
      fingerprintSha256: {
        type: 'string',
        description:
          'Column value mirrored into metadata for API stability (shape unchanged).',
      },
      subject: { type: 'string' },
      issuer: { type: 'string' },
      status: {
        type: 'string',
        enum: ['ready', 'pending', 'expired', 'failed', 'revoked'],
        description:
          'Column value mirrored into metadata for API stability (shape unchanged).',
      },
    },
  },
  TlsRow: {
    type: 'object',
    required: [
      'id',
      'organizationId',
      'source',
      'metadata',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: { type: 'string' },
      organizationId: { type: 'string' },
      displayName: { type: ['string', 'null'] },
      source: {
        type: 'string',
        enum: ['upload', 'lets_encrypt', 'self_signed', 'organization_ca'],
      },
      metadata: { $ref: '#/components/schemas/TlsMetadata' },
      options: { type: ['object', 'null'] },
      certificatePem: {
        type: ['string', 'null'],
        description: 'Public certificate chain PEM (private key is never returned)',
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  TlsListResponse: {
    type: 'object',
    required: ['tls'],
    properties: {
      tls: {
        type: 'array',
        items: { $ref: '#/components/schemas/TlsRow' },
      },
    },
  },
  CreateTlsRequest: {
    type: 'object',
    required: ['source'],
    properties: {
      source: {
        type: 'string',
        enum: ['upload', 'lets_encrypt', 'self_signed', 'organization_ca'],
      },
      displayName: { type: 'string' },
      certificatePem: {
        type: 'string',
        description: 'Required for source=upload',
      },
      privateKeyPem: {
        type: 'string',
        description: 'Required for source=upload (write-only)',
      },
      hostnames: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required for lets_encrypt and self_signed',
      },
      commonName: {
        type: 'string',
        description: 'Optional CN for source=organization_ca',
      },
      prefer: { type: 'number' },
      autoRenew: { type: 'boolean' },
      challengeType: { type: 'string', enum: ['http-01', 'dns-01'] },
    },
  },
  PatchTlsRequest: {
    type: 'object',
    properties: {
      displayName: { type: 'string' },
      prefer: { type: ['number', 'null'] },
      autoRenew: { type: 'boolean' },
      revoke: { type: 'boolean' },
    },
  },
}

export const tlsPaths = {
  '/api/client/v1/tls': {
    get: {
      tags: ['TLS'],
      summary: 'List organization TLS certificates',
      security: [{ cookieAuth: [] }],
      responses: {
        200: {
          description: 'TLS library',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TlsListResponse' },
            },
          },
        },
      },
    },
    post: {
      tags: ['TLS'],
      summary:
        'Create a TLS certificate (upload, self-signed, organization CA, or LE pending)',
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateTlsRequest' },
          },
        },
      },
      responses: {
        200: {
          description: 'Created',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/EntityOkResponse' },
            },
          },
        },
        409: {
          description:
            'tls_fingerprint_conflict or organization_ca_exists (active CA already present)',
        },
      },
    },
  },
  '/api/client/v1/tls/ca': {
    get: {
      tags: ['TLS'],
      summary: 'Ensure or return the organization CA certificate (create if missing)',
      security: [{ cookieAuth: [] }],
      responses: {
        200: {
          description: 'Active organization CA (public fields only)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['tls'],
                properties: {
                  tls: { $ref: '#/components/schemas/TlsRow' },
                },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/tls/ca/rotate': {
    post: {
      tags: ['TLS'],
      summary: 'Rotate the organization CA (revokes prior active CA, mints a new one)',
      security: [{ cookieAuth: [] }],
      responses: {
        200: {
          description: 'Rotated',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/EntityOkResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/tls/ca/download': {
    get: {
      tags: ['TLS'],
      summary: 'Download the organization CA certificate PEM only',
      description:
        'Returns the active organization CA `certificatePem` as `application/x-pem-file`. Private key is never included.',
      security: [{ cookieAuth: [] }],
      responses: {
        200: {
          description: 'CA certificate PEM',
          content: {
            'application/x-pem-file': {
              schema: { type: 'string' },
            },
          },
        },
        404: {
          description: 'No active organization CA',
        },
      },
    },
  },
  '/api/client/v1/tls/{id}': {
    get: {
      tags: ['TLS'],
      summary: 'Get a TLS certificate (no private key)',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: {
          description: 'TLS certificate',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['tls'],
                properties: {
                  tls: { $ref: '#/components/schemas/TlsRow' },
                },
              },
            },
          },
        },
      },
    },
    patch: {
      tags: ['TLS'],
      summary: 'Update TLS display name / prefer / revoke',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/PatchTlsRequest' },
          },
        },
      },
      responses: {
        200: {
          description: 'Updated',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UpdateEntityOkResponse' },
            },
          },
        },
      },
    },
    delete: {
      tags: ['TLS'],
      summary: 'Delete a TLS certificate (clears hosting pins)',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: {
          description: 'Deleted',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UpdateEntityOkResponse' },
            },
          },
        },
      },
    },
  },
}
