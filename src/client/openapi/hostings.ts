import { buildResourceCrudPaths, clientErrorJson } from './shared.ts'

const nullableString = { type: ['string', 'null'] }

export const hostingSchemas = {
  HostingDnsReport: {
    type: 'object',
    required: ['ready', 'checkedAt', 'hostnames', 'expectedAddresses'],
    description:
      "Live pre-check of the names the certificate must cover. `ready` is true when, for every name, every A and AAAA answer is a serving server's public address (any public answer when none is on record), port 80 answers from the internet and CAA allows Let's Encrypt.",
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
            resolves: {
              type: 'boolean',
              description: "Has an address, and every address is a serving server's.",
            },
            addresses: { type: 'array', items: { type: 'string' } },
            wrongAddresses: {
              type: 'array',
              items: { type: 'string' },
              description: "Answers that are not a serving server's address.",
            },
            port80: {
              type: 'string',
              enum: ['open', 'closed'],
              description:
                'Port 80 from the panel: `open` when anything accepts a connection there (any listener counts; no check file is fetched), `closed` only for a clear refusal. Absent when not checked or when the panel cannot tell (a timeout, no route from its own network), which never blocks.',
            },
            caa: {
              type: 'string',
              enum: ['allowed', 'blocked'],
              description: "Whether CAA lets Let's Encrypt issue; absent when unknown.",
            },
            problem: { type: 'string', description: 'What stops this name, in plain words.' },
            warning: {
              type: 'string',
              description:
                'Worth fixing but not blocking: a wrong answer beside a right one of the same address family.',
            },
          },
        },
      },
      expectedAddresses: { type: 'array', items: { type: 'string' } },
      nextCheckAt: {
        type: 'string',
        format: 'date-time',
        description: 'When a waiting request is checked again; the wait grows after each miss.',
      },
      checks: { type: 'integer', description: 'Checks this waiting request has had.' },
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
        description:
          'The certificate is pinned but no deploy has picked it up: none has finished since and none queued since is running.',
      },
      serverProgress: {
        type: ['string', 'null'],
        enum: ['waiting_for_deploy', 'working', 'not_reported', null],
        description:
          'While `issuing`: no deploy has carried the certificate yet, the server has it (or the deploy just finished), or the deploy finished a while ago and no server has reported on it. Null otherwise.',
      },
      lastTriedAt: {
        ...nullableString,
        format: 'date-time',
        description:
          'The last DNS check while waiting for DNS, or when a server last reported a failure.',
      },
      nextTryAt: {
        ...nullableString,
        format: 'date-time',
        description:
          'When the panel checks a waiting request again. Null when failing: the server retries on its own, waiting longer each time.',
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
          'True when a certificate was pinned but could not be sent to the servers at once (a server offline, a deploy already running, nothing deployed yet): deploy the environment to start issuance. False when it was sent, or nothing was pinned.',
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
        description:
          'HTTP ingress hostnames (ignored for tcp/udp). A name the control panel itself serves (the instance hostnames) is refused with `409 hostname_is_panel_hostname` on create and update (and `409 hosting_hostname_is_panel_hostname` at deploy); wildcard names are not refused. Another hosting already using a name is `409 hostname_in_use`.',
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
          "What happens to the other spelling of each hostname (`www.` added, or removed when the name starts with `www.`). `off` (default): only the hostname as written. `both`: the site answers on both names, no redirect. `www-to-root`: the site answers on the bare name and `www.<name>` redirects there permanently (path and query kept; plain HTTP goes straight to HTTPS in one hop). `root-to-www`: the site answers on `www.<name>` and the bare name redirects there. The direction is about the names, not which one was typed. Every extra name needs DNS pointing at the server and a certificate: Let's Encrypt covers it automatically; an uploaded certificate must list it or the deploy is refused with `tls_pin_mismatch`. http hostings only; IP addresses and one-word names (`localhost`) have no www spelling. Every name the choice adds counts as one of the organization's hostnames, so it may not be a name another hosting uses (`409 hostname_in_use`), and every path of one name must make the same choice. Turning it on for a hosting pinned to Let's Encrypt queues the same DNS check the button runs.",
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
            enum: ['automatic', 'internal', 'certificate'],
            description:
              'Authored x-turbopanel.hosting[i].tls.mode. "automatic" pins the organization\'s managed Let\'s Encrypt row for the name (created when missing) and needs the organization setting "Allow Let\'s Encrypt certificates"; otherwise the deploy is refused (400 acme_requires_org_opt_in).',
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
      tunnels: {
        type: 'array',
        items: { $ref: '#/components/schemas/HostingTunnelPath' },
        description:
          'The names of this hosting a tunnel carries, one entry per name; empty when none. Present on GET responses; absent from older panels.',
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  HostingTunnelPath: {
    type: 'object',
    description:
      'One hostname visitors reach through a tunnel: the tunnel ends TLS at its edge with a trusted certificate, then reaches the site on its server over HTTPS.',
    required: [
      'hostname',
      'tunnelId',
      'tunnelName',
      'provider',
      'tunnelOnly',
      'originVerified',
      'status',
    ],
    properties: {
      hostname: { type: 'string' },
      tunnelId: { type: 'string', format: 'uuid' },
      tunnelName: { type: 'string' },
      provider: { type: 'string', description: 'The tunnel provider, for example `cloudflare`.' },
      tunnelOnly: {
        type: 'boolean',
        description:
          'True: only the tunnel reaches this name (the server answers it for the tunnel and its peer servers only). False: the name is also served directly.',
      },
      originVerified: {
        type: 'boolean',
        description:
          "True: the tunnel checks the server's certificate (the verified connection is in effect). False: the tunnel accepts the server's own certificate without checking it, on purpose.",
      },
      status: { type: 'string', enum: ['pending', 'live', 'attention'] },
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
        "Checks that every name points at the server, then pins an automatically renewed Let's Encrypt certificate (`certificate.state` `issuing`) and sends it to the servers at once: only the web server config changes, nothing is built or restarted. When that cannot be queued (a server offline, a deploy already running, nothing deployed yet) `needsDeploy` is true: deploy the environment to start issuance. While DNS is not ready nothing is pinned and the request waits (`waiting_for_dns`); a periodic job retries it for a week. Calling it again repeats the check and changes nothing twice. " +
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
        '409': {
          description:
            "hosting_owned_by_compose, except when compose asks for tls.mode automatic: then the request re-pins the managed Let's Encrypt row compose chose (Try again).",
          content: { 'application/json': { schema: clientErrorJson } },
        },
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

const composeReleasePaths = {
  [`${hostingIdPath}/release-from-compose`]: {
    post: {
      tags: ['Hostings'],
      summary: 'Manage a compose-made hosting in the panel instead',
      description:
        "Removes the compose markers from the hosting, so it is edited in the panel again and keeps its id, names, certificate and variables. The caller then removes the route from the environment's compose file; if that write fails, the next deploy adopts the row again instead of deleting it. A hosting compose does not own is left alone (`released: false`).",
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Released, or already managed in the panel',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'released'],
                properties: {
                  ok: { type: 'boolean', enum: [true] },
                  released: { type: 'boolean' },
                },
              },
            },
          },
        },
        '401': {
          description: 'Not signed in',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '403': {
          description: 'No manage grant, or a system-owned hosting',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '404': {
          description: 'Hosting not found',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '409': {
          description:
            'environment_deploy_running: a deploy of this environment is running; try again when it has finished',
          content: { 'application/json': { schema: clientErrorJson } },
        },
        '503': {
          description: 'Database unavailable',
          content: { 'application/json': { schema: clientErrorJson } },
        },
      },
    },
  },
}

export const hostingPaths = {
  ...basePaths,
  ...letsEncryptPaths,
  ...composeReleasePaths,
  [hostingIdPath]: {
    ...(basePaths[hostingIdPath] as Record<string, unknown>),
    patch: {
      ...((basePaths[hostingIdPath] as Record<string, unknown>).patch as Record<string, unknown>),
      description:
        "Pointing `tlsId` at a managed Let's Encrypt certificate, with nothing else the servers receive changed, sends it to the servers at once when the environment is deployed (the same hostings-only apply as use-letsencrypt); the answer then carries `needsDeploy`, true when a deploy is still needed to start it.",
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
