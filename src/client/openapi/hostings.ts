import { buildResourceCrudPaths } from './shared.ts'

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
          'Preferred mod_php package version (e.g. "8.4"); applied on Apache traditional-web deploy',
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
          'PHP hints for Apache traditional-web deploy (ignored for nginx/OpenLiteSpeed static)',
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
          'Traditional-web / host-native stack options (env + optional Apache PHP hints)',
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
      displayName: { type: ['string', 'null'] },
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
      metadata: { type: 'object', nullable: true },
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
      displayName: { type: 'string' },
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
      displayName: { type: 'string' },
      description: { type: 'string' },
      tlsId: { type: ['string', 'null'], format: 'uuid' },
      ipId: { type: ['string', 'null'], format: 'uuid' },
      metadata: { type: 'object' },
      options: { $ref: '#/components/schemas/HostingOptions' },
    },
  },
}

export const hostingPaths = buildResourceCrudPaths({
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
