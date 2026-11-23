import { API_ERROR_CODES } from './error-codes.ts'

/**
 * The OpenAPI schema of the shared error envelope (`apiErrorBody` in
 * `api-error.ts`). The client, admin and daemon specs all use this one object.
 * Only `error` is required while routes move onto the helper one by one; every
 * route that has moved also sends `ok`, `code` and `message`.
 */
export const apiErrorSchema = {
  type: 'object',
  required: ['error'] as string[],
  properties: {
    ok: { type: 'boolean', const: false },
    error: {
      type: 'string',
      description:
        'Same text as `message`, or the code when no text was given. Kept for older clients.',
    },
    code: {
      type: 'string',
      enum: Object.keys(API_ERROR_CODES),
      description: 'Stable machine code. Clients branch on this.',
    },
    message: { type: 'string', description: 'Human text. May change.' },
    details: { description: 'Optional structured context for the code.' },
  },
} as const
