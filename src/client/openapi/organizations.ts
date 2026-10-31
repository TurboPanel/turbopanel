export const organizationSchemas = {
  OrganizationRecord: {
    type: 'object',
    required: ['id', 'name', 'createdAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: ['string', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  OrganizationsResponse: {
    type: 'object',
    required: ['organizations'],
    properties: {
      organizations: {
        type: 'array',
        items: { $ref: '#/components/schemas/OrganizationRecord' },
      },
    },
  },
  OrganizationResponse: {
    type: 'object',
    required: ['organization'],
    properties: {
      organization: { $ref: '#/components/schemas/OrganizationRecord' },
    },
  },
  OrganizationUpdate: {
    type: 'object',
    required: ['name'],
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
        description:
          'Non-empty name (any characters except control characters; ≤255). Cannot be cleared.',
      },
    },
  },
  OrganizationUpdateResponse: {
    type: 'object',
    required: ['ok', 'organization'],
    properties: {
      ok: { type: 'boolean', const: true },
      organization: { $ref: '#/components/schemas/OrganizationRecord' },
    },
  },
  OrganizationDefaultTimezone: {
    type: 'object',
    required: ['defaultServerTimezone', 'enforceServerTimezone'],
    properties: {
      defaultServerTimezone: {
        type: ['string', 'null'],
        description: 'Org-wide default IANA timezone for servers without an override.',
      },
      enforceServerTimezone: {
        type: 'boolean',
        description: 'When true, the org default wins over per-server options.timezone.',
      },
    },
  },
  OrganizationDefaultTimezoneUpdate: {
    type: 'object',
    properties: {
      defaultServerTimezone: {
        type: ['string', 'null'],
        description: 'IANA timezone from GET /timezones, or null to clear.',
      },
      enforceServerTimezone: { type: 'boolean' },
    },
  },
  OrganizationTemperatureUnit: {
    type: 'object',
    required: ['temperatureUnit'],
    properties: {
      temperatureUnit: {
        type: 'string',
        enum: ['celsius', 'fahrenheit'],
        description:
          'Display unit for temperature metrics (chart axes, tooltips, thresholds). Platform fallback is celsius.',
      },
    },
  },
  OrganizationTemperatureUnitUpdate: {
    type: 'object',
    required: ['temperatureUnit'],
    properties: {
      temperatureUnit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
    },
  },
  OrganizationTlsSettingsUpdate: {
    type: 'object',
    description: 'At least one key. A key left out keeps its stored value.',
    minProperties: 1,
    properties: {
      acmeEnabled: { type: 'boolean' },
      acmeContactEmail: {
        type: ['string', 'null'],
        maxLength: 254,
        description:
          "The one address that goes on this organization's Let's Encrypt orders. null or an empty string clears it.",
      },
    },
  },
  OrganizationTlsSettings: {
    type: 'object',
    required: ['acmeEnabled', 'acmeContactEmail'],
    properties: {
      acmeEnabled: { type: 'boolean' },
      acmeContactEmail: {
        type: ['string', 'null'],
        description: 'Certificate contact address; null when none is set.',
      },
    },
  },
  OrganizationDeployTimeoutUpdate: {
    type: 'object',
    required: ['deployTimeoutMinutes'],
    properties: {
      deployTimeoutMinutes: { type: 'integer', minimum: 5, maximum: 240 },
    },
  },
  OrganizationDeployTimeout: {
    type: 'object',
    required: ['deployTimeoutMinutes'],
    properties: {
      deployTimeoutMinutes: {
        type: 'integer',
        minimum: 5,
        maximum: 240,
        description:
          'The longest a deploy may run, in minutes, counted only while the server keeps reporting. Platform default is 30.',
      },
    },
  },
  OrganizationHostDefaults: {
    type: 'object',
    required: ['sshPort', 'ntp', 'hideWebServerNames', 'defaultFabricEnabled'],
    properties: {
      sshPort: {
        type: ['integer', 'null'],
        minimum: 1,
        maximum: 65535,
        description:
          'Org-wide SSH listen port. null = inherit platform default 22. Datacenter and server options override this.',
      },
      ntp: {
        type: ['object', 'null'],
        description:
          'Desired NTP client settings inherited by datacenters and servers. null = no org NTP default. Apply-to-host stays on POST /servers/{id}/ntp.',
        properties: {
          enabled: { type: 'boolean' },
          servers: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
          },
          fallbackServers: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
          },
        },
      },
      hideWebServerNames: {
        type: 'boolean',
        description:
          'Hide web server names and versions (Server, Via and X-Powered-By headers, error-page footers). On unless set to false. Servers that set their own value keep it; the rest follow this one. Applies to a site on its next deploy.',
      },
      defaultFabricEnabled: {
        type: 'boolean',
        description:
          'Preferred TurboFabric state for this organization. Does not enable or tear down the mesh — use PUT /organizations/{id}/fabric.',
      },
    },
  },
  OrganizationHostDefaultsUpdate: {
    type: 'object',
    properties: {
      sshPort: {
        type: ['integer', 'null'],
        minimum: 1,
        maximum: 65535,
        description: 'TCP port 1–65535, or null to clear the org default.',
      },
      ntp: {
        type: ['object', 'null'],
        description:
          'Replace the org NTP defaults object, or null to clear. At least one of enabled, servers, fallbackServers is required when an object is sent.',
        properties: {
          enabled: { type: 'boolean' },
          servers: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
          },
          fallbackServers: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
          },
        },
      },
      hideWebServerNames: {
        type: ['boolean', 'null'],
        description: 'Boolean, or null to clear (treated as on).',
      },
      defaultFabricEnabled: {
        type: ['boolean', 'null'],
        description: 'Boolean preference, or null to clear (treated as off).',
      },
    },
  },
  OrganizationDefaultEnvironment: {
    type: 'object',
    required: ['defaultEnvironmentName'],
    properties: {
      defaultEnvironmentName: {
        type: ['string', 'null'],
        description:
          'Org-wide primary environment name: the name of the primary environment every new project starts with. null/unset falls back to production. Existing projects keep their primary environment as it is.',
      },
    },
  },
  OrganizationDefaultEnvironmentUpdate: {
    type: 'object',
    required: ['defaultEnvironmentName'],
    properties: {
      defaultEnvironmentName: {
        type: ['string', 'null'],
        description:
          'Primary environment name, or null to reset to the platform default (production). It is a folder name on the servers, so it follows the environment name rule: at most 32 characters, lowercase letters, digits, hyphens and underscores, not a reserved word. **400** otherwise.',
      },
    },
  },
  OrganizationProjectSettings: {
    type: 'object',
    required: ['openEnvironmentSectionByDefault', 'openWorkspaceSectionByDefault'],
    properties: {
      openEnvironmentSectionByDefault: {
        type: 'boolean',
        description:
          'Whether the new-project form opens its Environment section (the primary environment name) without being asked. Unset is off.',
      },
      openWorkspaceSectionByDefault: {
        type: 'boolean',
        description:
          'Whether the new-project form opens its Workspace section without being asked. Unset is off.',
      },
    },
  },
  OrganizationProjectSettingsUpdate: {
    type: 'object',
    description: 'Send one switch or both; a switch left out keeps its stored value.',
    properties: {
      openEnvironmentSectionByDefault: { type: 'boolean' },
      openWorkspaceSectionByDefault: { type: 'boolean' },
    },
  },
  OrganizationServerCapacity: {
    type: 'object',
    required: ['maxServers', 'serverCount', 'reservedSeatCount', 'usedSeats', 'availableSeats'],
    properties: {
      maxServers: {
        type: ['integer', 'null'],
        minimum: 0,
        description:
          'Server limit for enrolled servers + unconsumed registration keys. null = unlimited.',
      },
      serverCount: {
        type: 'integer',
        minimum: 0,
        description: 'Servers currently enrolled in the organization.',
      },
      reservedSeatCount: {
        type: 'integer',
        minimum: 0,
        description: 'Active registration keys not yet latched to a server.',
      },
      usedSeats: {
        type: 'integer',
        minimum: 0,
        description: 'serverCount + reservedSeatCount.',
      },
      availableSeats: {
        type: ['integer', 'null'],
        minimum: 0,
        description: 'Remaining server slots, or null when unlimited.',
      },
    },
  },
  OrganizationServerCapacityUpdate: {
    type: 'object',
    required: ['maxServers'],
    properties: {
      maxServers: {
        type: ['integer', 'null'],
        minimum: 0,
        description: 'Non-negative integer server limit, or null for unlimited.',
      },
    },
  },
  ManagedSslMode: {
    type: 'string',
    enum: ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'],
    description:
      'Client TLS policy at the shared managed-SQL (ProxySQL) listener, ordered weakest to strongest. require/verify-ca/verify-full refuse a plaintext client session; verify-ca/verify-full additionally ask the driver to validate the server certificate against the organization CA. The listener-to-engine leg is always encrypted regardless of this value.',
  },
  OrganizationManagedDefaults: {
    type: 'object',
    required: ['sslMode', 'effectiveSslMode'],
    properties: {
      sslMode: {
        oneOf: [{ $ref: '#/components/schemas/ManagedSslMode' }, { type: 'null' }],
        description: 'Stored organization default, or null when none is configured.',
      },
      effectiveSslMode: {
        $ref: '#/components/schemas/ManagedSslMode',
        description:
          'What an inheriting managed service resolves to today: the org default, else the platform fallback (require).',
      },
    },
  },
  OrganizationManagedDefaultsUpdate: {
    type: 'object',
    required: ['sslMode'],
    properties: {
      sslMode: {
        oneOf: [{ $ref: '#/components/schemas/ManagedSslMode' }, { type: 'null' }],
        description:
          'One of the six modes, or null to clear the org default so inheriting services fall back to require. An unrecognized mode is rejected rather than downgraded.',
      },
    },
  },
  OrganizationDockerNetworking: {
    type: 'object',
    required: ['addressPools', 'defaultBridgeCidr'],
    properties: {
      addressPools: {
        type: 'array',
        maxItems: 16,
        description:
          "dockerd default-address-pools every enrolled host merges into /etc/docker/daemon.json: the ranges Docker carves unaddressed bridge networks out of. Empty = Docker's built-in pools. Bases also join the organization CIDR registry (collision authority) and the TurboFabric allocator exclusion list.",
        items: {
          type: 'object',
          required: ['base', 'size'],
          properties: {
            base: {
              type: 'string',
              description: 'Pool network CIDR, e.g. 10.200.0.0/16.',
            },
            size: {
              type: 'integer',
              description:
                'Prefix length of every network carved from base (>= the base prefix, <= 30 for IPv4).',
            },
          },
        },
      },
      defaultBridgeCidr: {
        type: ['string', 'null'],
        description:
          "dockerd bip — the default docker0 bridge's own address with prefix (172.17.0.1/16). null = Docker's built-in bridge.",
      },
    },
  },
  OrganizationDockerNetworkingUpdate: {
    type: 'object',
    description:
      'Replaces the whole stored object (null on a key clears it). addressPools entries must not overlap each other; every base is checked by the CIDR collision authority against the fabric, reserved ranges, site subnets and registered docker networks (409 with the usual cidr_overlaps_* / subnet_overlaps codes). Applying a change restarts dockerd on each host; networks and containers that already exist keep their addresses — pools only affect networks created afterwards.',
    properties: {
      addressPools: {
        type: ['array', 'null'],
        maxItems: 16,
        items: {
          type: 'object',
          required: ['base', 'size'],
          properties: {
            base: { type: 'string' },
            size: { type: 'integer' },
          },
        },
      },
      defaultBridgeCidr: { type: ['string', 'null'] },
    },
  },
  TimezonesResponse: {
    type: 'object',
    required: ['timezones'],
    properties: {
      timezones: {
        type: 'array',
        items: { type: 'string' },
        description: 'Sorted IANA timezone identifiers for pickers.',
      },
    },
  },
  OrganizationFabric: {
    type: 'object',
    required: ['enabled', 'relays'],
    properties: {
      enabled: {
        type: 'boolean',
        description:
          'Whether TurboFabric is carrying traffic for this organization. False when there is no fabric row (off) and while it is paused. Not required for single-engine Docker standalone.',
      },
      paused: {
        type: 'boolean',
        description:
          'True when TurboFabric was turned off and kept: every tunnel is down, but relays, keys and container networks stay so turning it back on is instant. `fabric` and `relays` are still returned.',
      },
      servers: {
        type: 'array',
        description:
          "Every org server's TurboFabric switch and role, whether or not the fabric exists.",
        items: { $ref: '#/components/schemas/OrganizationFabricServer' },
      },
      pairs: {
        type: 'array',
        description:
          'How each pair of org servers talks, listed once per pair. `lan`: they share a trusted datacenter network and both daemons route over it, so there is no tunnel (cross-server container networks ride the LAN, with or without TurboFabric). `fabric`: a TurboFabric tunnel carries it. `fabric_over_untrusted_lan`: the tunnel runs over a shared network marked untrusted, encrypted. `none`: no private path. `reason` is one plain sentence for the page.',
        items: {
          type: 'object',
          required: ['fromServerId', 'toServerId', 'path', 'reason'],
          properties: {
            fromServerId: { type: 'string', format: 'uuid' },
            toServerId: { type: 'string', format: 'uuid' },
            path: { type: 'string', enum: ['lan', 'fabric', 'fabric_over_untrusted_lan', 'none'] },
            reason: { type: 'string' },
          },
        },
      },
      fabric: {
        type: 'object',
        required: ['id', 'cidr', 'mtu', 'allowRelay', 'containerPool'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          cidr: { type: 'string' },
          mtu: { type: 'integer', minimum: 1280, maximum: 9000 },
          allowRelay: {
            type: 'boolean',
            description:
              'Org-level relay transport. Default false (opt-in / degraded). A relay may only tighten this; it cannot enable relay when the org has it off.',
          },
          containerPool: {
            type: 'string',
            description:
              'Effective IPv4 pool relay /16 prefixes are carved from (`fabric.options.containerPool`, default 10.192.0.0/12).',
          },
          status: { type: 'string' },
        },
      },
      relays: {
        type: 'array',
        items: { $ref: '#/components/schemas/OrganizationFabricRelay' },
      },
    },
  },
  OrganizationFabricServer: {
    type: 'object',
    required: ['serverId', 'name', 'enabled', 'member', 'role', 'roleSource', 'automaticRole'],
    properties: {
      serverId: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      enabled: {
        type: 'boolean',
        description:
          'The server switch (default true for new servers). False keeps it out of the mesh: no `tp0`, in no peer list, no fabric address.',
      },
      member: {
        type: 'boolean',
        description: 'Holds a relay (a `tp0` address) in the fabric right now.',
      },
      role: {
        type: 'string',
        enum: ['gateway', 'client'],
        description:
          'gateway accepts connections, client only dials out. Stored and shown; routing does not use it yet.',
      },
      roleSource: { type: 'string', enum: ['automatic', 'operator'] },
      automaticRole: {
        type: 'string',
        enum: ['gateway', 'client'],
        description:
          'What automatic picks today: gateway when the server has its own public address (an endpoint override does not count).',
      },
    },
  },
  OrganizationFabricRelay: {
    type: 'object',
    required: [
      'serverId',
      'address',
      'role',
      'advertisedCidrs',
      'resolvedAdvertisedCidrs',
      'keepalive',
      'endpointAddress',
      'resolvedEndpoint',
      'publicKey',
      'prefix',
      'hasPresharedKey',
      'segments',
      'observed',
      'allowRelay',
      'effectiveAllowRelay',
      'preferredGatewayIds',
      'gatewayEligible',
      'paths',
      'reconcile',
    ],
    properties: {
      serverId: { type: 'string', format: 'uuid' },
      address: { type: 'string' },
      role: { type: 'string', enum: ['gateway', 'member'] },
      advertisedCidrs: { type: 'array', items: { type: 'string' } },
      resolvedAdvertisedCidrs: {
        type: 'array',
        items: { type: 'string' },
        description:
          "The list the gateway will actually advertise — the operator override when advertisedCidrs is non-empty, otherwise the IPv4 subnets of the relay's datacenters (IPv6 subnets are excluded because host forwarding is IPv4-only).",
      },
      keepalive: { type: ['integer', 'null'] },
      endpointAddress: {
        type: ['string', 'null'],
        description: 'Operator pin only; null means auto-derive.',
      },
      resolvedEndpoint: {
        type: ['string', 'null'],
        description:
          'Globally-reachable endpoint only: the operator pin, else a public address, else null. Private datacenter addresses are never reported here because this response has no viewer context — read paths[] for source-aware (LAN / NAT / gateway) detail.',
      },
      publicKey: { type: ['string', 'null'] },
      prefix: { type: 'string' },
      hasPresharedKey: {
        type: 'boolean',
        description: 'Whether a sealed PSK is stored. The key itself is never returned.',
      },
      segments: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'subnet'],
          properties: {
            name: { type: 'string' },
            subnet: { type: 'string' },
            mtu: { type: 'integer' },
            gateway: { type: 'string' },
          },
        },
      },
      observed: {
        type: ['object', 'null'],
        properties: {
          lastHandshakeAt: { type: 'string', format: 'date-time' },
          transferRx: { type: 'integer', minimum: 0 },
          transferTx: { type: 'integer', minimum: 0 },
        },
      },
      allowRelay: {
        type: ['boolean', 'null'],
        description:
          'Relay-layer override. null inherits the org policy. A relay may only tighten org `allowRelay`.',
      },
      effectiveAllowRelay: {
        type: 'boolean',
        description: 'Resolved as org allowRelay AND (relay allowRelay ?? true).',
      },
      preferredGatewayIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        description: 'Preferred gateway server ids (order preserved, max 32).',
      },
      gatewayEligible: {
        type: 'boolean',
        description: "True when this relay's role is gateway.",
      },
      paths: {
        type: 'array',
        description:
          'Diagnostics-only per-peer path summary stamped after rendezvous. Never hashed into desired reconcile state.',
        items: {
          type: 'object',
          required: ['peerServerId', 'selected', 'degraded'],
          properties: {
            peerServerId: { type: 'string', format: 'uuid' },
            selected: {
              type: 'string',
              enum: [
                'direct_lan',
                'direct_public',
                'direct_nat',
                'gateway',
                'relay',
                'unreachable',
              ],
            },
            endpoint: { type: 'string' },
            viaServerId: { type: 'string', format: 'uuid' },
            lastHandshakeAt: { type: 'string', format: 'date-time' },
            latencyMs: { type: 'number' },
            degraded: { type: 'boolean' },
          },
        },
      },
      reconcile: {
        type: ['object', 'null'],
        description:
          "How the last server.fabric.reconcile sent to this server ended. `pending` until the server answers, then `done` (with any `warnings`: what an apply that worked left out, such as a route another interface holds or container networks that wait for Docker) or `failed` (with the server's own `error`). A pause only counts as down once its server is `done`. null before the first one is recorded.",
        required: ['commandId', 'action', 'state', 'at'],
        properties: {
          commandId: { type: 'string', format: 'uuid' },
          action: { type: 'string', enum: ['apply', 'pause', 'remove'] },
          state: { type: 'string', enum: ['pending', 'done', 'failed'] },
          at: { type: 'string', format: 'date-time' },
          error: { type: 'string' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  OrganizationFabricRelayUpdate: {
    type: 'object',
    properties: {
      role: { type: 'string', enum: ['gateway', 'member'] },
      advertisedCidrs: {
        type: 'array',
        items: { type: 'string' },
        description:
          "empty list = derive from the relay's datacenter IPv4 subnets. Each range must be private (RFC 1918, 100.64.0.0/10 or fc00::/7) and no shorter than /8 (IPv4) or /48 (IPv6): default routes and public ranges are 400. A range that overlaps the fabric range, the container pool, a server's fabric container range or a range another gateway advertises (the very same range on two gateways is fine; partly overlapping or nested ranges are not) is 400 gateway_range_overlaps_* with { message, cidr, conflictsWith, otherServerId? }. The daemon refuses a host's whole peer list over one such range, so the same rule also covers the ranges a gateway falls back to from its datacenter subnets when the list is empty.",
      },
      keepalive: { type: ['integer', 'null'], minimum: 1, maximum: 65535 },
      endpointAddress: {
        type: ['string', 'null'],
        description:
          'An IP address only, never with a port: other servers connect to it on the fabric listen port. null clears the pin.',
      },
      presharedKey: {
        type: ['string', 'null'],
        description: 'Write-only WireGuard PSK. Never echoed on GET.',
      },
      allowRelay: {
        type: ['boolean', 'null'],
        description: 'null inherits org policy. A relay may only tighten.',
      },
      preferredGatewayIds: {
        type: ['array', 'null'],
        items: { type: 'string', format: 'uuid' },
        description: 'null or [] clears. Must reference gateway-role relays in this fabric.',
      },
    },
  },
  OrganizationFabricApplyResult: {
    type: 'object',
    required: ['ok', 'fabricId', 'interfaceName', 'results'],
    properties: {
      ok: { type: 'boolean' },
      fabricId: { type: 'string', format: 'uuid' },
      interfaceName: { type: 'string', enum: ['tp0'] },
      results: {
        type: 'array',
        items: {
          type: 'object',
          required: ['serverId', 'status'],
          properties: {
            serverId: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['queued', 'failed', 'skipped'] },
            commandId: { type: 'string', format: 'uuid' },
            error: { type: 'string' },
            unreachablePeers: {
              type: 'array',
              items: {
                type: 'object',
                required: ['serverId'],
                properties: {
                  serverId: { type: 'string', format: 'uuid' },
                },
              },
            },
            gatewayRoutedPeers: {
              type: 'array',
              items: {
                type: 'object',
                required: ['serverId', 'viaServerId'],
                properties: {
                  serverId: { type: 'string', format: 'uuid' },
                  viaServerId: { type: 'string', format: 'uuid' },
                },
              },
            },
            natCandidates: { type: 'integer', minimum: 0 },
            degradedPeers: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
  },
  OrganizationFabricUpdate: {
    type: 'object',
    required: ['enabled'],
    properties: {
      enabled: {
        type: 'boolean',
        description: 'Enable or disable TurboFabric for the organization.',
      },
      allowRelay: {
        type: 'boolean',
        description:
          'Opt-in relay transport (default false, degraded). Relays may only tighten this policy.',
      },
      containerPool: {
        type: 'string',
        description:
          'Replacement IPv4 pool for relay /16 prefixes (prefix <= /16). Checked by the CIDR collision authority with the current pool excluded (409 cidr_overlaps_* / subnet_overlaps) refused with 409 fabric_container_pool_in_use when an allocated relay prefix would fall outside it, and refused with 400 gateway_range_overlaps_fabric_pool when it would swallow a range a gateway already advertises. Changing the pool does not renumber existing relay prefixes.',
      },
    },
  },
}

export const organizationPaths: Record<string, unknown> = {
  '/api/client/v1/organizations': {
    get: {
      tags: ['Authorization'],
      summary: 'List organizations visible to the signed-in user',
      description:
        'Returns organizations the user can access via team membership, grants, or platform admin role. The client selects the active organization and sends it on org-scoped requests via the X-Turbopanel-Organization-Id header.',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'Visible organizations',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrganizationsResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}': {
    get: {
      tags: ['Organizations'],
      summary: 'Get an organization',
      description:
        'Returns the organization when the signed-in user can access it (team membership, owner/manager grant, or platform admin). Missing or inaccessible organizations return 404.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Organization record',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrganizationResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found or inaccessible',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '503': {
          description: 'Database unavailable',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    patch: {
      tags: ['Organizations'],
      summary: 'Rename an organization',
      description:
        'Manage-gated. Updates organization.name (any characters except control characters; ≤255). Names are not unique. The name cannot be cleared.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/OrganizationUpdate' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated organization',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/OrganizationUpdateResponse',
              },
            },
          },
        },
        '400': {
          description: 'Invalid name or body',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/default-timezone': {
    get: {
      tags: ['Organizations'],
      summary: 'Get organization default server timezone',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Org timezone defaults',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/OrganizationDefaultTimezone',
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Organizations'],
      summary: 'Update organization default server timezone',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/OrganizationDefaultTimezoneUpdate',
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated org timezone defaults',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/OrganizationDefaultTimezone' },
                  {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean', const: true } },
                  },
                ],
              },
            },
          },
        },
        '400': {
          description: 'Invalid timezone or body',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/temperature-unit': {
    get: {
      tags: ['Organizations'],
      summary: 'Get organization temperature display unit',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Org temperature display unit',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/OrganizationTemperatureUnit',
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Organizations'],
      summary: 'Update organization temperature display unit',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/OrganizationTemperatureUnitUpdate',
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated org temperature display unit',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  {
                    $ref: '#/components/schemas/OrganizationTemperatureUnit',
                  },
                  {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean', const: true } },
                  },
                ],
              },
            },
          },
        },
        '400': {
          description: 'Invalid temperatureUnit or body',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/tls-settings': {
    get: {
      tags: ['Organizations'],
      summary: 'Get organization certificate settings',
      description:
        'Organization managers only, for the contact address too. The contact address is stored with the organization and is not yet read by certificate ordering.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: "Let's Encrypt gate and certificate contact address",
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrganizationTlsSettings' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Organizations'],
      summary: 'Update organization certificate settings',
      description:
        'Organization managers only. Changing the contact address is audited as organization.acme_contact.set (with the previous value); saving an unchanged address writes no audit row.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/OrganizationTlsSettingsUpdate' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated settings',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/OrganizationTlsSettings' },
                  {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean', const: true } },
                  },
                ],
              },
            },
          },
        },
        '400': {
          description: 'Invalid acmeEnabled, acmeContactEmail or body',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/deploy-timeout': {
    get: {
      tags: ['Organizations'],
      summary: 'Get organization deploy time limit',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Org deploy time limit',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/OrganizationDeployTimeout',
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Organizations'],
      summary: 'Update organization deploy time limit',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/OrganizationDeployTimeoutUpdate',
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated org deploy time limit',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  {
                    $ref: '#/components/schemas/OrganizationDeployTimeout',
                  },
                  {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean', const: true } },
                  },
                ],
              },
            },
          },
        },
        '400': {
          description: 'Invalid deployTimeoutMinutes or body',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/host-defaults': {
    get: {
      tags: ['Organizations'],
      summary: 'Get organization host defaults',
      description:
        'SSH port, desired NTP, and TurboFabric preference stored on organization.options. Most-specific datacenter/server overrides win on server reads.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Org host defaults',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrganizationHostDefaults' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Organizations'],
      summary: 'Update organization host defaults',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/OrganizationHostDefaultsUpdate',
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated org host defaults',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/OrganizationHostDefaults' },
                  {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean', const: true } },
                  },
                ],
              },
            },
          },
        },
        '400': {
          description: 'Invalid sshPort, ntp, hideWebServerNames, or body',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/default-environment': {
    get: {
      tags: ['Organizations'],
      summary: 'Get organization primary environment name',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Org primary environment name',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/OrganizationDefaultEnvironment',
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Organizations'],
      summary: 'Update organization primary environment name',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/OrganizationDefaultEnvironmentUpdate',
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated org primary environment name',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  {
                    $ref: '#/components/schemas/OrganizationDefaultEnvironment',
                  },
                  {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean', const: true } },
                  },
                ],
              },
            },
          },
        },
        '400': {
          description: 'Invalid defaultEnvironmentName or body',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/project-settings': {
    get: {
      tags: ['Organizations'],
      summary: 'Get organization project settings',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Org project settings',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/OrganizationProjectSettings',
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Organizations'],
      summary: 'Update organization project settings',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/OrganizationProjectSettingsUpdate',
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated org project settings',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  {
                    $ref: '#/components/schemas/OrganizationProjectSettings',
                  },
                  {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean', const: true } },
                  },
                ],
              },
            },
          },
        },
        '400': {
          description: 'Invalid switch value, no switch sent, or body',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/server-capacity': {
    get: {
      tags: ['Organizations'],
      summary: 'Get organization server limit',
      description:
        'Returns the configured maxServers cap (null = unlimited) and current usage. Enrolled servers and unconsumed registration keys both count toward the limit.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Server limit',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/OrganizationServerCapacity',
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Organizations'],
      summary: 'Update organization server limit',
      description:
        'Owner-only. Sets organization.options.maxServers for self-hosted control-plane quotas. Pass null for unlimited. Does not remove existing servers when lowered below current usage — only blocks new registration keys.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/OrganizationServerCapacityUpdate',
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated capacity snapshot',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  { $ref: '#/components/schemas/OrganizationServerCapacity' },
                  {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean', const: true } },
                  },
                ],
              },
            },
          },
        },
        '400': {
          description: 'Invalid maxServers',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/managed-defaults': {
    get: {
      tags: ['Organizations'],
      summary: 'Get organization managed-database defaults',
      description:
        'Manage-gated. Returns the org-wide managed-database inheritance sources — today the default client TLS mode — plus what an inheriting service resolves to. These are defaults only: a managed service that configured its own mode keeps it.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Managed-database defaults',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/OrganizationManagedDefaults',
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Organizations'],
      summary: 'Update organization managed-database defaults',
      description:
        'Manage-gated. Sets organization.options.managedDatabase.sslMode. Only moves managed services that never set their own mode; a service-level override always wins. Pass null to clear the default so inheriting services fall back to the platform require.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/OrganizationManagedDefaultsUpdate',
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated managed-database defaults',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  {
                    $ref: '#/components/schemas/OrganizationManagedDefaults',
                  },
                  {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean', const: true } },
                  },
                ],
              },
            },
          },
        },
        '409': {
          description:
            '`managed_ssl_default_external_access_minimum`: an sslMode weaker than require while a database that follows the default is served by a server that allows external access; `databases` names them. Nothing is saved.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ManagedSslMinimumRefusal' },
            },
          },
        },
        '400': {
          description: 'Invalid sslMode or body',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/principal-defaults': {
    get: {
      tags: ['Organizations'],
      summary: 'Get organization principal defaults',
      description:
        'Manage-gated. Returns the organization default name scheme for the system name of new principals (Linux users and managed database users): plain, partial (platform default) or random, and whether the scheme is locked for everyone creating principals. The legacy randomized-usernames booleans are still returned (true = partial or random, false = plain).',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Principal defaults',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: [
                  'nameScheme',
                  'effectiveNameScheme',
                  'schemeLocked',
                  'randomizedUsernames',
                  'effectiveRandomizedUsernames',
                ],
                properties: {
                  nameScheme: {
                    type: 'string',
                    enum: ['plain', 'partial', 'random'],
                    nullable: true,
                  },
                  effectiveNameScheme: { type: 'string', enum: ['plain', 'partial', 'random'] },
                  schemeLocked: { type: 'boolean' },
                  randomizedUsernames: { type: 'boolean', nullable: true },
                  effectiveRandomizedUsernames: { type: 'boolean' },
                },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Organizations'],
      summary: 'Update organization principal defaults',
      description:
        'Manage-gated (owner or manager). Sets organization.options.principalNameScheme (null clears to the platform default, partial) and/or principalNameSchemeLocked. When locked, creating a principal with a different nameScheme fails with 409 principal_scheme_locked; the lock applies only at creation. The legacy randomizedUsernames boolean is still accepted (true = partial, false = plain, null = default). Only affects principals created afterwards - existing system names are never renamed.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                nameScheme: {
                  type: 'string',
                  enum: ['plain', 'partial', 'random'],
                  nullable: true,
                },
                schemeLocked: { type: 'boolean' },
                randomizedUsernames: { type: 'boolean', nullable: true },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated principal defaults',
        },
        '400': {
          description: 'Invalid request',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/directory-defaults': {
    get: {
      tags: ['Organizations'],
      summary: 'Get organization folder naming',
      description:
        'Manage-gated. Returns how service and volume folders are named under a site owner: slug (a readable name, the default), uuid (the asset id) or both (a choice per asset, default slug). locked is true once the setting was locked by hand or any folder exists for the organization; lockedByFolders says which.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Folder naming',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['names', 'effectiveNames', 'locked', 'lockedByFolders'],
                properties: {
                  names: {
                    type: 'string',
                    enum: ['slug', 'uuid', 'both'],
                    nullable: true,
                  },
                  effectiveNames: { type: 'string', enum: ['slug', 'uuid', 'both'] },
                  locked: { type: 'boolean' },
                  lockedByFolders: { type: 'boolean' },
                },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Organizations'],
      summary: 'Update organization folder naming',
      description:
        'Manage-gated. Sets organization.options.directoryNames (null clears it to the default, slug) and/or directoryNamesLocked. Changing the value, or clearing the lock, fails with 409 directory_names_locked once any folder exists for the organization, or while the lock is set by hand. Existing folders are never renamed.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                names: {
                  type: 'string',
                  enum: ['slug', 'uuid', 'both'],
                  nullable: true,
                },
                locked: { type: 'boolean' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Updated folder naming' },
        '400': {
          description: 'Invalid request',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '409': { description: 'directory_names_locked' },
      },
    },
  },
  '/api/client/v1/organizations/{id}/docker-networking': {
    get: {
      tags: ['Organizations'],
      summary: 'Get organization Docker host addressing',
      description:
        "Manage-gated. Returns the org-wide dockerd default-address-pools and bip every enrolled host merges into /etc/docker/daemon.json. Empty pools / null bip mean Docker's built-in defaults apply.",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Docker host addressing',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/OrganizationDockerNetworking',
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Organizations'],
      summary: 'Replace organization Docker host addressing',
      description:
        'Manage-gated. Replaces organization.options.docker wholesale (null on a key clears it; a body that clears everything removes the stored key). Every addressPools base runs the CIDR collision authority — 409 cidr_overlaps_fabric / cidr_overlaps_fabric_pool / cidr_overlaps_reserved / cidr_overlaps_docker_network / subnet_overlaps with { cidr, conflictingCidr, networkId?, datacenterId? }. Hosts pick the change up on their next daemon session and restart dockerd; existing networks and containers keep their current addresses.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/OrganizationDockerNetworkingUpdate',
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated Docker host addressing',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  {
                    $ref: '#/components/schemas/OrganizationDockerNetworking',
                  },
                  {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean', const: true } },
                  },
                ],
              },
            },
          },
        },
        '400': {
          description: 'Invalid pool, size, overlapping pools, or bip',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '409': {
          description: 'A pool base overlaps a registered range',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/timezones': {
    get: {
      tags: ['Organizations'],
      summary: 'List allowed IANA timezones',
      description:
        'Sorted timezone identifiers for pickers (Intl.supportedValuesOf with static fallback).',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'Timezone list',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TimezonesResponse' },
            },
          },
        },
        '401': {
          description: 'Unauthorized',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/fabric': {
    get: {
      tags: ['Organizations'],
      summary: 'Get TurboFabric opt-in status',
      description:
        'Manage-gated. Returns whether TurboFabric is enabled for the organization. Default is off: capable single-engine Docker standalone, no `tp0`. Enabling creates the org `fabric` row and reconciles host interface `tp0` on enrolled servers. User-facing copy is TurboFabric; backend identifiers stay `fabric` / `tp0`.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'TurboFabric status',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrganizationFabric' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Organization not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Organizations'],
      summary: 'Enable or disable TurboFabric',
      description:
        "Manage-gated. `{ enabled: true }` creates the org fabric (if missing) and change-driven `server.fabric.reconcile` on enrolled servers. `{ enabled: false }` pauses: every server takes `tp0` down and keeps its key, routed bridges and forwarding rules (`server.fabric.reconcile` `{ enabled: false, retainKeys: true }`), and the fabric row, relays and container networks are kept, so `{ enabled: true }` turns it back on instantly. A pause is refused with 409 `fabric_pause_needs_daemon_update` (with `message` and `serverIds`) while any member's daemon does not list `fabric-retain-keys-v1`. DELETE removes TurboFabric completely. Does not auto-enable on install, enroll, or first deploy. Returns 409 `fabric_cidr_unavailable` / `fabric_address_pool_exhausted` when the default host CIDR cannot be allocated. Optional `allowRelay` and `containerPool` update `fabric.options`; `containerPool` (IPv4, prefix <= /16 so a relay /16 fits) runs the CIDR collision authority with the current pool excluded (409 `cidr_overlaps_*` / `subnet_overlaps`) and is refused with 409 `fabric_container_pool_in_use` when an allocated relay prefix would fall outside it. Changing the pool does **not** renumber existing relay prefixes — only future allocations are carved from the new pool. The policy is written before any relay is allocated, in one transaction with the fabric row: a first-time enable carves every relay prefix from the requested pool, and a pool too small for the org's servers (409 `fabric_prefix_pool_exhausted`) or one the auto-picked host range lands in (409 `cidr_overlaps_fabric`) leaves TurboFabric disabled.",
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/OrganizationFabricUpdate' },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated TurboFabric status',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrganizationFabric' },
            },
          },
        },
        '400': {
          description: 'Invalid request',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '409': {
          description: 'CIDR or address pool unavailable',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '503': {
          description:
            '`fabric_teardown_not_queued` (with `message` and `serverIds`): `enabled: false` could not queue the pause for every server; the servers listed did not get it. TurboFabric stays on; servers that were reached drop their tunnel (keeping their key) and are re-applied by the next reconcile. Retry.',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
    delete: {
      tags: ['Organizations'],
      summary: 'Remove TurboFabric completely',
      description:
        "Manage-gated. Tears TurboFabric down on every member (`server.fabric.reconcile` `{ enabled: false }`: `tp0`, routed bridges, `TP-FORWARD`, keys, state), then deletes the fabric row and its relays and reclaims the `network(kind='compose')` / `subnet` rows of networks that need a tunnel. A container network whose servers all share a trusted datacenter network (each pair a trusted LAN pair) is kept, and those servers are sent the payload with no tunnel again (`tunnel: false`, LAN routes), since the teardown removed their LAN routes. Works whether TurboFabric is on or paused; a never-enabled org is a no-op. Servers switched out of the mesh are torn down too (they kept their key). 503 `fabric_teardown_not_queued` (with `message` and `serverIds`) keeps the fabric row, relays and container networks when a teardown could not be queued; servers that were already reached have dropped their tunnel and key and get a new key on the next apply. Returns the cleared settings.",
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Removed',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrganizationFabric' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '503': {
          description:
            'A teardown could not be queued; the fabric row, relays and container networks stay, but servers already reached have dropped their tunnel and key',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/fabric/relays/{serverId}': {
    patch: {
      tags: ['Organizations'],
      summary: 'Update a TurboFabric relay',
      description:
        'Manage-gated. Patches role, advertised CIDRs, keepalive, endpoint pin, and write-only `presharedKey`. Promoting to gateway returns 422 `gateway_datacenter_required` / `gateway_datacenter_cidr_required` when the server is not ready. Then change-driven membership reconcile. PSK is never echoed.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
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
          'application/json': {
            schema: {
              $ref: '#/components/schemas/OrganizationFabricRelayUpdate',
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Updated relay',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'relay'],
                properties: {
                  ok: { type: 'boolean' },
                  relay: {
                    $ref: '#/components/schemas/OrganizationFabricRelay',
                  },
                },
              },
            },
          },
        },
        '400': {
          description: 'Invalid request',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '409': {
          description: 'TurboFabric is off',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '422': {
          description:
            '`gateway_datacenter_required` / `gateway_datacenter_cidr_required` / `preferred_gateway_invalid`',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/fabric/servers/{serverId}': {
    patch: {
      tags: ['Organizations'],
      summary: "Set one server's TurboFabric switch and role",
      description:
        "Manage-gated. `{ enabled?, role? }`; `role` is `gateway`, `client` or null (automatic: gateway when the server has its own public address; an endpoint override does not count). `enabled: false` takes the server's `tp0` down (keeping its key when its daemon can) and re-plans the mesh so no peer lists it, no ladder hands out its fabric address and its WireGuard port closes; its relay row stays, so its address, endpoint pin, preshared key and LAN sharing come back when it is switched on. Refused with 409 `fabric_server_in_use` (plain `message`, `dependents[]`) while a cross-server container network that reaches it through a tunnel (one whose other servers all share a trusted LAN with it does not count), a managed database replicating over TurboFabric, an app-to-database connection that resolves to its fabric address, or a datacenter LAN only it shares depends on it, and 503 `fabric_teardown_not_queued` when its teardown could not be queued. `enabled: true` lets it join on the next reconcile (immediately when TurboFabric is on). Returns `{ ok, server }`.",
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
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
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean' },
                role: { type: 'string', enum: ['gateway', 'client'], nullable: true },
              },
            },
          },
        },
      },
      responses: {
        '200': {
          description: 'Saved',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok'],
                properties: {
                  ok: { type: 'boolean' },
                  server: { $ref: '#/components/schemas/OrganizationFabricServer' },
                },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'No such server in this organization',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '409': {
          description: 'Something reaches this server over TurboFabric',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/fabric/apply': {
    post: {
      tags: ['Organizations'],
      summary: 'Apply TurboFabric membership',
      description:
        'Manage-gated. Force-reconciles `server.fabric.reconcile` on every org relay whose server is switched on. Returns per-server `results[]` (`queued` / `failed` / `skipped`, optional `unreachablePeers` / `gatewayRoutedPeers` / `natCandidates` / `degradedPeers`). 409 when TurboFabric is off, and 409 `fabric_paused` (with a plain `message`) while it is paused.',
      security: [{ cookieAuth: [] }],
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        '200': {
          description: 'Apply enqueued',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/OrganizationFabricApplyResult',
              },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '409': {
          description: 'TurboFabric is off',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/folders': {
    get: {
      tags: ['Organizations'],
      summary: 'Folders on servers that need a person',
      description:
        "Manage-gated. Lists the organization's folder rows that a person can act on or is waiting for: orphan (on a server with no service or volume that owns it), removing (asked to go, the host has not confirmed) and missing (the host no longer has it). Filter with state (comma separated), page with limit (1 to 100, default 50) and offset. reason is plain words, including what the host said the last time it kept a removing folder. action says what POST /folders/{id}/remove would do: remove (an orphan), retry (ask again now) or forget (a missing row); null for a folder in use.",
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        {
          name: 'state',
          in: 'query',
          required: false,
          schema: { type: 'string', example: 'orphan,removing' },
        },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
        { name: 'offset', in: 'query', required: false, schema: { type: 'integer' } },
      ],
      responses: {
        '200': {
          description: 'Folders that need attention',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'folders', 'total'],
                properties: {
                  ok: { type: 'boolean' },
                  total: { type: 'integer' },
                  folders: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id', 'kind', 'state', 'scope', 'slug', 'serverId', 'owner'],
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        kind: { type: 'string', enum: ['service', 'volume'] },
                        state: { type: 'string', enum: ['orphan', 'removing', 'missing'] },
                        scope: { type: 'string' },
                        slug: { type: 'string' },
                        owner: { type: 'string' },
                        serverId: { type: 'string', format: 'uuid' },
                        serverName: { type: 'string', nullable: true },
                        assetId: { type: 'string', format: 'uuid', nullable: true },
                        assetName: { type: 'string', nullable: true },
                        hasAsset: { type: 'boolean' },
                        reason: { type: 'string', nullable: true },
                        action: {
                          type: 'string',
                          enum: ['remove', 'retry', 'forget'],
                          nullable: true,
                        },
                        updatedAt: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '400': {
          description: 'Invalid state, limit or offset',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '403': {
          description: 'Forbidden',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/folders/{id}/remove': {
    post: {
      tags: ['Organizations'],
      summary: 'Remove, retry or forget a folder',
      description:
        'Manage-gated. An orphan folder is moved to removing and its server is asked to delete it (permanent; asks for step-up re-authentication when the organization requires it); a folder already removing is asked again now; a missing row is forgotten, since the host has no folder. A folder a service or volume is using (planned or present), or an orphan a service or volume row still names, is refused with 409 folder_in_use: delete that service or volume instead. Recorded in the audit trail as folder.remove.',
      security: [{ cookieAuth: [] }],
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: {
        '200': {
          description: 'Done',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'outcome'],
                properties: {
                  ok: { type: 'boolean' },
                  outcome: { type: 'string', enum: ['removing', 'forgotten'] },
                },
              },
            },
          },
        },
        '403': {
          description: 'Forbidden, or step-up re-authentication is required (reauth_required)',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '404': {
          description: 'Folder not found',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
        '409': {
          description: 'folder_in_use: a service or volume is using the folder',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ErrorResponse' },
            },
          },
        },
      },
    },
  },
}
