import { buildResourceCrudPaths } from './shared.ts'

export const workspaceSchemas = {
  WorkspaceRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      displayName: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      organizationId: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  WorkspacesResponse: {
    type: 'object',
    required: ['workspaces'],
    properties: {
      workspaces: {
        type: 'array',
        items: { $ref: '#/components/schemas/WorkspaceRow' },
      },
    },
  },
  CreateWorkspaceRequest: {
    type: 'object',
    properties: {
      displayName: { type: 'string' },
      description: { type: 'string' },
    },
  },
  EntityOkResponse: {
    type: 'object',
    required: ['ok', 'id'],
    properties: {
      ok: { type: 'boolean', const: true },
      id: { type: 'string' },
    },
  },
  UpdateEntityOkResponse: {
    type: 'object',
    required: ['ok'],
    properties: {
      ok: { type: 'boolean', const: true },
    },
  },
}

export const workspacePaths = buildResourceCrudPaths({
  plural: 'workspaces',
  singular: 'workspace',
  listSchema: 'WorkspacesResponse',
  rowSchema: 'WorkspaceRow',
  createSchema: 'CreateWorkspaceRequest',
  createBodyRequired: false,
})
