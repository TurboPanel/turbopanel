/**
 * OpenAPI for deleting a project or an environment in one step: the preview
 * the confirmation shows, and the delete with the refusals it can answer.
 */
import { resourceErrorResponses } from './shared.ts'

const security = [{ cookieAuth: [] }]
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } }

const usedBy = {
  type: 'object',
  description: 'What outside the deleted rows still uses the Hosting Account, counted per kind.',
  properties: {
    tenancies: { type: 'integer' },
    bindings: { type: 'integer' },
    storages: { type: 'integer' },
    secrets: { type: 'integer' },
    logins: { type: 'integer' },
    folders: { type: 'integer' },
  },
}

export const deletePlanSchemas = {
  DeletePlanBlocker: {
    type: 'object',
    required: ['error', 'message'],
    description:
      'A reason the delete cannot run yet, in plain words. Codes: `managed_runtime_present` (delete the managed database first, with its own confirmation), `common_asset_in_use` (another environment uses a shared service or volume that would go; `uses` lists them), `server_offline` (a server the delete has to reach is not connected; `serverIds`), and for an environment `primary_environment_cannot_be_deleted` or `environment_running` (a deploy is in progress).',
    properties: {
      error: { type: 'string' },
      message: { type: 'string' },
      serverIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      uses: { type: 'array', items: { type: 'object' } },
    },
  },
  DeletePlanResponse: {
    type: 'object',
    required: [
      'ok',
      'environments',
      'services',
      'servers',
      'folders',
      'hostingAccounts',
      'blockers',
    ],
    properties: {
      ok: { type: 'boolean' },
      environments: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'name'],
          properties: { id: { type: 'string' }, name: { type: ['string', 'null'] } },
        },
      },
      services: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'name', 'environmentId'],
          properties: {
            id: { type: 'string' },
            name: { type: ['string', 'null'] },
            environmentId: { type: 'string' },
          },
        },
      },
      servers: {
        type: 'array',
        description: 'Every server the delete reaches or that holds one of the folders.',
        items: {
          type: 'object',
          required: ['id', 'name', 'connected'],
          properties: {
            id: { type: 'string' },
            name: { type: ['string', 'null'] },
            connected: { type: 'boolean' },
          },
        },
      },
      folders: {
        type: 'array',
        description:
          'Service and volume folders on the servers. `remove`: deleted from the server after the services stop. `keep`: a volume set to keep its data (its folder and its Hosting Account stay).',
        items: {
          type: 'object',
          required: ['id', 'serverId', 'kind', 'path', 'assetName', 'action'],
          properties: {
            id: { type: 'string' },
            serverId: { type: 'string' },
            kind: { type: 'string', enum: ['service', 'volume'] },
            path: {
              type: ['string', 'null'],
              description: '`/srv/users/{owner}/{scope}/services|volumes/{name}`.',
            },
            assetName: { type: ['string', 'null'] },
            action: { type: 'string', enum: ['remove', 'keep'] },
          },
        },
      },
      hostingAccounts: {
        type: 'array',
        description:
          "The project's Hosting Accounts (site owner Linux users). `remove`: deleted with the project, user and home, once its folders are gone. `keep`: something outside the project still uses it (`usedBy`). Always empty for an environment delete.",
        items: {
          type: 'object',
          required: ['id', 'username', 'action'],
          properties: {
            id: { type: 'string' },
            username: { type: 'string' },
            action: { type: 'string', enum: ['remove', 'keep'] },
            usedBy,
          },
        },
      },
      blockers: { type: 'array', items: { $ref: '#/components/schemas/DeletePlanBlocker' } },
    },
  },
  DeleteCleanupResponse: {
    type: 'object',
    required: ['ok', 'cleanup'],
    properties: {
      ok: { type: 'boolean' },
      warning: { type: 'string' },
      cleanup: {
        type: 'object',
        required: ['folderServerIds'],
        properties: {
          folderServerIds: {
            type: 'array',
            description:
              'Servers asked to remove folders. Each confirms on its own; one that misses the request is asked again when it is connected.',
            items: { type: 'string' },
          },
          hostingAccounts: {
            type: 'object',
            description: 'Project delete only.',
            properties: {
              removing: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'username', 'removed'],
                  properties: {
                    id: { type: 'string' },
                    username: { type: 'string' },
                    removed: {
                      type: 'boolean',
                      description:
                        'True when it was removed right away; otherwise it goes once its folders are gone.',
                    },
                  },
                },
              },
              kept: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'username', 'usedBy'],
                  properties: { id: { type: 'string' }, username: { type: 'string' }, usedBy },
                },
              },
            },
          },
        },
      },
    },
  },
}

/** `GET /{plural}/{id}/delete-preview`. */
export function deletePreviewPath(tag: string, singular: string, description: string) {
  return {
    get: {
      tags: [tag],
      summary: `What deleting this ${singular} removes and keeps`,
      description,
      security,
      parameters: [idParam],
      responses: {
        '200': {
          description: 'The delete plan',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/DeletePlanResponse' } },
          },
        },
        ...resourceErrorResponses({ notFound: true }),
      },
    },
  }
}

/** The `DELETE /{plural}/{id}` operation, with its refusals. */
export function deleteOperation(tag: string, singular: string, description: string) {
  return {
    tags: [tag],
    summary: `Delete ${singular} and everything it owns`,
    description,
    security,
    parameters: [idParam],
    responses: {
      '200': {
        description: `${singular} deleted; folder and Hosting Account removal under way`,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/DeleteCleanupResponse' } },
        },
      },
      '409': {
        description:
          'Refused before anything changed: the first blocker with every blocker in `blockers` (see DeletePlanBlocker), or `project_stop_failed` / `environment_running` with a `message` when the stop could not be sent.',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/DeletePlanBlocker' } },
        },
      },
      ...resourceErrorResponses({ notFound: true }),
    },
  }
}

/** The CRUD item path at `key`, with its `delete` replaced by `operation`. */
export function withDeleteOperation(
  paths: Record<string, unknown>,
  key: string,
  operation: ReturnType<typeof deleteOperation>
): Record<string, unknown> {
  return { ...(paths[key] as Record<string, unknown>), delete: operation }
}
