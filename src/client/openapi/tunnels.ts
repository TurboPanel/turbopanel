import { resourceErrorResponses } from './shared.ts'

/**
 * OpenAPI for tunnel provider accounts and their API tokens
 * (`client/organizations/carrier-routes.ts`). Owners and managers only. A
 * token is write-only: it is accepted once, checked with the provider, sealed
 * and never returned; responses carry a label and the last four characters.
 */

const ORG_ID_PARAM = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const CARRIER_ID_PARAM = {
  name: 'carrierId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const BADGE_ID_PARAM = {
  name: 'badgeId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const CHECK_PROPERTIES = {
  zones: {
    type: 'array',
    description: 'The zones the token can see (empty when the provider would not list them).',
    items: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
    },
  },
  missing: {
    type: 'array',
    description: 'Permissions the token still lacks, in plain words.',
    items: { type: 'string' },
  },
} as const

export const tunnelSchemas = {
  BadgeZone: {
    type: 'object',
    properties: { id: { type: 'string' }, name: { type: 'string' } },
  },
  Badge: {
    type: 'object',
    description: 'An API token on a provider account. The token is never part of it.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      carrierId: { type: 'string', format: 'uuid' },
      label: { type: 'string' },
      lastFour: { type: 'string', description: 'Last 4 characters of the token.' },
      kind: {
        type: ['string', 'null'],
        enum: ['account', 'user', null],
        description: 'Who owns the API Token at the provider, when known.',
      },
      expiresAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'When the provider says the token stops working, if it reports one.',
      },
      capabilities: {
        type: 'object',
        description:
          'What the last check found the token reaches. `tunnels` is account-wide. `dns` and `certificates` list the zones the token reaches (a token can be limited to some zones).',
        properties: {
          tunnels: { type: 'boolean' },
          dns: { type: 'array', items: { $ref: '#/components/schemas/BadgeZone' } },
          certificates: { type: 'array', items: { $ref: '#/components/schemas/BadgeZone' } },
        },
      },
      status: { type: 'string', enum: ['active', 'attention'] },
      lastCheckedAt: { type: ['string', 'null'], format: 'date-time' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  Carrier: {
    type: 'object',
    description: 'A provider account an organization connected for tunnels.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      provider: { type: 'string', enum: ['cloudflare'] },
      name: { type: 'string', minLength: 1, maxLength: 64 },
      externalAccountId: { type: ['string', 'null'] },
      status: { type: 'string', enum: ['active', 'attention'] },
      createdAt: { type: 'string', format: 'date-time' },
      badges: { type: 'array', items: { $ref: '#/components/schemas/Badge' } },
    },
  },
  CarrierCreate: {
    type: 'object',
    required: ['provider', 'name', 'externalAccountId'],
    properties: {
      provider: { type: 'string', enum: ['cloudflare'] },
      name: { type: 'string', minLength: 1, maxLength: 64 },
      externalAccountId: { type: 'string', description: 'The provider’s own account id.' },
    },
  },
  CarrierConnect: {
    type: 'object',
    title: 'Connect Cloudflare Account',
    required: ['provider', 'label', 'token'],
    description:
      'Paste only the API Token. The panel lists the accounts it reaches and connects the only one, or the ones named in `accountIds`.',
    properties: {
      provider: { type: 'string', enum: ['cloudflare'] },
      label: { type: 'string', minLength: 1, maxLength: 64, title: 'Label' },
      token: {
        type: 'string',
        title: 'API Token',
        minLength: 8,
        maxLength: 512,
        writeOnly: true,
        description:
          'An API Token, not a Global API Key (that is refused). Stored sealed and never returned.',
      },
      accountIds: {
        type: 'array',
        title: 'Cloudflare Accounts',
        items: { type: 'string' },
        description: 'Required when the token reaches more than one account.',
      },
    },
  },
  BadgeCreate: {
    type: 'object',
    required: ['label', 'token'],
    properties: {
      label: { type: 'string', minLength: 1, maxLength: 64 },
      token: {
        type: 'string',
        minLength: 8,
        maxLength: 512,
        writeOnly: true,
        description: 'Checked with the provider, stored sealed and never returned.',
      },
    },
  },
  Tunnel: {
    type: 'object',
    description:
      'A Tunnel: a named path from the provider to connectors on your servers. The run token is never part of it.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      provider: { type: 'string', enum: ['cloudflare'] },
      carrierId: { type: 'string', format: 'uuid', nullable: true },
      placement: { type: 'string', enum: ['one', 'chosen', 'all'] },
      datacenterId: { type: 'string', format: 'uuid', nullable: true },
      status: { type: 'string', enum: ['pending', 'active', 'attention', 'removing'] },
      createdAt: { type: 'string', format: 'date-time' },
      portals: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            serverId: { type: 'string', format: 'uuid' },
            wanted: { type: 'string', enum: ['run', 'skip'] },
            reported: { type: 'string', enum: ['unknown', 'connected', 'down', 'error'] },
            lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
            lastError: { type: 'string', nullable: true },
            connectorVersion: { type: 'string', nullable: true },
          },
        },
      },
      carryingServerIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        description: 'Servers that run a connector now, from the placement rules.',
      },
      warnings: { type: 'array', items: { type: 'string' } },
      doorwayCount: { type: 'integer' },
    },
  },
  TunnelCreate: {
    type: 'object',
    title: 'Create Tunnel',
    required: ['carrierId', 'name', 'placement'],
    properties: {
      carrierId: { type: 'string', format: 'uuid', title: 'Cloudflare Account' },
      name: { type: 'string', minLength: 1, maxLength: 64, title: 'Name' },
      placement: {
        type: 'string',
        enum: ['one', 'chosen', 'all'],
        description:
          '`one` and `chosen` use `serverIds`. `all` covers every server of `datacenterId` (new servers join by themselves) except `exceptServerIds`.',
      },
      serverIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      exceptServerIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      datacenterId: { type: 'string', format: 'uuid' },
    },
  },
  TunnelPlacement: {
    type: 'object',
    required: ['placement'],
    properties: {
      placement: { type: 'string', enum: ['one', 'chosen', 'all'] },
      serverIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      exceptServerIds: { type: 'array', items: { type: 'string', format: 'uuid' } },
      datacenterId: { type: 'string', format: 'uuid' },
    },
  },
  TunnelHostname: {
    type: 'object',
    description: 'A hostname a Tunnel carries.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      tunnelId: { type: 'string', format: 'uuid' },
      hostname: { type: 'string' },
      hostingId: { type: 'string', format: 'uuid', nullable: true },
      isLocalOnly: {
        type: 'boolean',
        description:
          "True (the default) = only the Tunnel connector and the servers that carry the same Tunnel may reach this name on the server that runs the site; everyone else is dropped. False = the name is also public, so everyone is answered. The lock is applied when the site is deployed: a deploy to a server whose daemon is too old to enforce it is refused (409 `tunnel_daemon_too_old`), and a locked name that is pinned to a public Let's Encrypt certificate is refused (409 `tunnel_name_public_certificate`) only when the site also serves ordinary public names; a site whose names are all tunnel-only deploys on the internal certificate instead. A name added to a Tunnel before the site has it is locked on the site's first deploy. Changing the servers of a Tunnel changes who may reach the name; the lock follows at the next deploy of the site.",
      },
      status: { type: 'string', enum: ['pending', 'live', 'attention', 'removing'] },
      dns: { type: 'string', enum: ['created', 'none'] },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  TunnelHostnameCreate: {
    type: 'object',
    title: 'Add Hostname',
    required: ['hostname'],
    properties: {
      hostname: { type: 'string', title: 'Hostname' },
      isLocalOnly: { type: 'boolean', default: true },
    },
  },
  ServerTunnelCarrying: {
    type: 'object',
    required: ['carry'],
    properties: {
      carry: { type: 'boolean', description: 'False = this server never runs a Tunnel.' },
    },
  },
} as const

function errors(extra?: { badRequest?: boolean }) {
  return resourceErrorResponses({
    badRequest: extra?.badRequest,
    notFound: true,
  }) as Record<string, unknown>
}

function jsonOk(description: string, schema: Record<string, unknown>, status = '200') {
  return { [status]: { description, content: { 'application/json': { schema } } } }
}

const BADGE_WITH_CHECK = {
  type: 'object',
  properties: { badge: { $ref: '#/components/schemas/Badge' }, ...CHECK_PROPERTIES },
}

export const tunnelPaths: Record<string, unknown> = {
  '/api/client/v1/organizations/{id}/carriers': {
    get: {
      tags: ['Organizations'],
      summary: "List the organization's tunnel provider accounts",
      description:
        'Owners and managers only. Each account lists its tokens (label and last four characters).',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM],
      responses: {
        ...jsonOk('Accounts', {
          type: 'object',
          properties: {
            carriers: { type: 'array', items: { $ref: '#/components/schemas/Carrier' } },
          },
        }),
        ...errors(),
      },
    },
    post: {
      tags: ['Organizations'],
      summary: 'Connect a tunnel provider account',
      description:
        'Owners and managers only. At most 10 per organization. 409 `carrier_exists` or `carrier_limit`. Add a token next to make it usable.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/CarrierCreate' } } },
      },
      responses: {
        ...jsonOk(
          'Created',
          { type: 'object', properties: { carrier: { $ref: '#/components/schemas/Carrier' } } },
          '201'
        ),
        ...errors({ badRequest: true }),
      },
    },
  },
  '/api/client/v1/organizations/{id}/carriers/connect': {
    post: {
      tags: ['Organizations'],
      summary: 'Connect accounts with an API token',
      description:
        'Owners and managers only. Send only the API Token: it is checked with the provider, its accounts are listed, and each chosen account becomes a carrier (created if missing) with its own separately sealed copy of the token. 409 `account_choice_needed` (with `accounts`) when it reaches several and `accountIds` is missing; 400 `badge_invalid` for a Global API Key; 409 `badge_exists` for a token already added to that account.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/CarrierConnect' } },
        },
      },
      responses: {
        ...jsonOk(
          'Connected',
          {
            type: 'object',
            properties: {
              connected: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    carrier: { $ref: '#/components/schemas/Carrier' },
                    badge: { $ref: '#/components/schemas/Badge' },
                    ...CHECK_PROPERTIES,
                  },
                },
              },
            },
          },
          '201'
        ),
        ...errors({ badRequest: true }),
      },
    },
  },
  '/api/client/v1/organizations/{id}/carriers/{carrierId}': {
    delete: {
      tags: ['Organizations'],
      summary: 'Remove a tunnel provider account',
      description:
        'Owners and managers only. Removes its tokens too. 409 `carrier_in_use` while a tunnel still uses it.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, CARRIER_ID_PARAM],
      responses: {
        ...jsonOk('Removed', { type: 'object', properties: { ok: { type: 'boolean' } } }),
        ...errors(),
      },
    },
  },
  '/api/client/v1/organizations/{id}/carriers/{carrierId}/badges': {
    get: {
      tags: ['Organizations'],
      summary: 'List the tokens on a provider account',
      description: 'Owners and managers only. Label and last four characters, never the token.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, CARRIER_ID_PARAM],
      responses: {
        ...jsonOk('Tokens', {
          type: 'object',
          properties: { badges: { type: 'array', items: { $ref: '#/components/schemas/Badge' } } },
        }),
        ...errors(),
      },
    },
    post: {
      tags: ['Organizations'],
      summary: 'Add a token to a provider account',
      description:
        'Owners and managers only. At most 5 per account. The token is checked with the provider first: 400 `badge_rejected` (not accepted), `badge_wrong_account`, or `badge_not_useful` (names the missing permissions in `missing`); 502 `provider_unavailable`. It is then sealed and never returned.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, CARRIER_ID_PARAM],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/BadgeCreate' } } },
      },
      responses: { ...jsonOk('Created', BADGE_WITH_CHECK, '201'), ...errors({ badRequest: true }) },
    },
  },
  '/api/client/v1/organizations/{id}/carriers/{carrierId}/badges/{badgeId}': {
    delete: {
      tags: ['Organizations'],
      summary: 'Remove a token',
      description: 'Owners and managers only. The sealed token is deleted with it.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, CARRIER_ID_PARAM, BADGE_ID_PARAM],
      responses: {
        ...jsonOk('Removed', { type: 'object', properties: { ok: { type: 'boolean' } } }),
        ...errors(),
      },
    },
  },
  '/api/client/v1/organizations/{id}/carriers/{carrierId}/badges/{badgeId}/check': {
    post: {
      tags: ['Organizations'],
      summary: 'Check a token again',
      description:
        'Owners and managers only. Asks the provider again what the token reaches. A token the provider no longer accepts is kept and marked `attention`; `ok` says whether it is still useful. 502 `provider_unavailable` when the provider cannot be reached.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, CARRIER_ID_PARAM, BADGE_ID_PARAM],
      responses: {
        ...jsonOk('Checked', {
          type: 'object',
          properties: {
            badge: { $ref: '#/components/schemas/Badge' },
            ok: { type: 'boolean' },
            ...CHECK_PROPERTIES,
          },
        }),
        ...errors(),
      },
    },
  },
}

const TUNNEL_ID_PARAM = {
  name: 'tunnelId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const TUNNEL_ERRORS =
  'Refusals: 400 `tunnel_invalid`, `datacenter_required`, `datacenter_invalid`, `server_invalid`, `server_not_in_datacenter`; 409 `tunnel_exists`, `tunnel_limit`, `server_never_carries`, `badge_cannot_tunnel`, `tunnel_in_use`; 503 `secrets_unavailable`; 502 `provider_unavailable`; 400 `badge_rejected` when the provider does not accept the API Token.'

const DOORWAY_ERRORS =
  'Refusals: 400 `hostname_invalid`; 409 `hostname_in_use`, `doorway_limit`, `tunnel_not_ready`, `carrier_missing`, `badge_cannot_tunnel`, `badge_cannot_dns`, `zone_not_found`, `hosting_mismatch`; 400 `badge_rejected`; 503 `secrets_unavailable`; 502 `provider_unavailable`.'

Object.assign(tunnelPaths, {
  '/api/client/v1/organizations/{id}/tunnels': {
    get: {
      tags: ['Organizations'],
      summary: "List the organization's Tunnels",
      description: 'Owners and managers only.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM],
      responses: {
        ...jsonOk('Tunnels', {
          type: 'object',
          properties: {
            tunnels: { type: 'array', items: { $ref: '#/components/schemas/Tunnel' } },
          },
        }),
        ...errors(),
      },
    },
    post: {
      tags: ['Organizations'],
      summary: 'Create a Tunnel',
      description: `Owners and managers only. Creates the Tunnel at the provider and seals its run token. ${TUNNEL_ERRORS}`,
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/TunnelCreate' } } },
      },
      responses: {
        ...jsonOk(
          'Created',
          { type: 'object', properties: { tunnel: { $ref: '#/components/schemas/Tunnel' } } },
          '201'
        ),
        ...errors({ badRequest: true }),
      },
    },
  },
  '/api/client/v1/organizations/{id}/tunnels/{tunnelId}': {
    get: {
      tags: ['Organizations'],
      summary: 'Read a Tunnel',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, TUNNEL_ID_PARAM],
      responses: {
        ...jsonOk('Tunnel', {
          type: 'object',
          properties: { tunnel: { $ref: '#/components/schemas/Tunnel' } },
        }),
        ...errors(),
      },
    },
    delete: {
      tags: ['Organizations'],
      summary: 'Remove a Tunnel',
      description:
        'Owners and managers only. Refused with 409 `tunnel_in_use` while it carries hostnames. A Tunnel with no connector running is removed at the provider and here at once (`removing: false`). A Tunnel whose servers run a connector is marked `removing`: its servers are told to stop first, the provider only lets go of a Tunnel with no connected connector, and the removal is finished by the periodic sweep after growing waits (`removing: true`). While it waits, the Tunnel keeps status `removing` and a warning says why.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, TUNNEL_ID_PARAM],
      responses: {
        ...jsonOk('Removed, or marked removing', {
          type: 'object',
          properties: { ok: { type: 'boolean' }, removing: { type: 'boolean' } },
        }),
        ...errors(),
      },
    },
  },
  '/api/client/v1/organizations/{id}/tunnels/{tunnelId}/placement': {
    put: {
      tags: ['Organizations'],
      summary: 'Change where a Tunnel runs',
      description: `Owners and managers only. Replaces the servers the Tunnel runs on. Only an all-servers Tunnel picks up new servers by itself. ${TUNNEL_ERRORS}`,
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, TUNNEL_ID_PARAM],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/TunnelPlacement' } },
        },
      },
      responses: {
        ...jsonOk('Updated', {
          type: 'object',
          properties: { tunnel: { $ref: '#/components/schemas/Tunnel' } },
        }),
        ...errors({ badRequest: true }),
      },
    },
  },
  '/api/client/v1/organizations/{id}/tunnels/{tunnelId}/hostnames': {
    get: {
      tags: ['Organizations'],
      summary: 'List the hostnames a Tunnel carries',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, TUNNEL_ID_PARAM],
      responses: {
        ...jsonOk('Hostnames', {
          type: 'object',
          properties: {
            hostnames: { type: 'array', items: { $ref: '#/components/schemas/TunnelHostname' } },
          },
        }),
        ...errors(),
      },
    },
    post: {
      tags: ['Organizations'],
      summary: 'Add a hostname to a Tunnel',
      description: `Owners and managers only. Routes the name at the provider and creates its DNS name when a zone this API Token can edit holds it (otherwise dns is none and the DNS name is made by hand). ${DOORWAY_ERRORS}`,
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, TUNNEL_ID_PARAM],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/TunnelHostnameCreate' } },
        },
      },
      responses: {
        ...jsonOk(
          'Added',
          {
            type: 'object',
            properties: { hostname: { $ref: '#/components/schemas/TunnelHostname' } },
          },
          '201'
        ),
        ...errors({ badRequest: true }),
      },
    },
  },
  '/api/client/v1/organizations/{id}/tunnels/{tunnelId}/hostnames/{doorwayId}': {
    delete: {
      tags: ['Organizations'],
      summary: 'Remove a hostname from a Tunnel',
      description: `Owners and managers only. Removes its route, then its DNS name, then the row. A retry after a half-done removal works. ${DOORWAY_ERRORS}`,
      security: [{ cookieAuth: [] }],
      parameters: [
        ORG_ID_PARAM,
        TUNNEL_ID_PARAM,
        {
          name: 'doorwayId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        ...jsonOk('Removed', { type: 'object', properties: { ok: { type: 'boolean' } } }),
        ...errors(),
      },
    },
  },
  '/api/client/v1/organizations/{id}/servers/{serverId}/tunnel-carrying': {
    put: {
      tags: ['Organizations'],
      summary: 'Allow or forbid Tunnels on a server',
      description:
        'Owners and managers only. A server set to `carry: false` never runs a Tunnel, whatever a Tunnel placement says. 400 `carry_invalid`.',
      security: [{ cookieAuth: [] }],
      parameters: [
        ORG_ID_PARAM,
        {
          name: 'serverId',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ServerTunnelCarrying' } },
        },
      },
      responses: {
        ...jsonOk('Updated', {
          type: 'object',
          properties: { serverId: { type: 'string', format: 'uuid' }, carry: { type: 'boolean' } },
        }),
        ...errors({ badRequest: true }),
      },
    },
  },
})
