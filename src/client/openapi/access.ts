export const accessSchemas = {
  InvitationGrantSpec: {
    type: 'object',
    required: ['resourceKind', 'itemId'],
    properties: {
      resourceKind: {
        type: 'string',
        description: 'Entity kind (e.g. organization, workspace, project).',
      },
      itemId: {
        type: 'string',
        format: 'uuid',
        description: 'Primary key of the entity.',
      },
      effect: { type: 'string', enum: ['allow', 'deny'], default: 'allow' },
      accessProfileKey: {
        type: 'string',
        description: 'Access profile key expanded to atomic permissions on accept.',
      },
      permissionKey: {
        type: 'string',
        description: 'Single atomic permission key.',
      },
    },
    description:
      'One intended access grant stored on invitation.grants. Exactly one of accessProfileKey or permissionKey should be set. Materialized into grant rows on invitation accept.',
  },
  InvitationAcceptResponse: {
    type: 'object',
    required: ['ok', 'organizationId'],
    properties: {
      ok: { type: 'boolean', const: true },
      organizationId: {
        type: 'string',
        description:
          'Organization joined by the invitation. The active session organizationId is updated to this value.',
      },
    },
  },
  AccessProfileRecord: {
    type: 'object',
    required: ['key', 'displayName', 'permissions'],
    properties: {
      key: { type: 'string' },
      displayName: { type: 'string' },
      permissions: {
        type: 'array',
        items: { type: 'string' },
      },
    },
  },
  AccessProfilesResponse: {
    type: 'object',
    required: ['accessProfiles'],
    properties: {
      accessProfiles: {
        type: 'array',
        items: { $ref: '#/components/schemas/AccessProfileRecord' },
      },
    },
  },
  PermissionRecord: {
    type: 'object',
    required: ['key', 'displayName'],
    properties: {
      key: { type: 'string' },
      displayName: { type: 'string' },
    },
  },
  PermissionsResponse: {
    type: 'object',
    required: ['permissions'],
    properties: {
      permissions: {
        type: 'array',
        items: { $ref: '#/components/schemas/PermissionRecord' },
      },
    },
  },
  AccessRecord: {
    type: 'object',
    required: [
      'id',
      'subjectKind',
      'subjectId',
      'resourceId',
      'effect',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      subjectKind: {
        type: 'string',
        enum: ['user', 'team', 'organization'],
      },
      subjectId: { type: 'string', format: 'uuid' },
      resourceId: { type: 'string', format: 'uuid' },
      effect: { type: 'string', enum: ['allow', 'deny'] },
      accessProfileKey: { type: ['string', 'null'] },
      permissionKey: { type: ['string', 'null'] },
    },
  },
  AccessListResponse: {
    type: 'object',
    required: ['access'],
    properties: {
      access: {
        type: 'array',
        items: { $ref: '#/components/schemas/AccessRecord' },
      },
    },
  },
  CreateAccessRequest: {
    type: 'object',
    required: ['subjectKind', 'subjectId', 'resourceId', 'effect'],
    description:
      'Exactly one of accessProfileKey or permissionKey must be provided. accessProfileKey is expanded server-side into multiple atomic grant rows in a single transaction.',
    properties: {
      subjectKind: {
        type: 'string',
        enum: ['user', 'team', 'organization'],
      },
      subjectId: { type: 'string', format: 'uuid' },
      resourceId: { type: 'string', format: 'uuid' },
      effect: { type: 'string', enum: ['allow', 'deny'] },
      accessProfileKey: {
        type: 'string',
        description:
          'Sugar: expanded to atomic permission rows server-side. Exactly one of `accessProfileKey` or `permissionKey` required.',
      },
      permissionKey: {
        type: 'string',
        description: 'Single atomic permission key from the catalog.',
      },
    },
  },
  CreateAccessResponse: {
    type: 'object',
    required: ['ok', 'id'],
    properties: {
      ok: { type: 'boolean', const: true },
      id: { type: 'string', format: 'uuid' },
      created: {
        type: 'boolean',
        description: 'True if at least one new row was inserted.',
      },
    },
  },
  RevokeAccessResponse: {
    type: 'object',
    required: ['ok'],
    properties: {
      ok: { type: 'boolean', const: true },
    },
  },
}

export const accessPaths: Record<string, unknown> = {
  '/api/client/v1/invitations/{id}/accept': {
    post: {
      tags: ['client'],
      summary: 'Accept an organization invitation',
      description:
        'Atomically claims a pending invitation, creates org membership (and optional team membership), materializes the invitation\'s `grants` JSON into `access` rows, and updates the active session `organizationId`. When `grants` is null, a default org-scoped `member` role grant is applied.',
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
        '200': {
          description: 'Invitation accepted',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/InvitationAcceptResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '403': {
          description: 'Invitation email does not match session user',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '404': {
          description: 'Invitation not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '410': {
          description: 'Invitation expired or already used',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/access-profiles': {
    get: {
      tags: ['client'],
      summary: 'List access profiles',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'Access profile catalog',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AccessProfilesResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/permissions': {
    get: {
      tags: ['client'],
      summary: 'List authorization permissions',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'Permission catalog',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/PermissionsResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/access/check': {
    get: {
      tags: ['client'],
      summary: 'Check a permission for the signed-in user',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'resourceId',
          in: 'query',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
        {
          name: 'permissionKey',
          in: 'query',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        '200': {
          description: 'Permission check result',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['allowed'],
                properties: { allowed: { type: 'boolean' } },
              },
            },
          },
        },
        '400': {
          description: 'Missing or invalid query parameters',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '404': {
          description: 'Resource not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/access/resource-id': {
    get: {
      tags: ['client'],
      summary: 'Resolve a resource id for an entity',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'kind',
          in: 'query',
          required: true,
          schema: { type: 'string' },
        },
        {
          name: 'itemId',
          in: 'query',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Resolved resource id',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['resourceId', 'kind', 'itemId'],
                properties: {
                  resourceId: { type: 'string', format: 'uuid' },
                  kind: { type: 'string' },
                  itemId: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
        },
        '400': {
          description: 'Missing or invalid query parameters',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Resource not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/access': {
    get: {
      tags: ['client'],
      summary: 'List access grants for a resource',
      description:
        'Requires the resource-kind management permission: organization:members, team:members, or {kind}:rw for other kinds.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'resourceId',
          in: 'query',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Access grants for the resource',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/AccessListResponse' },
            },
          },
        },
        '400': {
          description: 'Missing or invalid query parameters',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Resource not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string', example: 'Not found' } },
              },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    post: {
      tags: ['client'],
      summary: 'Create an access grant',
      description:
        'Requires the resource-kind management permission on the target resourceId. Accepts accessProfileKey as sugar — expanded server-side to multiple atomic grant rows in one transaction.',
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateAccessRequest' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Access grant created',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/CreateAccessResponse' },
            },
          },
        },
        '400': {
          description: 'Invalid request',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description:
            'Target entity or subject not found (`Entity not found`, `User not found`, `Team not found`, or `Organization not found`)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: {
                  error: {
                    type: 'string',
                    enum: [
                      'Entity not found',
                      'User not found',
                      'Team not found',
                      'Organization not found',
                    ],
                  },
                },
              },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/access/{id}': {
    delete: {
      tags: ['client'],
      summary: 'Revoke an access grant',
      description:
        'Requires the resource-kind management permission on the grant\'s target resource.',
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
        '200': {
          description: 'Access grant revoked',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RevokeAccessResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Access grant not found',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  },
}
