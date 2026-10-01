import { resourceErrorResponses } from './shared.ts'

/**
 * OpenAPI for the people in an organization
 * (`client/organizations/members.ts`, `members-list.ts`): list them, remove one
 * or leave. Owners and managers list and remove; anyone can leave.
 */

const ORG_ID_PARAM = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const MEMBER_ID_PARAM = {
  name: 'memberId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const errorJson = {
  'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
}

export const organizationMemberSchemas = {
  OrganizationMembersResponse: {
    type: 'object',
    required: ['members'],
    properties: {
      members: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'name', 'email', 'role', 'joinedAt'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: ['string', 'null'] },
            email: { type: 'string' },
            role: { type: 'string', enum: ['owner', 'manager', 'member'] },
            joinedAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  },
}

export const organizationMemberPaths: Record<string, unknown> = {
  '/api/client/v1/organizations/{id}/members': {
    get: {
      tags: ['Organizations'],
      summary: 'List the people in an organization',
      description:
        'Owners and managers only. Each person on a team in the organization or holding a grant on it: id, name, email, role (`owner`, `manager` or `member`) and the date they joined. Owners first. No credentials or session data.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM],
      responses: {
        '200': {
          description: 'Members',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrganizationMembersResponse' },
            },
          },
        },
        ...resourceErrorResponses({ notFound: true }),
      },
    },
  },
  '/api/client/v1/organizations/{id}/members/{memberId}': {
    delete: {
      tags: ['Organizations'],
      summary: 'Remove a person from an organization',
      description:
        "Removes the person's team memberships and every grant they hold inside the organization. Anyone can remove themselves (leave). An owner or manager can remove others; only an owner can remove an owner. The last owner cannot be removed (409).",
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, MEMBER_ID_PARAM],
      responses: {
        '200': {
          description: 'Removed',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok'],
                properties: { ok: { type: 'boolean', const: true } },
              },
            },
          },
        },
        ...resourceErrorResponses({ notFound: true }),
        '409': {
          description: 'Cannot remove the last owner of an organization',
          content: errorJson,
        },
      },
    },
  },
}
