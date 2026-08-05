export const principalSchemas = {
  ProjectPrincipalRow: {
    type: 'object',
    required: ['id', 'kind', 'provider', 'username', 'serviceIds', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string' },
      kind: { type: 'string' },
      provider: { type: 'string' },
      username: { type: 'string' },
      projectId: { type: ['string', 'null'] },
      metadata: { type: 'object', nullable: true },
      options: { type: 'object', nullable: true },
      serviceIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        description: 'Services this Linux (server) user is bound to (storage owner)',
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
    description: 'Password is never returned on GET',
  },
  ProjectPrincipalsResponse: {
    type: 'object',
    required: ['principals'],
    properties: {
      principals: {
        type: 'array',
        items: { $ref: '#/components/schemas/ProjectPrincipalRow' },
      },
    },
  },
  ResourceLimits: {
    type: 'object',
    properties: {
      maxCpus: { type: 'number' },
      maxMemoryBytes: { type: 'number' },
      maxServicesPerEnvironment: { type: 'number' },
    },
  },
  ResourceLimitsResponse: {
    type: 'object',
    required: ['resourceLimits'],
    properties: {
      resourceLimits: { $ref: '#/components/schemas/ResourceLimits' },
    },
  },
  SaveResourceLimitsRequest: {
    type: 'object',
    required: ['resourceLimits'],
    properties: {
      resourceLimits: { $ref: '#/components/schemas/ResourceLimits' },
    },
  },
  UpdateProjectPrincipalAssignmentsRequest: {
    type: 'object',
    required: ['serviceIds'],
    properties: {
      serviceIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
      },
    },
  },
}

export const principalPaths = {
  '/api/client/v1/projects/{projectId}/principals': {
    get: {
      tags: ['Principals'],
      summary: 'List project principals',
      parameters: [
        {
          name: 'projectId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: {
          description: 'Project principals',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ProjectPrincipalsResponse' },
            },
          },
        },
      },
    },
    post: {
      tags: ['Principals'],
      summary: 'Create a Linux (server) user for the project',
      parameters: [
        {
          name: 'projectId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['username'],
              properties: {
                username: {
                  type: 'string',
                  description:
                    'Linux username (≤ 28 chars, POSIX allowlist). Host home is /srv/users/<username>. Cap leaves room for `<username>-grp`.',
                },
                serviceIds: {
                  type: 'array',
                  items: { type: 'string', format: 'uuid' },
                  description: 'Services this Linux (server) user is bound to',
                },
                options: {
                  type: 'object',
                  description: 'Optional shell and other principal options',
                },
                uid: {
                  type: 'integer',
                  description:
                    'Optional operator uid override (both uid and gid required together; omit for host allocation)',
                },
                gid: {
                  type: 'integer',
                  description:
                    'Optional operator gid override (both uid and gid required together; omit for host allocation)',
                },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description:
            'Created Linux (server) user. uid/gid are echoed only when an explicit override was supplied.',
        },
        400: {
          description: 'invalid_service_ids | username_reserved | Invalid request',
        },
        409: { description: 'username_in_use' },
      },
    },
  },
  '/api/client/v1/projects/{projectId}/principals/{id}': {
    patch: {
      tags: ['Principals'],
      summary: 'Replace service assignments for a Linux (server) user',
      parameters: [
        { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateProjectPrincipalAssignmentsRequest' },
          },
        },
      },
      responses: {
        200: { description: 'Updated assignments' },
        400: { description: 'invalid_service_ids' },
      },
    },
  },
  '/api/client/v1/organizations/{id}/resource-limits': {
    get: {
      tags: ['Resource limits'],
      summary: 'Get organization resource limits',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Organization limits',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ResourceLimitsResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Resource limits'],
      summary: 'Update organization resource limits',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SaveResourceLimitsRequest' },
          },
        },
      },
      responses: {
        200: { description: 'Updated limits' },
      },
    },
  },
  '/api/client/v1/servers/{id}/resource-limits': {
    get: {
      tags: ['Resource limits'],
      summary: 'Get server resource limits',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Server limits',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ResourceLimitsResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Resource limits'],
      summary: 'Update server resource limits',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SaveResourceLimitsRequest' },
          },
        },
      },
      responses: {
        200: { description: 'Updated limits' },
      },
    },
  },
}
