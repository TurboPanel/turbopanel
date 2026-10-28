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
      'failure',
      'startedAt',
      'finishedAt',
      'step',
      'totalSteps',
      'stepLabel',
      'durationSecs',
      'errorMessage',
      'actorType',
      'actorName',
      'trigger',
      'commit',
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
      state: {
        type: 'string',
        enum: ['queued', 'deploying', 'succeeded', 'failed', 'cancelled'],
        description:
          '`queued` is waiting to start (in the queue, or for another build on the server); `deploying` is being worked on, whatever the action.',
      },
      failure: {
        type: ['string', 'null'],
        enum: ['timed_out', 'rolled_back', 'needs_attention', null],
        description:
          'Set only when `state` is `failed`: it timed out, the previous version was put back, or it stopped on purpose and needs a person. Null for a plain failure.',
      },
      startedAt: { type: 'string', format: 'date-time' },
      finishedAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'When it ended; null while it is in progress.',
      },
      step: {
        type: ['integer', 'null'],
        minimum: 0,
        description:
          'Steps finished so far, plus one while a step is running. Null until the server reports a step plan.',
      },
      totalSteps: {
        type: ['integer', 'null'],
        minimum: 0,
        description:
          'Steps that have work to do (planned steps that were already on the server are not counted). Null until the server reports a step plan.',
      },
      stepLabel: {
        type: ['string', 'null'],
        description: 'Plain-words label of the running step, or null when none is running.',
      },
      durationSecs: {
        type: ['integer', 'null'],
        minimum: 0,
        description:
          'Running time so far, or how long it took. Null for a finished row with no recorded end.',
      },
      errorMessage: { type: ['string', 'null'], description: 'Set when `state` is `failed`.' },
      actorType: {
        type: 'string',
        enum: ['user', 'system'],
        description: '`user` when a person asked for it, `system` when the panel did (a push).',
      },
      actorName: {
        type: ['string', 'null'],
        description:
          'For `user`: the person’s name (else email) while they are a member of the organization, `Platform Admin` for an instance administrator who is not, `Former Member` for anyone else. Null for `system`.',
      },
      trigger: {
        oneOf: [{ $ref: '#/components/schemas/ActivityTrigger' }, { type: 'null' }],
        description: 'The push that set it off; null for a person’s deploy.',
      },
      commit: {
        oneOf: [{ $ref: '#/components/schemas/ActivityCommit' }, { type: 'null' }],
        description: 'The commit the deploy put live, when it recorded one.',
      },
      crashCount: { type: 'null', description: 'Reserved: restart counts are not recorded yet.' },
    },
  },
  ActivityTrigger: {
    type: 'object',
    required: ['kind', 'branch', 'commitSha', 'sourceId', 'pushedBy'],
    properties: {
      kind: { type: 'string', const: 'push' },
      branch: { type: ['string', 'null'] },
      commitSha: { type: ['string', 'null'] },
      sourceId: { type: ['string', 'null'], format: 'uuid' },
      pushedBy: {
        type: ['string', 'null'],
        maxLength: 100,
        description:
          'Git provider login of the person who pushed (never an email). Null when the push did not name one, including deploys recorded before it was kept.',
      },
    },
  },
  ActivityCommit: {
    type: 'object',
    required: ['sha', 'message'],
    properties: {
      sha: { type: 'string' },
      message: { type: ['string', 'null'], description: 'The commit subject, when recorded.' },
    },
  },
  ActivityFeedResponse: {
    type: 'object',
    required: ['ok', 'items', 'total', 'totalCapped', 'hasMore'],
    properties: {
      ok: { type: 'boolean', const: true },
      items: { type: 'array', items: { $ref: '#/components/schemas/ActivityItem' } },
      total: {
        type: 'integer',
        minimum: 0,
        description: 'Matching rows, counted up to 1000 past the end of this page.',
      },
      totalCapped: { type: 'boolean', description: 'True when there are more rows than `total`.' },
      hasMore: { type: 'boolean' },
    },
  },
}

export const activityPaths: Record<string, unknown> = {
  '/api/client/v1/organizations/{id}/activity': {
    get: {
      tags: ['Organizations'],
      summary: 'List the organization’s deploys, restarts and stops',
      description:
        'Owners and managers only; poll it, nothing is pushed. Every deploy, restart and stop on servers the caller can see, newest first, whatever the outcome: queued, running, succeeded, failed, timed out, cancelled or rolled back. Filter `deploying` is everything still in progress; `failed` includes timed out and rolled back. Deploys are kept for good; restarts and stops go after the command retention window. Crash states are not served yet.',
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        {
          name: 'filter',
          in: 'query',
          required: false,
          schema: {
            type: 'string',
            enum: ['all', 'deploying', 'succeeded', 'failed'],
            default: 'all',
          },
        },
        {
          name: 'projectId',
          in: 'query',
          required: false,
          schema: { type: 'string', format: 'uuid' },
          description: 'Only this project’s environments.',
        },
        {
          name: 'environmentId',
          in: 'query',
          required: false,
          schema: { type: 'string', format: 'uuid' },
          description: 'Only this environment; wins over `projectId`.',
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
