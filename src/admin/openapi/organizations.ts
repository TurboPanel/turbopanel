import { ADMIN_API_PREFIX } from '../../app/surfaces.ts'

const cookieSecurity = [{ cookieAuth: [] }] as const

/** The platform admin's list of organizations (`admin/organization-routes.ts`). */
export const ORGANIZATION_PATHS = {
  [`${ADMIN_API_PREFIX}/organizations`]: {
    get: {
      tags: ['Instance'],
      summary: 'List every organization',
      description:
        'Platform admin only. Oldest first. Each item: `id`, `name` (may be null), `createdAt`, ' +
        '`owner` (`{ id, name, email }` of the longest-standing owner, or null), `memberCount`, ' +
        '`serverCount`, `projectCount` and `isRoot` (the platform root organization, which cannot be deleted). ' +
        'Deleting goes through `DELETE /api/client/v1/organizations/{id}?confirmName=<name>` ' +
        '(always step-up, name confirmation, refused while servers, tunnels or DNS records remain, never the root).',
      security: [...cookieSecurity],
      responses: {
        '200': {
          description: 'The organizations',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'organizations'],
                properties: {
                  ok: { type: 'boolean', const: true },
                  organizations: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: [
                        'id',
                        'name',
                        'createdAt',
                        'owner',
                        'memberCount',
                        'serverCount',
                        'projectCount',
                        'isRoot',
                      ],
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        name: { type: ['string', 'null'] },
                        createdAt: { type: 'string', format: 'date-time' },
                        owner: {
                          oneOf: [
                            {
                              type: 'object',
                              required: ['id', 'name', 'email'],
                              properties: {
                                id: { type: 'string', format: 'uuid' },
                                name: { type: ['string', 'null'] },
                                email: { type: 'string' },
                              },
                            },
                            { type: 'null' },
                          ],
                        },
                        memberCount: { type: 'integer' },
                        serverCount: { type: 'integer' },
                        projectCount: { type: 'integer' },
                        isRoot: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden — requires admin or superadmin role' },
        '503': { description: 'Database unavailable' },
      },
    },
  },
} as const
