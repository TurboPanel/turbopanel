import { ADMIN_API_PREFIX } from '../../app/surfaces.ts'

const cookieSecurity = [{ cookieAuth: [] }] as const

const adminErrors = {
  '401': { description: 'Unauthorized' },
  '403': { description: 'Forbidden — requires admin or superadmin role' },
  '501': {
    description:
      'Not available here: mail does not go through RabbitMQ (hosted control planes use Cloudflare Queues)',
  },
  '503': { description: 'The mail queue could not be reached' },
} as const

/**
 * The mail dead-letter queue: jobs whose send was refused for good or whose
 * retries ran out. Listing never returns a job's body and masks the recipient.
 */
export const MAIL_DEAD_LETTER_PATHS = {
  [`${ADMIN_API_PREFIX}/mail/dead-letters`]: {
    get: {
      tags: ['Settings'],
      summary: 'List mail jobs that gave up',
      description:
        'Returns `total` (messages in the dead-letter queue) and up to `limit` ' +
        '(1 to 100, default 50) `items`: `id`, `jobType`, `to` (masked, like ' +
        '`j***@example.com`), `failedAttempts`, `reason` and `deadAt`. Nothing ' +
        'is removed from the queue and the job body (sign-in codes, links) is ' +
        'never returned.',
      security: [...cookieSecurity],
      parameters: [{ name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }],
      responses: {
        '200': { description: 'The dead letters' },
        '400': { description: 'limit out of range' },
        ...adminErrors,
      },
    },
  },
  [`${ADMIN_API_PREFIX}/mail/dead-letters/{id}/replay`]: {
    post: {
      tags: ['Settings'],
      summary: 'Replay one dead-lettered mail job',
      description:
        'Puts the job back on the send queue with its attempt count reset, so ' +
        'it gets the full retry schedule again, and removes it from the ' +
        'dead-letter queue. Answers `{ replayed: 1 }`.',
      security: [...cookieSecurity],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        '200': { description: 'Replayed' },
        '404': {
          description: 'No dead letter has that id (it may already be replayed or expired)',
        },
        ...adminErrors,
      },
    },
  },
  [`${ADMIN_API_PREFIX}/mail/dead-letters/replay-all`]: {
    post: {
      tags: ['Settings'],
      summary: 'Replay every dead-lettered mail job',
      description:
        'Replays up to `limit` (1 to 1000, default 1000) jobs, oldest first. ' +
        'Answers `{ replayed, failed, remaining }`: `failed` jobs the broker ' +
        'refused stay in the dead-letter queue.',
      security: [...cookieSecurity],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: { type: 'object', properties: { limit: { type: 'integer' } } },
          },
        },
      },
      responses: {
        '200': { description: 'Counts of replayed, failed and remaining jobs' },
        '400': { description: 'limit out of range' },
        ...adminErrors,
      },
    },
  },
} as const
