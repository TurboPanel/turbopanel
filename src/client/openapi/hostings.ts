import { buildResourceCrudPaths, clientErrorJson } from './shared.ts'

export const hostingSchemas = {
  HostingPortMapping: {
    type: 'object',
    required: ['published', 'target'],
    properties: {
      published: {
        type: 'integer',
        minimum: 1,
        maximum: 65535,
        description: 'Host/entrypoint port exposed by Traefik',
      },
      target: {
        type: 'integer',
        minimum: 1,
        maximum: 65535,
        description: 'Container port the compose service listens on',
      },
    },
  },
  HostingPhpOptions: {
    type: 'object',
    properties: {
      version: {
        type: 'string',
        description:
          'PHP series for this site (e.g. "8.4"). php-fpm on nginx and Apache, LSAPI on OpenLiteSpeed.',
        pattern: String.raw`^\d+\.\d+$`,
      },
      memoryLimit: {
        type: 'string',
        description: 'Apache php_admin_value memory_limit (e.g. "256M")',
        pattern: String.raw`^\d+[KkMmGg]?$`,
      },
      maxExecutionTime: {
        type: 'integer',
        minimum: 1,
        description: 'Apache php_admin_value max_execution_time in seconds',
      },
    },
  },
  HostingWebOptions: {
    type: 'object',
    properties: {
      env: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description:
          'Static env for host-native web stacks (SetEnv / similar). Hosting-scoped forRuntime variables merge at deploy; these entries win on key collision. Keys: letter or underscore, then word chars; max 64 entries; values trimmed and capped at 4096 chars.',
      },
      php: {
        $ref: '#/components/schemas/HostingPhpOptions',
        description:
          'PHP hints for a host-served site. Applied on every engine.',
      },
    },
  },
  HostingOptions: {
    type: 'object',
    description:
      'Hosting options accepted on create/update and used at deploy. HTTP fields apply when protocol is http (default); tcp/udp use ports and ignore hostnames/pathPrefix/targetPort/proxy/web.',
    properties: {
      hostnames: {
        type: 'array',
        items: { type: 'string' },
        description: 'HTTP ingress hostnames (ignored for tcp/udp)',
      },
      pathPrefix: {
        type: 'string',
        description: 'HTTP path prefix (ignored for tcp/udp)',
      },
      targetPort: {
        type: 'number',
        description: 'HTTP container target port (ignored for tcp/udp)',
      },
      bind: {
        type: 'string',
        enum: ['public', 'datacenter', 'local'],
        description:
          'Ingress bind scope; default public. With ipId, pins the listen address for http and tcp/udp alike.',
      },
      protocol: {
        type: 'string',
        enum: ['http', 'tcp', 'udp'],
        description:
          'http (default) routes hostnames via Traefik + hosting Caddy. tcp/udp publish raw ports through Traefik with no hostname/TLS routing.',
      },
      ports: {
        type: 'array',
        maxItems: 10,
        items: { $ref: '#/components/schemas/HostingPortMapping' },
        description:
          'Required non-empty when protocol is tcp or udp. Invalid or duplicate published ports are dropped on parse; deploy rejects an empty list for tcp/udp.',
      },
      web: {
        $ref: '#/components/schemas/HostingWebOptions',
        description:
          'Site / host-native stack options (env + optional Apache PHP hints)',
      },
      proxy: {
        type: 'object',
        description: 'HTTP proxy toggles (ignored for tcp/udp)',
        properties: {
          forceHttps: { type: 'boolean' },
          gzip: { type: 'boolean' },
          brotli: { type: 'boolean' },
          stripPrefix: { type: 'string' },
        },
      },
    },
  },
  HostingRow: {
    type: 'object',
    required: ['id', 'serviceId', 'createdAt', 'updatedAt'],
    properties: {
      id: { type: 'string' },
      name: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      serviceId: { type: 'string' },
      tlsId: {
        type: ['string', 'null'],
        description: 'Pinned org TLS certificate id; null = basic self-signed (Caddy tls internal)',
      },
      ipId: {
        type: ['string', 'null'],
        format: 'uuid',
        description: 'Pinned org IP address id for ingress binding',
      },
      metadata: {
        type: 'object',
        nullable: true,
        description:
          'Operator metadata. `composeOwned: true` marks a row materialized from services.<name>.x-turbopanel.hosting; such rows are read-only through this API (PATCH/DELETE return 409 hosting_owned_by_compose) and are re-asserted from the compose document on every deploy. `composeServiceName`, `composeRoute`, and `composeTlsMode` record which declaration produced the row. `composeAdopted: true` marks a row that existed in the panel first and was taken over because a declaration named the same route; when the declaration goes away such a row is released back to the panel instead of deleted.',
        properties: {
          composeOwned: {
            type: 'boolean',
            description: 'True when the row is declared by a compose document',
          },
          composeServiceName: {
            type: 'string',
            description: 'Compose service the route was declared on',
          },
          composeRoute: {
            type: 'string',
            description: 'The "<hostname> <pathPrefix>" identity the row is keyed on',
          },
          composeTlsMode: {
            type: 'string',
            enum: ['internal', 'certificate'],
            description:
              'Authored x-turbopanel.hosting[i].tls.mode. Only internal and certificate can reach a row: "automatic" has no deploy-payload spelling and is refused at save time and again at deploy-prepare (422 hosting_tls_mode_unsupported).',
          },
          composeAdopted: {
            type: 'boolean',
            description:
              'True when compose took over a panel-authored row serving the same route',
          },
        },
      },
      options: {
        oneOf: [
          { $ref: '#/components/schemas/HostingOptions' },
          { type: 'null' },
        ],
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  HostingsResponse: {
    type: 'object',
    required: ['hostings'],
    properties: {
      hostings: {
        type: 'array',
        items: { $ref: '#/components/schemas/HostingRow' },
      },
    },
  },
  CreateHostingRequest: {
    type: 'object',
    required: ['serviceId'],
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      serviceId: { type: 'string' },
      tlsId: { type: ['string', 'null'], format: 'uuid' },
      ipId: { type: ['string', 'null'], format: 'uuid' },
      metadata: { type: 'object' },
      options: { $ref: '#/components/schemas/HostingOptions' },
    },
  },
  UpdateHostingRequest: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      tlsId: { type: ['string', 'null'], format: 'uuid' },
      ipId: { type: ['string', 'null'], format: 'uuid' },
      metadata: { type: 'object' },
      options: { $ref: '#/components/schemas/HostingOptions' },
    },
  },
}

const basePaths = buildResourceCrudPaths({
  plural: 'hostings',
  singular: 'hosting',
  tag: 'Hostings',
  listSchema: 'HostingsResponse',
  rowSchema: 'HostingRow',
  createSchema: 'CreateHostingRequest',
  patchSchema: 'UpdateHostingRequest',
  parentQuery: {
    name: 'serviceId',
    description: 'Filter hostings linked to a service',
  },
})

const hostingIdPath = '/api/client/v1/hostings/{id}'

/**
 * Not a permission failure — the caller may hold `organization:manage`. The row
 * is declared by a compose document, so a write here would be overwritten by
 * the next deploy; the body names the compose service to edit instead.
 */
const composeOwnedConflictResponse = {
  '409': {
    description: 'hosting_owned_by_compose',
    content: { 'application/json': { schema: clientErrorJson } },
  },
}

export const hostingPaths = {
  ...basePaths,
  [hostingIdPath]: {
    ...(basePaths[hostingIdPath] as Record<string, unknown>),
    patch: {
      ...((basePaths[hostingIdPath] as Record<string, unknown>).patch as Record<
        string,
        unknown
      >),
      responses: {
        ...(((basePaths[hostingIdPath] as Record<string, unknown>)
          .patch as Record<string, unknown>).responses as Record<string, unknown>),
        ...composeOwnedConflictResponse,
      },
    },
    delete: {
      ...((basePaths[hostingIdPath] as Record<string, unknown>).delete as Record<
        string,
        unknown
      >),
      responses: {
        ...(((basePaths[hostingIdPath] as Record<string, unknown>)
          .delete as Record<string, unknown>).responses as Record<string, unknown>),
        ...composeOwnedConflictResponse,
      },
    },
  },
}
