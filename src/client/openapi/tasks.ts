import { TASK_CONCURRENCY_POLICIES } from '../../lib/db/task-records.ts'
import { buildResourceCrudPaths, clientErrorJson } from './shared.ts'

const concurrencyPolicySchema = {
  type: 'string',
  enum: [...TASK_CONCURRENCY_POLICIES],
  description: '`allow` | `forbid` | `replace` (CHECK `task_concurrency_policy_check`)',
}

export const taskSchemas = {
  TaskRow: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      serviceId: { type: 'string' },
      name: { type: 'string' },
      schedule: {
        type: 'string',
        description:
          '5-field cron expression or a supported `@`-shorthand (`@hourly`, `@daily`, …). Stored verbatim; `@reboot` and day-of-month + day-of-week unions are rejected.',
      },
      command: {
        type: 'string',
        description:
          'Absolute-path argv line with no shell metacharacters (no pipes, redirection, or globs). Stored verbatim.',
      },
      timezone: { type: ['string', 'null'] },
      isEnabled: { type: 'boolean' },
      concurrencyPolicy: concurrencyPolicySchema,
      timeoutSeconds: { type: ['integer', 'null'] },
      metadata: { type: ['object', 'null'] },
      options: { type: ['object', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  TasksResponse: {
    type: 'object',
    required: ['tasks'],
    properties: {
      tasks: {
        type: 'array',
        items: { $ref: '#/components/schemas/TaskRow' },
      },
    },
  },
  CreateTaskRequest: {
    type: 'object',
    required: ['serviceId', 'name', 'schedule', 'command'],
    properties: {
      serviceId: { type: 'string' },
      name: { type: 'string' },
      schedule: {
        type: 'string',
        description:
          '5-field cron expression or a supported `@`-shorthand (`@hourly`, `@daily`, …)',
      },
      command: {
        type: 'string',
        description: 'Absolute-path argv line with no shell metacharacters',
      },
      timezone: { type: ['string', 'null'] },
      isEnabled: { type: 'boolean' },
      concurrencyPolicy: concurrencyPolicySchema,
      timeoutSeconds: { type: ['integer', 'null'] },
      metadata: { type: 'object' },
      options: { type: 'object' },
    },
  },
  UpdateTaskRequest: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      schedule: {
        type: 'string',
        description:
          '5-field cron expression or a supported `@`-shorthand (`@hourly`, `@daily`, …)',
      },
      command: {
        type: 'string',
        description: 'Absolute-path argv line with no shell metacharacters',
      },
      timezone: { type: ['string', 'null'] },
      isEnabled: { type: 'boolean' },
      concurrencyPolicy: concurrencyPolicySchema,
      timeoutSeconds: { type: ['integer', 'null'] },
      metadata: { type: 'object' },
      options: { type: 'object' },
    },
  },
}

const listQueryParameters = [
  {
    name: 'serviceId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description: 'List tasks for this service. Mutually exclusive with environmentId.',
  },
  {
    name: 'environmentId',
    in: 'query',
    required: false,
    schema: { type: 'string' },
    description:
      'List tasks for every visible service in this environment. Mutually exclusive with serviceId.',
  },
] as const

const basePaths = buildResourceCrudPaths({
  plural: 'tasks',
  singular: 'task',
  tag: 'Tasks',
  listSchema: 'TasksResponse',
  rowSchema: 'TaskRow',
  createSchema: 'CreateTaskRequest',
  patchSchema: 'UpdateTaskRequest',
})

const tasksBasePath = '/api/client/v1/tasks'
const taskIdPath = `${tasksBasePath}/{id}`

const mutationExtraResponses = {
  '400': {
    description: 'Invalid request; task_schedule_invalid; task_command_invalid',
    content: { 'application/json': { schema: clientErrorJson } },
  },
  '409': {
    description: 'task_name_in_use',
    content: { 'application/json': { schema: clientErrorJson } },
  },
}

export const taskPaths = {
  ...basePaths,
  [tasksBasePath]: {
    ...(basePaths[tasksBasePath] as Record<string, unknown>),
    get: {
      ...((basePaths[tasksBasePath] as Record<string, unknown>).get as Record<string, unknown>),
      parameters: listQueryParameters,
    },
    post: {
      ...((basePaths[tasksBasePath] as Record<string, unknown>).post as Record<string, unknown>),
      responses: {
        ...(((basePaths[tasksBasePath] as Record<string, unknown>).post as Record<string, unknown>)
          .responses as Record<string, unknown>),
        ...mutationExtraResponses,
      },
    },
  },
  [taskIdPath]: {
    ...(basePaths[taskIdPath] as Record<string, unknown>),
    patch: {
      ...((basePaths[taskIdPath] as Record<string, unknown>).patch as Record<string, unknown>),
      responses: {
        ...(((basePaths[taskIdPath] as Record<string, unknown>).patch as Record<string, unknown>)
          .responses as Record<string, unknown>),
        ...mutationExtraResponses,
      },
    },
  },
}
