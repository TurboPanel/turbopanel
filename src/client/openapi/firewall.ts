import { resourceErrorResponses } from './shared.ts'

/**
 * OpenAPI for the organization firewall (`client/organizations/firewall-routes.ts`):
 * its policy, the rules operators typed, and each server's mode. Owners and
 * managers only. Nothing here pushes a ruleset to a host.
 */

const ORG_ID_PARAM = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const RULE_ID_PARAM = {
  name: 'edictId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const SERVER_ID_PARAM = {
  name: 'serverId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const RULE_FIELDS = {
  label: { type: 'string', pattern: '^[A-Za-z0-9 ._:/-]{1,48}$' },
  scope: {
    type: 'string',
    enum: ['host', 'published'],
    description: "`host` is the host's own listeners; `published` is a port Docker publishes.",
  },
  action: { type: 'string', enum: ['accept', 'drop', 'reject'] },
  proto: { type: 'string', enum: ['tcp', 'udp', 'any'] },
  ports: {
    type: ['string', 'null'],
    description:
      'One port or an inclusive ascending range such as `5432-5440`; null is every port, which only a block may say.',
  },
  sourceKind: { type: 'string', enum: ['any', 'servers', 'datacenter', 'fabric', 'addresses'] },
  sourceAddresses: {
    type: 'array',
    items: { type: 'string' },
    minItems: 1,
    maxItems: 256,
    description:
      'IP addresses or CIDRs; required for `sourceKind` `addresses` and refused for every other kind.',
  },
  isEnabled: { type: 'boolean' },
  serverId: {
    type: ['string', 'null'],
    format: 'uuid',
    description: 'One server of the organization, or null for every server.',
  },
} as const

export const firewallSchemas = {
  FirewallPolicy: {
    type: 'object',
    properties: {
      inputDefault: { type: 'string', enum: ['accept', 'drop'] },
      ipv6: { type: 'string', enum: ['mirror', 'skip'] },
      sshSources: {
        type: 'array',
        items: { type: 'string' },
        description: '`any`, or CIDRs SSH is open to.',
      },
    },
  },
  FirewallPolicyUpdate: {
    type: 'object',
    description: 'Only the fields present change; at least one is required.',
    properties: {
      inputDefault: { type: 'string', enum: ['accept', 'drop'] },
      ipv6: { type: 'string', enum: ['mirror', 'skip'] },
      sshSources: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 256 },
      acknowledgeSshExcludesMe: {
        type: 'boolean',
        description:
          "Set to true to save an `sshSources` list that does not include the caller's own address. Without it that save is refused with 409 `firewall_ssh_excludes_you`.",
      },
    },
  },
  FirewallRule: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      ...RULE_FIELDS,
      createdBy: { type: ['string', 'null'], format: 'uuid' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  FirewallRuleCreate: {
    type: 'object',
    required: ['label', 'scope', 'action', 'proto', 'sourceKind'],
    properties: RULE_FIELDS,
  },
  FirewallRuleUpdate: {
    type: 'object',
    description: 'Only the fields present change; the merged rule must still be valid.',
    properties: RULE_FIELDS,
  },
  FirewallServerState: {
    type: 'object',
    description:
      'A server that has never been configured reports `observe`, generation 0 and state `idle`.',
    properties: {
      serverId: { type: 'string', format: 'uuid' },
      mode: { type: 'string', enum: ['observe', 'managed', 'off'] },
      generation: { type: 'integer', minimum: 0 },
      lastDigest: { type: ['string', 'null'] },
      lastResult: {},
      state: { type: 'string', enum: ['idle', 'pending', 'confirmed', 'rolled_back'] },
      deadlineAt: { type: ['string', 'null'], format: 'date-time' },
      lastAppliedAt: { type: ['string', 'null'], format: 'date-time' },
      confirmedAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  FirewallPreview: {
    type: ['object', 'null'],
    description:
      "What the host was last sent. `kind` is `preview` (rendered and checked by the kernel with `iptables-restore --test`, never loaded) for every server, except a server the operator names in `TURBOPANEL_FIREWALL_APPLY_SERVERS` whose mode is `managed`: it is sent an `apply` (loaded under the host's commit-confirm guard, rolled back at the deadline unless confirmed on the host), and a `remove` (TurboPanel's chains taken out) once either key is gone. Null until something was sent. `status` is `queued` (sent, no answer yet), `previewed`, `applied` (loaded, pending confirmation), `removed`, `refused` (the kernel or the host refused it) or `failed`. `notes` lists, in words, what could not be derived. `host` is the host's own answer (warnings, validation, rendered text).",
    properties: {
      kind: { type: 'string', enum: ['preview', 'apply', 'remove'] },
      status: {
        type: 'string',
        enum: ['queued', 'previewed', 'applied', 'removed', 'refused', 'failed'],
      },
      desiredDigest: { type: 'string' },
      generation: { type: 'integer', minimum: 0 },
      sentAt: { type: 'string', format: 'date-time' },
      ruleCount: { type: 'integer', minimum: 0 },
      notes: { type: 'array', items: { type: 'string' } },
      host: {},
    },
  },
  FirewallProbe: {
    type: ['object', 'null'],
    description:
      "The last OUTSIDE reachability check: the control plane dialled the server's own stored addresses at its SSH port, its own port when it hosts the control plane, and the public tcp ports the derived ruleset opens, and recorded what answered. Null until one ran. `state` per port is `open` (handshake completed), `refused`, `timeout`, `blocked` (this platform would not dial it) or `error`. `role` says whether a port gates a confirmation (`invariant`, `public`) or is only reported (`informational`). Nothing is read from or written to a connection.",
    properties: {
      at: { type: 'string', format: 'date-time' },
      phase: { type: 'string', enum: ['manual', 'baseline', 'after'] },
      status: { type: 'string', enum: ['running', 'done'] },
      ports: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            port: { type: 'integer', minimum: 1, maximum: 65535 },
            role: { type: 'string', enum: ['invariant', 'public', 'informational'] },
            reason: { type: 'string' },
            state: { type: 'string', enum: ['open', 'refused', 'timeout', 'blocked', 'error'] },
            ms: { type: ['integer', 'null'] },
          },
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
    },
  },
  FirewallModeUpdate: {
    type: 'object',
    required: ['mode'],
    properties: { mode: { type: 'string', enum: ['observe', 'managed', 'off'] } },
  },
}

function jsonBody(schema: string) {
  return {
    required: true,
    content: { 'application/json': { schema: { $ref: `#/components/schemas/${schema}` } } },
  }
}

function jsonOk(description: string, schema: Record<string, unknown>, status = '200') {
  return { [status]: { description, content: { 'application/json': { schema } } } }
}

function errors(extra?: { badRequest?: boolean; conflict?: boolean }) {
  const responses = resourceErrorResponses({
    badRequest: extra?.badRequest,
    notFound: true,
  }) as Record<string, unknown>
  if (extra?.conflict) {
    responses['409'] = {
      description: 'Rule limit reached (`firewall_rule_limit`)',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
    }
  }
  return responses
}

export const firewallPaths: Record<string, unknown> = {
  '/api/client/v1/organizations/{id}/firewall': {
    get: {
      tags: ['Organizations'],
      summary: "Get the organization's firewall policy",
      description:
        'Owners and managers only. Defaults: input accept, IPv6 mirror, SSH open to anyone.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM],
      responses: {
        ...jsonOk('Firewall policy', {
          type: 'object',
          properties: { policy: { $ref: '#/components/schemas/FirewallPolicy' } },
        }),
        ...errors(),
      },
    },
    put: {
      tags: ['Organizations'],
      summary: "Change the organization's firewall policy",
      description:
        'Owners and managers only. Stored in the organization options; nothing is sent to a host.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM],
      requestBody: jsonBody('FirewallPolicyUpdate'),
      responses: {
        ...jsonOk('Updated policy', {
          type: 'object',
          properties: { policy: { $ref: '#/components/schemas/FirewallPolicy' } },
        }),
        ...errors({ badRequest: true }),
        409: {
          description:
            "Refused: the new `sshSources` list does not include the caller's own address (`firewall_ssh_excludes_you`). Resend with `acknowledgeSshExcludesMe: true` to save anyway.",
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/firewall/rules': {
    get: {
      tags: ['Organizations'],
      summary: 'List the firewall rules operators typed',
      description:
        'Owners and managers only. Rules derived from what is deployed are not stored and not listed.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM],
      responses: {
        ...jsonOk('Rules, oldest first', {
          type: 'object',
          properties: {
            rules: { type: 'array', items: { $ref: '#/components/schemas/FirewallRule' } },
          },
        }),
        ...errors(),
      },
    },
    post: {
      tags: ['Organizations'],
      summary: 'Add a firewall rule',
      description: 'Owners and managers only. At most 200 rules per organization.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM],
      requestBody: jsonBody('FirewallRuleCreate'),
      responses: {
        ...jsonOk(
          'Created',
          {
            type: 'object',
            properties: { rule: { $ref: '#/components/schemas/FirewallRule' } },
          },
          '201'
        ),
        ...errors({ badRequest: true, conflict: true }),
      },
    },
  },
  '/api/client/v1/organizations/{id}/firewall/rules/{edictId}': {
    patch: {
      tags: ['Organizations'],
      summary: 'Change a firewall rule',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, RULE_ID_PARAM],
      requestBody: jsonBody('FirewallRuleUpdate'),
      responses: {
        ...jsonOk('Updated rule', {
          type: 'object',
          properties: { rule: { $ref: '#/components/schemas/FirewallRule' } },
        }),
        ...errors({ badRequest: true }),
      },
    },
    delete: {
      tags: ['Organizations'],
      summary: 'Delete a firewall rule',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, RULE_ID_PARAM],
      responses: {
        ...jsonOk('Deleted', { type: 'object', properties: { ok: { type: 'boolean' } } }),
        ...errors(),
      },
    },
  },
  '/api/client/v1/organizations/{id}/firewall/servers/{serverId}': {
    get: {
      tags: ['Organizations'],
      summary: "Get a server's firewall state",
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, SERVER_ID_PARAM],
      responses: {
        ...jsonOk('Server firewall state', {
          type: 'object',
          properties: {
            bulwark: { $ref: '#/components/schemas/FirewallServerState' },
            preview: { $ref: '#/components/schemas/FirewallPreview' },
            probe: { $ref: '#/components/schemas/FirewallProbe' },
          },
        }),
        ...errors(),
      },
    },
    put: {
      tags: ['Organizations'],
      summary: "Set a server's firewall mode",
      description:
        'Owners and managers only. `observe` (the default) shows the ruleset and applies nothing; `managed` is accepted and stored but behaves as `observe` until enforcement is switched on server-side; `off` leaves the firewall alone and sends nothing. Raises the server generation.',
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, SERVER_ID_PARAM],
      requestBody: jsonBody('FirewallModeUpdate'),
      responses: {
        ...jsonOk('Updated state', {
          type: 'object',
          properties: { bulwark: { $ref: '#/components/schemas/FirewallServerState' } },
        }),
        ...errors({ badRequest: true }),
      },
    },
  },
  '/api/client/v1/organizations/{id}/firewall/servers/{serverId}/probe': {
    post: {
      tags: ['Organizations'],
      summary: 'Check a server from outside now',
      description:
        "Owners and managers only. Dials only the server's own stored addresses, only at its SSH port, the control plane's own port on its host, and the public tcp ports the derived ruleset opens; never an address the control plane may not dial (loopback, link-local, metadata, multicast ...), and private networks only from a self-hosted control plane. It changes no firewall and sends no command. At most once every 30 seconds per server (429 with `Retry-After`). 503 when this control plane has no outside vantage. `autoConfirmPossible` says whether a change that keeps these ports open could be confirmed automatically (an invariant port answered).",
      security: [{ cookieAuth: [] }],
      parameters: [ORG_ID_PARAM, SERVER_ID_PARAM],
      responses: {
        ...jsonOk('What answered', {
          type: 'object',
          properties: {
            probe: { $ref: '#/components/schemas/FirewallProbe' },
            autoConfirmPossible: { type: 'boolean' },
          },
        }),
        ...errors(),
        '429': { description: 'Checked less than 30 seconds ago' },
        '503': { description: 'This control plane cannot run the outside check' },
      },
    },
  },
}
