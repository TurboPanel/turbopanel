const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: { error: { type: 'string' } },
} as const

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: errorSchema } },
})

const notConfigured = errorResponse(
  'Billing is not configured on this instance (`billing_not_configured`); self-hosted has no billing surface.'
)
const unauthorized = errorResponse('Unauthorized')
const forbidden = errorResponse('Forbidden (owner-only)')

export const billingSchemas = {
  BillingTier: {
    type: 'object',
    required: ['id', 'label', 'rank', 'priceCents', 'currency', 'isCustom', 'entitlements'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      label: { type: 'string', description: '`S1`…`S7`, `SX`.' },
      rank: { type: 'integer' },
      priceCents: {
        type: ['integer', 'null'],
        description:
          "Cached from the provider product's default price; null for negotiated (custom) offerings.",
      },
      currency: {
        type: ['string', 'null'],
        description: 'Lower-case ISO code beside `priceCents`.',
      },
      isCustom: { type: 'boolean' },
      entitlements: {
        description:
          'What the ladder entitles for this label; null only for a row whose label left the ladder.',
        oneOf: [
          {
            type: 'object',
            required: [
              'maxCores',
              'maxMemoryBytes',
              'nicSlots',
              'driveSlots',
              'gpuSlots',
              'filesystemSlots',
            ],
            properties: {
              maxCores: { type: 'integer' },
              maxMemoryBytes: { type: 'integer' },
              nicSlots: { type: 'integer' },
              driveSlots: { type: 'integer' },
              gpuSlots: { type: 'integer' },
              filesystemSlots: { type: 'integer' },
            },
          },
          { type: 'null' },
        ],
      },
    },
  },
  BillingCatalogResponse: {
    type: 'object',
    required: ['tiers', 'sizeCommand'],
    properties: {
      tiers: { type: 'array', items: { $ref: '#/components/schemas/BillingTier' } },
      sizeCommand: {
        type: 'string',
        description:
          'One-line POSIX shell command to show on Add Server: run on the server, it prints its physical cores, RAM and the tier they land in, e.g. `8 cores, 31.3 GiB RAM -> S2` — measured the way placement measures them.',
      },
    },
  },
  BillingTierSummary: {
    type: 'object',
    required: [
      'tierId',
      'label',
      'rank',
      'purchased',
      'inUse',
      'ending',
      'endsAt',
      'available',
      'releasing',
      'priceCents',
      'currency',
    ],
    properties: {
      tierId: { type: 'string', format: 'uuid' },
      label: { type: 'string' },
      rank: { type: 'integer' },
      purchased: {
        type: 'integer',
        description: 'Committed provider quantity at this tier — the licenses bought here.',
      },
      inUse: { type: 'integer', description: 'Servers currently assigned this tier.' },
      ending: {
        type: 'integer',
        description:
          'Of `purchased`, the licenses that end at the period boundary (released seats). Restore them with `POST /billing/restore`; buying more at this tier is refused (`licenses_ending`) while this is non-zero.',
      },
      endsAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'When they end; null when `ending` is 0.',
      },
      available: {
        type: 'integer',
        description:
          '`purchased − ending − inUse`, floored at 0. Advisory — the mint gate is the organization-wide `licenses.available`.',
      },
      releasing: {
        type: 'integer',
        deprecated: true,
        description:
          'Use `ending`. Every seat leaving this tier at the boundary, a pending downgrade included.',
      },
      priceCents: { type: ['integer', 'null'] },
      currency: { type: ['string', 'null'] },
    },
  },
  BillingLicenseSummary: {
    type: 'object',
    required: ['purchased', 'releasing', 'ending', 'endsAt', 'held', 'inUse', 'bound', 'available'],
    properties: {
      purchased: { type: 'integer', description: 'Total committed quantity across tiers.' },
      releasing: {
        type: 'integer',
        description:
          'Every seat leaving at the period boundary (ending licenses and pending downgrades).',
      },
      ending: {
        type: 'integer',
        description: 'Licenses ending at the period boundary, all tiers; restorable.',
      },
      endsAt: { type: ['string', 'null'], format: 'date-time' },
      held: { type: 'integer', description: 'Active licenses, bound or waiting to connect.' },
      inUse: { type: 'integer', description: 'Same number as `held`, under the console name.' },
      bound: { type: 'integer', description: 'The subset bound to a server.' },
      available: {
        type: 'integer',
        description: '`purchased − releasing − held`: how many more servers can be added.',
      },
    },
  },
  BillingServerAssignment: {
    type: 'object',
    required: ['serverId', 'assignedTierId', 'requiredTier'],
    properties: {
      serverId: { type: 'string', format: 'uuid' },
      assignedTierId: {
        type: ['string', 'null'],
        format: 'uuid',
        description: 'The derived tier; null when nothing purchased covers the server.',
      },
      requiredTier: {
        type: ['string', 'null'],
        description: "From the server's hardware; null until it reports.",
      },
    },
  },
  BillingPendingChange: {
    type: 'object',
    required: ['id', 'kind', 'fromTierId', 'toTierId', 'createdAt', 'landsAt'],
    properties: {
      id: { type: 'string' },
      kind: { type: 'string', enum: ['downgrade', 'release-seat'] },
      fromTierId: { type: 'string', format: 'uuid' },
      toTierId: { type: ['string', 'null'], format: 'uuid' },
      createdAt: { type: 'string', format: 'date-time' },
      landsAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'The period boundary the change is parked behind.',
      },
    },
  },
  BillingSubscriptionResponse: {
    type: 'object',
    required: ['payer', 'subscription', 'tiers', 'licenses', 'servers', 'pendingChanges'],
    properties: {
      payer: {
        oneOf: [
          {
            type: 'object',
            required: ['taxId'],
            properties: { taxId: { type: ['string', 'null'] } },
          },
          { type: 'null' },
        ],
      },
      subscription: {
        oneOf: [
          {
            type: 'object',
            required: [
              'status',
              'currentPeriodEnd',
              'pastDueSince',
              'graceExpiresAt',
              'scheduleAttached',
            ],
            properties: {
              status: {
                type: 'string',
                description: 'Provider status verbatim (`active`, `past_due`, …).',
              },
              currentPeriodEnd: { type: ['string', 'null'], format: 'date-time' },
              pastDueSince: { type: ['string', 'null'], format: 'date-time' },
              graceExpiresAt: {
                type: ['string', 'null'],
                format: 'date-time',
                description:
                  'Entitlement survives until this moment while past due; the grace clock cancels after it.',
              },
              scheduleAttached: {
                type: 'boolean',
                description:
                  'A deferred change (downgrade / seat release) is parked on a subscription schedule.',
              },
            },
          },
          { type: 'null' },
        ],
      },
      tiers: { type: 'array', items: { $ref: '#/components/schemas/BillingTierSummary' } },
      licenses: { $ref: '#/components/schemas/BillingLicenseSummary' },
      servers: { type: 'array', items: { $ref: '#/components/schemas/BillingServerAssignment' } },
      pendingChanges: {
        type: 'array',
        items: { $ref: '#/components/schemas/BillingPendingChange' },
      },
    },
  },
  BillingCheckoutRequest: {
    type: 'object',
    required: ['tierId'],
    properties: {
      tierId: { type: 'string', format: 'uuid' },
      quantity: { type: 'integer', minimum: 1, default: 1 },
    },
  },
  BillingRedirectResponse: {
    type: 'object',
    required: ['url'],
    properties: {
      url: {
        type: 'string',
        format: 'uri',
        description: 'Hosted Stripe page to redirect the browser to.',
      },
      sessionId: { type: 'string' },
    },
  },
  BillingPreviewRequest: {
    type: 'object',
    description:
      'Either a quantity change (`tierId` + `delta`) or a move of one purchased license between tiers (`fromTierId` + `toTierId`).',
    properties: {
      tierId: { type: 'string', format: 'uuid' },
      delta: { type: 'integer' },
      fromTierId: { type: 'string', format: 'uuid' },
      toTierId: { type: 'string', format: 'uuid' },
    },
  },
  BillingPreviewResponse: {
    type: 'object',
    required: ['prorationDate', 'currency', 'subtotal', 'tax', 'total', 'amountDue', 'lines'],
    properties: {
      prorationDate: {
        type: 'integer',
        description: 'Unix seconds. Pass back verbatim on apply so the invoice matches the quote.',
      },
      currency: { type: ['string', 'null'] },
      subtotal: { type: ['integer', 'null'] },
      tax: { type: ['integer', 'null'] },
      total: { type: ['integer', 'null'] },
      amountDue: { type: ['integer', 'null'] },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          required: ['description', 'amount', 'proration'],
          properties: {
            description: { type: ['string', 'null'] },
            amount: { type: 'integer' },
            proration: { type: 'boolean' },
          },
        },
      },
    },
  },
  BillingSeatsRequest: {
    type: 'object',
    required: ['tierId', 'delta'],
    properties: {
      tierId: { type: 'string', format: 'uuid' },
      delta: {
        type: 'integer',
        description:
          'Positive: buys that many now, invoiced — refused `licenses_ending` while licenses at this tier are ending (restore those first with `POST /billing/restore`; other tiers never block). Negative: those licenses end at the period boundary.',
      },
      prorationDate: { type: 'integer', description: 'From the preview; increases only.' },
    },
  },
  BillingTierMoveRequest: {
    type: 'object',
    required: ['fromTierId', 'toTierId'],
    description:
      'One fewer at `fromTierId`, one more at `toTierId`. Which server ends up where is derived from hardware.',
    properties: {
      fromTierId: { type: 'string', format: 'uuid' },
      toTierId: { type: 'string', format: 'uuid' },
      prorationDate: { type: 'integer', description: 'From the preview; upgrades only.' },
    },
  },
  BillingMutationResponse: {
    type: 'object',
    required: ['ok'],
    properties: {
      ok: { type: 'boolean', const: true },
      pending: {
        type: 'boolean',
        description:
          'The immediate charge failed and Stripe parked the change; entitlement is unchanged until it applies.',
      },
      deferred: { type: 'boolean', description: 'Parked on a schedule for the period boundary.' },
      intentId: { type: 'string' },
      scheduleId: { type: ['string', 'null'] },
    },
  },
  BillingRestoreRequest: {
    type: 'object',
    required: ['tierId', 'count'],
    properties: {
      tierId: { type: 'string', format: 'uuid' },
      count: {
        type: 'integer',
        minimum: 1,
        description:
          'How many ending licenses to take back; more than are ending restores them all.',
      },
    },
  },
  BillingRestoreResponse: {
    type: 'object',
    required: ['ok', 'restored', 'ending', 'scheduleId'],
    properties: {
      ok: { type: 'boolean', const: true },
      restored: { type: 'integer', minimum: 1, description: 'Taken back; never charged.' },
      ending: { type: 'integer', description: 'Still ending at this tier afterwards.' },
      scheduleId: {
        type: ['string', 'null'],
        description: 'The rebuilt schedule, or null when nothing is ending any more (released).',
      },
    },
  },
  BillingLicensesEndingError: {
    type: 'object',
    required: ['error', 'tierId', 'ending', 'endsAt'],
    description:
      'Buying more at a tier (seats, an upgrade or downgrade into it, or the preview of any of those) while licenses at that tier are ending. Restore them first.',
    properties: {
      error: { type: 'string', const: 'licenses_ending' },
      tierId: { type: 'string', format: 'uuid' },
      ending: { type: 'integer' },
      endsAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },
} as const

const conflict = (codes: string) => errorResponse(`Conflict — \`error\` is one of ${codes}.`)

const CLIENT_PREFIX = '/api/client/v1'

function mutationPath(summary: string, requestSchema: string, extraConflicts: string) {
  return {
    post: {
      tags: ['Billing'],
      summary,
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: `#/components/schemas/${requestSchema}` } },
        },
      },
      responses: {
        '200': {
          description: 'Applied or parked',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/BillingMutationResponse' },
            },
          },
        },
        '400': errorResponse(
          'Invalid request, `tier_not_purchasable`, `not_an_upgrade` / `not_a_downgrade`'
        ),
        '401': unauthorized,
        '403': forbidden,
        '409': conflict(`\`billing_mutation_in_progress\`, ${extraConflicts}`),
        '502': errorResponse('Stripe refused the request (`stripe_error`, permanent)'),
        '503': errorResponse(
          '`billing_not_configured`, or Stripe was unreachable (`stripe_error`, transient)'
        ),
      },
    },
  }
}

export const billingPaths: Record<string, unknown> = {
  [`${CLIENT_PREFIX}/billing/catalog`]: {
    get: {
      tags: ['Billing'],
      summary: 'Active tiers with their cached price and ladder entitlements',
      description: 'Postgres only — no provider call.',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'Catalogue in rank order',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/BillingCatalogResponse' } },
          },
        },
        '401': unauthorized,
        '403': forbidden,
        '503': notConfigured,
      },
    },
  },
  [`${CLIENT_PREFIX}/billing/subscription`]: {
    get: {
      tags: ['Billing'],
      summary: 'Projection summary for the organization',
      description:
        "Status, period end, per-tier purchased vs in use, the license totals the mint gate reads, each licensed server's derived tier, grace clock, schedule flag and outstanding deferred changes. Postgres only.",
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'Summary',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/BillingSubscriptionResponse' },
            },
          },
        },
        '401': unauthorized,
        '403': forbidden,
        '503': notConfigured,
      },
    },
  },
  [`${CLIENT_PREFIX}/billing/checkout`]: {
    post: {
      tags: ['Billing'],
      summary: 'First purchase → hosted Checkout URL',
      description:
        'Refused with `subscription_exists` once a live subscription is projected; later changes use `/billing/seats`, `/billing/upgrade`, `/billing/downgrade`.',
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/BillingCheckoutRequest' } },
        },
      },
      responses: {
        '200': {
          description: 'Redirect target',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/BillingRedirectResponse' },
            },
          },
        },
        '400': errorResponse('Invalid request or `tier_not_purchasable`'),
        '401': unauthorized,
        '403': forbidden,
        '409': conflict('`subscription_exists`, `billing_mutation_in_progress`'),
        '502': errorResponse('`stripe_error`'),
        '503': notConfigured,
      },
    },
  },
  [`${CLIENT_PREFIX}/billing/portal`]: {
    post: {
      tags: ['Billing'],
      summary: 'Customer Portal session URL (invoices and payment methods only)',
      security: [{ cookieAuth: [] }],
      responses: {
        '200': {
          description: 'Redirect target',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/BillingRedirectResponse' },
            },
          },
        },
        '401': unauthorized,
        '403': forbidden,
        '404': errorResponse('No provider customer yet'),
        '502': errorResponse('`stripe_error`'),
        '503': notConfigured,
      },
    },
  },
  [`${CLIENT_PREFIX}/billing/preview`]: {
    post: {
      tags: ['Billing'],
      summary: 'Proration quote for a quantity or tier change',
      description:
        "Returns Stripe's amounts and the pinned `prorationDate` verbatim; pass it back on apply.",
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/BillingPreviewRequest' } },
        },
      },
      responses: {
        '200': {
          description: 'Quote',
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/BillingPreviewResponse' } },
          },
        },
        '400': errorResponse('Invalid request or `tier_not_purchasable`'),
        '401': unauthorized,
        '403': forbidden,
        '409': conflict(
          '`licenses_ending` (BillingLicensesEndingError), `subscription_past_due`, `no_subscription`'
        ),
        '502': errorResponse('`stripe_error`'),
        '503': notConfigured,
      },
    },
  },
  [`${CLIENT_PREFIX}/billing/seats`]: mutationPath(
    'Buy or release licenses at one tier',
    'BillingSeatsRequest',
    '`licenses_ending` (BillingLicensesEndingError), `subscription_past_due`, `no_subscription`, `servers_uncovered`, `licenses_in_use`'
  ),
  [`${CLIENT_PREFIX}/billing/restore`]: {
    post: {
      tags: ['Billing'],
      summary: 'Take back licenses ending at one tier',
      description:
        'Withdraws up to `count` of the tier’s ending licenses (newest first). Nothing is bought or invoiced; allowed while past due. The schedule is rebuilt from what is still ending, or released when nothing is.',
      security: [{ cookieAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/BillingRestoreRequest' } },
        },
      },
      responses: {
        '200': {
          description: 'Restored',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/BillingRestoreResponse' },
            },
          },
        },
        '400': errorResponse('Invalid request'),
        '401': unauthorized,
        '403': forbidden,
        '409': conflict('`no_licenses_ending`, `no_subscription`, `billing_mutation_in_progress`'),
        '502': errorResponse('Stripe refused the schedule change (`stripe_error`)'),
        '503': errorResponse(
          '`billing_not_configured`, or Stripe was unreachable (`stripe_error`, transient)'
        ),
      },
    },
  },
  [`${CLIENT_PREFIX}/billing/upgrade`]: mutationPath(
    'Move one purchased license to a higher tier, invoiced now',
    'BillingTierMoveRequest',
    '`licenses_ending` (at the higher tier), `subscription_past_due`, `no_subscription`, `servers_uncovered`'
  ),
  [`${CLIENT_PREFIX}/billing/downgrade`]: mutationPath(
    'Move one purchased license to a lower tier at the period boundary',
    'BillingTierMoveRequest',
    '`licenses_ending` (at the lower tier), `no_subscription`, `servers_uncovered`, `licenses_in_use`'
  ),
}
