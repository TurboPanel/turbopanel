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
        description: 'Services this principal is bound to (Linux user / storage owner)',
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
      summary: 'Create a project principal',
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
                username: { type: 'string' },
                serviceIds: {
                  type: 'array',
                  items: { type: 'string', format: 'uuid' },
                },
                options: { type: 'object' },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Created principal' },
        400: { description: 'invalid_service_ids' },
      },
    },
  },
  '/api/client/v1/projects/{projectId}/principals/{id}': {
    patch: {
      tags: ['Principals'],
      summary: 'Replace service assignments for a project principal',
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
