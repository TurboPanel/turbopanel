export const accessSchemas = {
  PermissionKey: {
    type: 'string',
    enum: [
      'organization:own',
      'organization:manage',
      'team:own',
      'team:manage',
      'system:read',
      'system:operate',
      'system:manage',
    ],
    description: 'Atomic permission key from the fixed catalog.',
  },
  InvitationGrantSpec: {
    type: 'object',
    required: ['entityType', 'entityId', 'permissionKey'],
    properties: {
      entityType: {
        type: 'string',
        enum: ['organization', 'team'],
        description: 'Grant target entity kind. Only organization and team may hold access grants.',
      },
      entityId: {
        type: 'string',
        format: 'uuid',
        description: 'Primary key of the organization or team entity.',
      },
      effect: {
        type: 'string',
        enum: ['allow'],
        default: 'allow',
        description: 'Only allow grants are supported; deny grants are rejected.',
      },
      permissionKey: {
        $ref: '#/components/schemas/PermissionKey',
        description:
          'Atomic permission key. Organization permissions require entityType organization; team permissions require entityType team.',
      },
    },
    description:
      'One intended access grant stored on invitation.grants. Materialized into grant rows on invitation accept.',
  },
  InvitationAcceptResponse: {
    type: 'object',
    required: ['ok', 'organizationId'],
    properties: {
      ok: { type: 'boolean', const: true },
      organizationId: {
        type: 'string',
        description:
          'Organization joined by the invitation. The client should navigate to this organization explicitly after accept.',
      },
    },
  },
  PermissionRecord: {
    type: 'object',
    required: ['key', 'displayName'],
    properties: {
      key: { $ref: '#/components/schemas/PermissionKey' },
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
      'permissionKey',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      subjectKind: {
        type: 'string',
        enum: ['user', 'team', 'organization'],
        description: 'Kind of subject receiving the grant.',
      },
      subjectId: { type: 'string', format: 'uuid' },
      resourceId: {
        type: 'string',
        format: 'uuid',
        description:
          'UUID of the grant target entity (organization or team primary key).',
      },
      effect: {
        type: 'string',
        enum: ['allow'],
        description: 'Always allow — deny grants are not supported.',
      },
      permissionKey: { $ref: '#/components/schemas/PermissionKey' },
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
    required: ['subjectKind', 'subjectId', 'resourceId', 'effect', 'permissionKey'],
    properties: {
      subjectKind: {
        type: 'string',
        enum: ['user', 'team', 'organization'],
        description: 'Kind of subject receiving the grant.',
      },
      subjectId: { type: 'string', format: 'uuid' },
      resourceId: {
        type: 'string',
        format: 'uuid',
        description:
          'UUID of the grant target entity. Must resolve to an organization or team row.',
      },
      effect: {
        type: 'string',
        enum: ['allow'],
        description: 'Only allow grants are supported; deny grants are rejected with 400.',
      },
      permissionKey: {
        $ref: '#/components/schemas/PermissionKey',
        description:
          'Atomic permission key. Organization keys require an organization resourceId; team keys require a team resourceId.',
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
      tags: ['Authorization'],
      summary: 'Accept an organization invitation',
      description:
        'Atomically claims a pending invitation, creates org membership (and optional team membership), materializes the invitation\'s `grants` JSON into user-scoped grant rows, and returns the accepted organization id. When `grants` is null, a default `organization:manage` grant on the organization is applied. Grant targets must be organization or team entities with compatible permission keys.',
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
        '400': {
          description: 'Invalid invitation grants (incompatible permission and entity)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string', example: 'Invalid invitation grants' } },
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
  '/api/client/v1/permissions': {
    get: {
      tags: ['Authorization'],
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
      tags: ['Authorization'],
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
          schema: { $ref: '#/components/schemas/PermissionKey' },
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
      tags: ['Authorization'],
      summary: 'Resolve a resource id for an organization or team entity',
      description:
        'Maps a grant-target kind and item id to the resourceId used by other access endpoints. Only `organization` and `team` kinds are supported.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'kind',
          in: 'query',
          required: true,
          schema: { type: 'string', enum: ['organization', 'team'] },
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
      tags: ['Authorization'],
      summary: 'List access grants for an organization or team resource',
      description:
        'Requires `organization:own` on the resource (checked via `getAccessManagementPermission`). Only organization and team entities may hold grants.',
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
      tags: ['Authorization'],
      summary: 'Create an access grant on an organization or team',
      description:
        'Requires `organization:own` on the target resource (checked via `getAccessManagementPermission`). The resourceId must resolve to an organization or team entity; permission keys must match the entity kind.',
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
      tags: ['Authorization'],
      summary: 'Revoke an access grant',
      description:
        'Requires `organization:own` on the grant\'s target resource (checked via `getAccessManagementPermission`).',
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
