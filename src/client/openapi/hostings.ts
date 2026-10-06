import { buildResourceCrudPaths, clientErrorJson } from './shared.ts'

const nullableString = { type: ['string', 'null'] }

export const hostingSchemas = {
  HostingDnsReport: {
    type: 'object',
    required: ['ready', 'checkedAt', 'hostnames', 'expectedAddresses'],
    description:
      'Live DNS check of the names the certificate must cover. `ready` is true when every name resolves to the server (or to anything, when the server address is unknown).',
    properties: {
      ready: { type: 'boolean' },
      checkedAt: { type: 'string', format: 'date-time' },
      hostnames: {
        type: 'array',
        items: {
          type: 'object',
          required: ['hostname', 'resolves', 'addresses'],
          properties: {
            hostname: { type: 'string' },
            resolves: { type: 'boolean' },
            addresses: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      expectedAddresses: { type: 'array', items: { type: 'string' } },
    },
  },
  HostingCertificate: {
    type: 'object',
    description:
      "What the hosting shows about its certificate, decided by the server. Derived from the pinned certificate, its Let's Encrypt issuance details and any request waiting for DNS; `tls.status` is never changed to say any of this.",
    required: [
      'state',
      'source',
      'expiresAt',
      'expiresInDays',
      'renewsAutomatically',
      'lastError',
      'lastIssuedAt',
      'uploadedExpiryWarning',
      'dns',
      'letsEncryptAvailable',
      'www',
      'needsDeploy',
    ],
    properties: {
      state: {
        type: 'string',
        enum: [
          'test_certificate',
          'uploaded',
          'secure',
          'waiting_for_dns',
          'issuing',
          'renewal_failed',
        ],
      },
      source: { type: 'string', enum: ['test', 'uploaded', 'lets_encrypt'] },
      expiresAt: { ...nullableString, format: 'date-time' },
      expiresInDays: { type: ['integer', 'null'] },
      renewsAutomatically: { type: 'boolean' },
      lastError: {
        ...nullableString,
        description: "Why the last issuance or renewal failed, as Let's Encrypt reported it.",
      },
      lastIssuedAt: { ...nullableString, format: 'date-time' },
      uploadedExpiryWarning: { type: 'string', enum: ['none', '14d', '3d', '1d', 'expired'] },
      dns: {
        oneOf: [{ $ref: '#/components/schemas/HostingDnsReport' }, { type: 'null' }],
        description: 'The last DNS check, while a request is waiting for DNS.',
      },
      letsEncryptAvailable: {
        type: 'boolean',
        description:
          "True when the one-click action can run: the organization allows Let's Encrypt, the hosting is an HTTP route on a public bind with public hostnames, and compose does not own it.",
      },
      www: {
        type: 'string',
        enum: ['off', 'both', 'www-to-root', 'root-to-www'],
        description:
          "The hosting's www setting (`options.www`, `off` when unset). When not `off`, Let's Encrypt covers both spellings of each name.",
      },
      needsDeploy: {
        type: 'boolean',
        description: 'The certificate is pinned but the environment has not been deployed since.',
      },
    },
  },
  UseLetsEncryptRequest: {
    type: 'object',
    description:
      "No fields. The names the certificate covers follow the hosting's own www setting (`options.www`); change that with PATCH /hostings/{id}.",
    properties: {},
  },
  UseLetsEncryptResponse: {
    type: 'object',
    required: ['hosting', 'certificate', 'needsDeploy'],
    properties: {
      hosting: { $ref: '#/components/schemas/HostingRow' },
      certificate: {
        oneOf: [{ $ref: '#/components/schemas/HostingCertificate' }, { type: 'null' }],
      },
      needsDeploy: {
        type: 'boolean',
        description:
          'True when a certificate was pinned: deploy the environment to start issuance.',
      },
    },
  },
  HostingDnsCheckResponse: {
    type: 'object',
    required: ['dns'],
    properties: { dns: { $ref: '#/components/schemas/HostingDnsReport' } },
  },
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
        description: 'PHP hints for a host-served site. Applied on every engine.',
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
      www: {
        type: 'string',
        enum: ['off', 'both', 'www-to-root', 'root-to-www'],
        description:
          "What happens to the other spelling of each hostname (`www.` added, or removed when the name starts with `www.`). `off` (default): only the hostname as written. `both`: the site answers on both names, no redirect. `www-to-root`: the site answers on the bare name and `www.<name>` redirects there permanently (path and query kept; plain HTTP goes straight to HTTPS in one hop). `root-to-www`: the site answers on `www.<name>` and the bare name redirects there. The direction is about the names, not which one was typed. Every extra name needs DNS pointing at the server and a certificate: Let's Encrypt covers it automatically; an uploaded certificate must list it or the deploy is refused with `tls_pin_mismatch`. http hostings only; the other spelling must not already be a hostname in the environment, and every path of one name must agree.",
      },
      web: {
        $ref: '#/components/schemas/HostingWebOptions',
        description: 'Site / host-native stack options (env + optional Apache PHP hints)',
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
            description: 'True when compose took over a panel-authored row serving the same route',
          },
        },
      },
      options: {
        oneOf: [{ $ref: '#/components/schemas/HostingOptions' }, { type: 'null' }],
      },
      certificate: {
        oneOf: [{ $ref: '#/components/schemas/HostingCertificate' }, { type: 'null' }],
        description: 'Derived certificate state; present on GET responses.',
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

const hostingJson = (schema: string) => ({
  'application/json': { schema: { $ref: `#/components/schemas/${schema}` } },
})

const letsEncryptRefusals =
  "`lets_encrypt_not_enabled` (403): the organization has not allowed Let's Encrypt. 400: `hosting_not_http`, `hosting_has_no_hostnames`, `acme_requires_public_bind`, `letsencrypt_hostname_unsupported` (wildcard, IP address or private name) or `www_redirect_conflict` (the hosting's www setting is not `off`, but the other spelling of a domain is already a domain in the environment; the body carries a plain-words `message`). A name the www setting adds is checked for DNS like the typed names: when it does not point at the server yet, the request waits and `dns` names it."

const letsEncryptPaths = {
  [`${hostingIdPath}/use-letsencrypt`]: {
    put: {
      tags: ['Hostings'],
      summary: "Use Let's Encrypt for this hosting",
      description:
        "Checks that every name points at the server, then pins an automatically renewed Let's Encrypt certificate (`certificate.state` `issuing`, `needsDeploy` true: deploy the environment to start issuance). While DNS is not ready nothing is pinned and the request waits (`waiting_for_dns`); a periodic job retries it for a week. Calling it again repeats the check and changes nothing twice. " +
        letsEncryptRefusals,
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      requestBody: { required: false, content: hostingJson('UseLetsEncryptRequest') },
      responses: {
        '200': { description: 'Request recorded', content: hostingJson('UseLetsEncryptResponse') },
        '400': {
          description: letsEncryptRefusals,
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '403': {
          description: 'lets_encrypt_not_enabled',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '404': {
          description: 'Hosting not found',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        ...composeOwnedConflictResponse,
      },
    },
  },
  [`${hostingIdPath}/dns-check`]: {
    get: {
      tags: ['Hostings'],
      summary: "Check DNS for this hosting's Let's Encrypt names",
      description:
        'Read-only. Looks up every name the certificate would cover (including the www spelling when the redirect is on) and reports whether it points at the server.',
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': { description: 'DNS report', content: hostingJson('HostingDnsCheckResponse') },
        '400': {
          description: letsEncryptRefusals,
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '404': {
          description: 'Hosting not found',
          content: { 'application/json': { schema: clientErrorJson } },
        },
      },
    },
  },
}

export const hostingPaths = {
  ...basePaths,
  ...letsEncryptPaths,
  [hostingIdPath]: {
    ...(basePaths[hostingIdPath] as Record<string, unknown>),
    patch: {
      ...((basePaths[hostingIdPath] as Record<string, unknown>).patch as Record<string, unknown>),
      responses: {
        ...(((basePaths[hostingIdPath] as Record<string, unknown>).patch as Record<string, unknown>)
          .responses as Record<string, unknown>),
        ...composeOwnedConflictResponse,
      },
    },
    delete: {
      ...((basePaths[hostingIdPath] as Record<string, unknown>).delete as Record<string, unknown>),
      responses: {
        ...((
          (basePaths[hostingIdPath] as Record<string, unknown>).delete as Record<string, unknown>
        ).responses as Record<string, unknown>),
        ...composeOwnedConflictResponse,
      },
    },
  },
}
