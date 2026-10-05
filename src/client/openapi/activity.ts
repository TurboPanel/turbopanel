import { resourceErrorResponses } from './shared.ts'

/**
 * OpenAPI for the organization activity feed
 * (`client/organizations/activity-routes.ts`, `features/commands/activity-query.ts`).
 */

export const activitySchemas = {
  ActivityItem: {
    type: 'object',
    required: [
      'id',
      'projectId',
      'projectName',
      'environmentId',
      'environmentName',
      'serverId',
      'action',
      'state',
      'startedAt',
      'step',
      'totalSteps',
      'durationSecs',
      'errorMessage',
      'crashCount',
    ],
    properties: {
      id: { type: 'string', format: 'uuid', description: 'The command id.' },
      projectId: { type: ['string', 'null'], format: 'uuid' },
      projectName: { type: ['string', 'null'] },
      environmentId: { type: ['string', 'null'], format: 'uuid' },
      environmentName: { type: ['string', 'null'] },
      serverId: { type: 'string', format: 'uuid' },
      action: { type: 'string', enum: ['deploy', 'start', 'restart', 'stop'] },
      state: { type: 'string', enum: ['deploying', 'failed'] },
      startedAt: { type: 'string', format: 'date-time' },
      step: { type: 'null', description: 'Reserved: per-step progress is not recorded yet.' },
      totalSteps: { type: 'null', description: 'Reserved: per-step progress is not recorded yet.' },
      durationSecs: { type: 'integer', minimum: 0 },
      errorMessage: { type: ['string', 'null'], description: 'Set when `state` is `failed`.' },
      crashCount: { type: 'null', description: 'Reserved: restart counts are not recorded yet.' },
    },
  },
  ActivityFeedResponse: {
    type: 'object',
    required: ['ok', 'items', 'total', 'hasMore'],
    properties: {
      ok: { type: 'boolean', const: true },
      items: { type: 'array', items: { $ref: '#/components/schemas/ActivityItem' } },
      total: { type: 'integer', minimum: 0 },
      hasMore: { type: 'boolean' },
    },
  },
}

export const activityPaths: Record<string, unknown> = {
  '/api/client/v1/organizations/{id}/activity': {
    get: {
      tags: ['Organizations'],
      summary: 'List the organization’s running and recently failed deploys',
      description:
        'Owners and managers only; poll it, nothing is pushed. Deploys, restarts and stops that are still running, plus those that failed or timed out in the last 7 days, newest first, on servers the caller can see. `deploying` covers every in-progress action. Crash states are not served yet.',
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        {
          name: 'filter',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['all', 'deploying', 'failed'], default: 'all' },
        },
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
          description: 'Values above 100 are clamped to 100.',
        },
        {
          name: 'offset',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 0, default: 0 },
        },
      ],
      responses: {
        '200': {
          description: 'One page of activity',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/ActivityFeedResponse' } },
          },
        },
        ...resourceErrorResponses({ badRequest: true, notFound: true }),
      },
    },
  },
}
