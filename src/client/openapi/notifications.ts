import { NOTIFICATION_SEVERITIES } from '../../features/notifications/events.ts'
import { NOTIFICATION_CHANNEL_KINDS } from '../../features/notifications/records.ts'
import { NOTIFICATION_LEVELS } from '../../features/notifications/vocabulary.ts'
import { NOTIFICATION_DIGEST_CADENCES } from '../../features/notifications/windows.ts'
import { jsonOperation, schemaRef } from './shared.ts'

const TAG = 'Notifications'
const BASE = '/api/client/v1'
const okOnly = schemaRef('NotificationOk')
const idPathNote = 'Another person’s id answers 404, the same as an id that does not exist.'

export const NOTIFICATION_SEVERITY_SCHEMA = { type: 'string', enum: [...NOTIFICATION_SEVERITIES] }
const CHANNEL_KINDS = NOTIFICATION_CHANNEL_KINDS.filter((kind) => kind !== 'push')

export const notificationRuleSchema = {
  type: 'object',
  required: ['event'],
  properties: {
    event: { type: 'string', description: 'An event code, or `*` for every event.' },
    minSeverity: { ...NOTIFICATION_SEVERITY_SCHEMA, default: 'info' },
  },
}

export const notificationHoldProperties = {
  digestCadence: {
    type: ['string', 'null'],
    enum: [...NOTIFICATION_DIGEST_CADENCES, null],
    description: 'Batch deliveries into a digest; `null` sends each at once. Not for push.',
  },
  quietHours: {
    type: ['object', 'null'],
    required: ['start', 'end'],
    properties: {
      start: { type: 'string', description: 'Clock time, `HH:MM`.' },
      end: { type: 'string', description: 'Clock time, `HH:MM`; not equal to `start`.' },
    },
    description: 'Hold deliveries inside this window. Not for push.',
  },
  timeZone: {
    type: ['string', 'null'],
    description: 'Zone the window is read in. Personal channels only; `null` clears it.',
  },
}

export const notificationSchemas = {
  NotificationOk: {
    type: 'object',
    required: ['ok'],
    properties: { ok: { type: 'boolean', const: true } },
  },
  NotificationRule: notificationRuleSchema,
  NotificationItem: {
    type: 'object',
    required: ['id', 'createdAt', 'event', 'severity', 'title'],
    properties: {
      id: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      organizationId: { type: ['string', 'null'] },
      event: { type: 'string' },
      severity: NOTIFICATION_SEVERITY_SCHEMA,
      title: { type: 'string' },
      body: { type: ['string', 'null'] },
      targetType: { type: ['string', 'null'] },
      targetId: { type: ['string', 'null'] },
      projectId: { type: ['string', 'null'] },
      environmentId: { type: ['string', 'null'] },
      serviceId: { type: ['string', 'null'] },
      serverId: { type: ['string', 'null'] },
      destinationId: { type: ['string', 'null'] },
      readAt: { type: ['string', 'null'], format: 'date-time' },
      targetDeleted: {
        type: 'boolean',
        description: 'What the row is about is gone; the row stays, its link does not.',
      },
    },
  },
  NotificationList: {
    type: 'object',
    required: ['notifications', 'unread'],
    properties: {
      notifications: { type: 'array', items: schemaRef('NotificationItem') },
      unread: { type: 'integer', description: 'Unread count, capped at 100.' },
    },
  },
  NotificationEvent: {
    type: 'object',
    properties: {
      event: { type: 'string' },
      severity: NOTIFICATION_SEVERITY_SCHEMA,
      scope: { type: 'string' },
      audience: { type: 'string' },
      category: { type: 'string' },
      label: { type: 'string' },
      example: { type: 'string', description: 'Title a notification of this event carries.' },
    },
  },
  NotificationChannel: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      scope: { type: 'string', enum: ['organization', 'user'] },
      organizationId: { type: ['string', 'null'] },
      kind: { type: 'string', enum: [...NOTIFICATION_CHANNEL_KINDS] },
      label: { type: 'string' },
      address: {
        type: 'string',
        description: 'The target as shown to people: secrets in a URL or token are masked.',
      },
      signed: { type: 'boolean', description: 'A webhook signing secret is set.' },
      verifiedAt: { type: ['string', 'null'], format: 'date-time' },
      disabledAt: { type: ['string', 'null'], format: 'date-time' },
      createdAt: { type: 'string', format: 'date-time' },
      isPrimary: { type: 'boolean', description: 'The built-in account email channel.' },
      ...notificationHoldProperties,
      rules: { type: 'array', items: schemaRef('NotificationRule') },
      recentDeliveries: {
        type: 'array',
        description: 'Deliveries from the last seven days.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            event: { type: 'string' },
            status: { type: 'string' },
            attempts: { type: 'integer' },
            at: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
  },
  NotificationChannelResponse: {
    type: 'object',
    required: ['ok', 'channel'],
    properties: {
      ok: { type: 'boolean', const: true },
      channel: schemaRef('NotificationChannel'),
    },
  },
  NotificationChannelCreateRequest: {
    type: 'object',
    required: ['kind', 'label', 'address'],
    properties: {
      scope: { type: 'string', enum: ['user', 'organization'], default: 'user' },
      kind: { type: 'string', enum: CHANNEL_KINDS },
      label: { type: 'string', maxLength: 80 },
      address: {
        type: 'string',
        maxLength: 2048,
        description:
          'Email address, webhook, Slack or Discord URL (checked against the outbound policy), or Telegram `<bot token>/<chat id>`. An email address must already be known to belong here; use `POST /notification-channels/email` for any other.',
      },
      signingSecret: { type: ['string', 'null'], maxLength: 256, description: 'Webhook only.' },
      rules: {
        type: 'array',
        items: schemaRef('NotificationRule'),
        description: 'Organization channels only.',
      },
      ...notificationHoldProperties,
    },
  },
  NotificationChannelPatchRequest: {
    type: 'object',
    properties: {
      label: { type: 'string', maxLength: 80 },
      disabled: { type: 'boolean' },
      rules: { type: 'array', items: schemaRef('NotificationRule') },
      ...notificationHoldProperties,
    },
  },
  NotificationEmailChannelRequest: {
    type: 'object',
    required: ['label', 'address'],
    properties: {
      scope: { type: 'string', enum: ['user', 'organization'], default: 'user' },
      label: {
        type: 'string',
        maxLength: 40,
        description: 'A short plain name: it is read out in the verification mail.',
      },
      address: { type: 'string', description: 'Any single email address.' },
    },
  },
  NotificationPreference: {
    type: 'object',
    description: 'One preference row; the narrowest scope that matches wins.',
    properties: {
      id: { type: 'string' },
      scope: {
        type: 'string',
        enum: [
          'global',
          'organization',
          'project',
          'environment',
          'service',
          'server',
          'destination',
        ],
      },
      organizationId: { type: ['string', 'null'] },
      projectId: { type: ['string', 'null'] },
      environmentId: { type: ['string', 'null'] },
      serviceId: { type: ['string', 'null'] },
      serverId: { type: ['string', 'null'] },
      destinationId: { type: ['string', 'null'] },
      categoryCode: { type: ['string', 'null'] },
      topicCode: { type: ['string', 'null'] },
      kind: { type: ['string', 'null'], enum: ['inbox', 'email', 'chat', 'webhook', null] },
      channelId: { type: ['string', 'null'] },
      level: { type: 'string', enum: [...NOTIFICATION_LEVELS] },
      endsAt: { type: ['string', 'null'], format: 'date-time' },
    },
  },
  NotificationEffectiveLevels: {
    type: 'object',
    description: 'Per kind (`inbox`, `email`, `chat`, `webhook`): what applies and why.',
    additionalProperties: {
      type: 'object',
      required: ['level', 'sourceId', 'source'],
      properties: {
        level: { type: 'string', enum: [...NOTIFICATION_LEVELS] },
        sourceId: { type: ['string', 'null'], description: 'The row that decided it.' },
        source: { type: 'string', description: 'Scope of that row, or `default`.' },
      },
    },
  },
  NotificationPreferencesResponse: {
    type: 'object',
    properties: {
      rows: { type: 'array', items: schemaRef('NotificationPreference') },
      channels: {
        type: 'array',
        description: 'The person’s own channels.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            kind: { type: 'string' },
            label: { type: 'string' },
            isPrimary: { type: 'boolean' },
            verified: { type: 'boolean' },
            disabled: { type: 'boolean' },
            address: { type: 'string' },
          },
        },
      },
      catalog: {
        type: 'object',
        properties: {
          categories: {
            type: 'array',
            items: {
              type: 'object',
              properties: { code: { type: 'string' }, name: { type: 'string' } },
            },
          },
          topics: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                name: { type: 'string' },
                categoryCode: { type: 'string' },
                severity: NOTIFICATION_SEVERITY_SCHEMA,
                audience: { type: 'string' },
                scope: { type: 'string' },
                urgent: { type: 'boolean' },
              },
            },
          },
        },
      },
      presets: {
        type: 'object',
        description: 'Preset name to the `inbox` and `email` levels it sets.',
        additionalProperties: { type: 'object', additionalProperties: { type: 'string' } },
      },
      effective: schemaRef('NotificationEffectiveLevels'),
      administrator: { type: 'boolean' },
      allOrganizations: { type: 'boolean' },
    },
  },
  NotificationPreferenceWriteRequest: {
    type: 'object',
    required: ['level'],
    description:
      'Name a category or a topic, not both; a channel or a kind, not both; at most one of service, server and destination, which need `organizationId`.',
    properties: {
      organizationId: { type: ['string', 'null'] },
      projectId: { type: ['string', 'null'], description: 'Needs `organizationId`.' },
      environmentId: { type: ['string', 'null'], description: 'Needs `projectId`.' },
      serviceId: { type: ['string', 'null'] },
      serverId: { type: ['string', 'null'] },
      destinationId: { type: ['string', 'null'] },
      categoryCode: { type: ['string', 'null'] },
      topicCode: { type: ['string', 'null'] },
      kind: { type: ['string', 'null'], enum: ['inbox', 'email', 'chat', 'webhook', null] },
      channelId: { type: ['string', 'null'], description: 'One of the caller’s own channels.' },
      level: { type: 'string', enum: [...NOTIFICATION_LEVELS] },
      endsAt: { type: ['string', 'null'], format: 'date-time', description: 'Snooze until.' },
    },
  },
}

const organizationIdQuery = {
  name: 'organizationId',
  description: 'Read the preferences of this organization; omit for the global ones.',
}
const scopeQueries = ['projectId', 'environmentId', 'serviceId', 'serverId', 'destinationId'].map(
  (name) => ({ name, description: `Narrow the answer to this ${name.replace('Id', '')}.` })
)

export const notificationPaths = {
  [`${BASE}/notification-events`]: {
    get: jsonOperation({
      path: `${BASE}/notification-events`,
      tag: TAG,
      summary: 'List notification events',
      description: 'The catalogue of events the preferences matrix is built from.',
      ok: {
        type: 'object',
        required: ['events'],
        properties: { events: { type: 'array', items: schemaRef('NotificationEvent') } },
      },
    }),
  },
  [`${BASE}/notifications`]: {
    get: jsonOperation({
      path: `${BASE}/notifications`,
      tag: TAG,
      summary: 'List the inbox',
      description: 'Newest first, dismissed rows left out.',
      query: [
        {
          name: 'limit',
          description: 'Rows to return, 1 to 100; default 30.',
          schema: { type: 'integer', minimum: 1, maximum: 100 },
        },
        { name: 'before', description: 'Only rows created before this ISO time (paging).' },
      ],
      ok: schemaRef('NotificationList'),
      errors: [400],
    }),
  },
  [`${BASE}/notifications/unread-count`]: {
    get: jsonOperation({
      path: `${BASE}/notifications/unread-count`,
      tag: TAG,
      summary: 'Count unread notifications',
      ok: {
        type: 'object',
        required: ['unread'],
        properties: { unread: { type: 'integer', description: 'Capped at 100.' } },
      },
    }),
  },
  [`${BASE}/notifications/read`]: {
    post: jsonOperation({
      path: `${BASE}/notifications/read`,
      tag: TAG,
      summary: 'Mark notifications read',
      description: 'Marks the given ids, or every unread row when the body carries none.',
      body: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'string' } } },
      },
      bodyRequired: false,
      ok: {
        type: 'object',
        required: ['ok', 'updated', 'unread'],
        properties: {
          ok: { type: 'boolean', const: true },
          updated: { type: 'integer' },
          unread: { type: 'integer' },
        },
      },
    }),
  },
  [`${BASE}/notifications/{id}`]: {
    delete: jsonOperation({
      path: `${BASE}/notifications/{id}`,
      tag: TAG,
      summary: 'Dismiss a notification',
      description: idPathNote,
      ok: okOnly,
      errors: [404],
    }),
  },
  [`${BASE}/notification-channels`]: {
    get: jsonOperation({
      path: `${BASE}/notification-channels`,
      tag: TAG,
      summary: 'List notification channels',
      description:
        'The caller’s own channels, or the organization’s shared ones (needs `organization:manage`). The built-in account email channel is created on first read.',
      query: [
        {
          name: 'scope',
          description: '`user` (default) or `organization`.',
          schema: { type: 'string', enum: ['user', 'organization'] },
        },
      ],
      ok: {
        type: 'object',
        required: ['channels'],
        properties: { channels: { type: 'array', items: schemaRef('NotificationChannel') } },
      },
      errors: [400, 403],
    }),
    post: jsonOperation({
      path: `${BASE}/notification-channels`,
      tag: TAG,
      summary: 'Create a notification channel',
      description:
        'Organization channels need `organization:manage`. Personal channels are tuned by notification preferences, not rules.',
      body: schemaRef('NotificationChannelCreateRequest'),
      ok: schemaRef('NotificationChannelResponse'),
      okStatus: '201',
      okDescription: 'Channel created',
      errors: [400, 403, 422],
      detail: {
        422: '`address_rejected` (target fails the outbound policy), `address_not_a_member` (email address not known to belong here) or `timing_push_unsupported`.',
        503: 'Database unavailable, or no encryption key for a non-email channel',
      },
    }),
  },
  [`${BASE}/notification-channels/email`]: {
    post: jsonOperation({
      path: `${BASE}/notification-channels/email`,
      tag: TAG,
      summary: 'Create an email channel for any address',
      description:
        'Queues a verification link to the address; the channel receives nothing until it is followed. Limited per person and per address.',
      body: schemaRef('NotificationEmailChannelRequest'),
      ok: {
        type: 'object',
        required: ['ok', 'verification', 'channel'],
        properties: {
          ok: { type: 'boolean', const: true },
          verification: { type: 'string', const: 'sent' },
          channel: schemaRef('NotificationChannel'),
        },
      },
      okStatus: '201',
      okDescription: 'Channel created, verification mail queued',
      errors: [400, 403, 422, 429, 502],
      detail: {
        429: '`too_many_unverified_channels`, `verification_mail_budget` or `address_verification_limit`',
        502: '`email_send_failed`',
        503: 'Database unavailable, or `email_unavailable` (no mail queue)',
      },
    }),
  },
  [`${BASE}/notification-channels/verify/{token}`]: {
    get: {
      tags: [TAG],
      summary: 'Follow an email verification link',
      description:
        'Public: the link in the verification mail. Marks the channel verified and redirects to the confirmation page, or to the failure page when the token is not valid.',
      parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '302': { description: 'Redirect to the confirmation or failure page' } },
    },
  },
  [`${BASE}/notification-channels/{id}`]: {
    patch: jsonOperation({
      path: `${BASE}/notification-channels/{id}`,
      tag: TAG,
      summary: 'Update a notification channel',
      description: idPathNote,
      body: schemaRef('NotificationChannelPatchRequest'),
      ok: schemaRef('NotificationChannelResponse'),
      errors: [400, 403, 404, 422],
    }),
    delete: jsonOperation({
      path: `${BASE}/notification-channels/{id}`,
      tag: TAG,
      summary: 'Delete a notification channel',
      description: `${idPathNote} The account email channel cannot be deleted.`,
      ok: okOnly,
      errors: [403, 404, 409],
      detail: { 409: '`primary_channel`' },
    }),
  },
  [`${BASE}/notification-channels/{id}/rules`]: {
    put: jsonOperation({
      path: `${BASE}/notification-channels/{id}/rules`,
      tag: TAG,
      summary: 'Replace a channel’s rules',
      description: `${idPathNote} Organization channels only.`,
      body: {
        type: 'object',
        required: ['rules'],
        properties: { rules: { type: 'array', items: schemaRef('NotificationRule') } },
      },
      ok: {
        type: 'object',
        required: ['ok', 'rules'],
        properties: {
          ok: { type: 'boolean', const: true },
          rules: { type: 'array', items: schemaRef('NotificationRule') },
        },
      },
      errors: [400, 403, 404, 422],
      detail: { 422: '`personal_channel_uses_preferences`' },
    }),
  },
  [`${BASE}/notification-channels/{id}/verify`]: {
    post: jsonOperation({
      path: `${BASE}/notification-channels/{id}/verify`,
      tag: TAG,
      summary: 'Resend an email channel’s verification mail',
      ok: okOnly,
      errors: [400, 403, 404, 409, 429, 502],
      detail: {
        400: '`not_an_email_channel`',
        409: '`already_verified` or `address_unreadable`',
        429: '`too_soon` (with `Retry-After`), or a mail allowance is used up',
        502: '`email_send_failed`',
        503: 'Database unavailable, or `email_unavailable`',
      },
    }),
  },
  [`${BASE}/notification-preferences`]: {
    get: jsonOperation({
      path: `${BASE}/notification-preferences`,
      tag: TAG,
      summary: 'Read notification preferences',
      description:
        'The caller’s preference rows with the channel list, event catalogue, presets and the levels that apply at the scope named in the query.',
      query: [organizationIdQuery, ...scopeQueries],
      ok: schemaRef('NotificationPreferencesResponse'),
      errors: [404],
    }),
    put: jsonOperation({
      path: `${BASE}/notification-preferences`,
      tag: TAG,
      summary: 'Set a notification preference',
      description: 'Upserts the row for that scope, subject and kind.',
      body: schemaRef('NotificationPreferenceWriteRequest'),
      ok: {
        type: 'object',
        required: ['ok', 'id'],
        properties: { ok: { type: 'boolean', const: true }, id: { type: 'string' } },
      },
      errors: [400, 404, 422],
      detail: { 422: '`scope_not_in_organization`' },
    }),
  },
  [`${BASE}/notification-preferences/effective`]: {
    get: jsonOperation({
      path: `${BASE}/notification-preferences/effective`,
      tag: TAG,
      summary: 'Resolve the levels for one event',
      query: [
        organizationIdQuery,
        { name: 'categoryCode', description: 'Resolve for this category.' },
        { name: 'topicCode', description: 'Resolve for this event.' },
        ...scopeQueries,
      ],
      ok: {
        type: 'object',
        required: ['effective'],
        properties: { effective: schemaRef('NotificationEffectiveLevels') },
      },
      errors: [404],
    }),
  },
  [`${BASE}/notification-preferences/preset`]: {
    post: jsonOperation({
      path: `${BASE}/notification-preferences/preset`,
      tag: TAG,
      summary: 'Apply a notification preset',
      description: 'Sets the inbox and email levels for the scope in one step.',
      body: {
        type: 'object',
        required: ['preset'],
        properties: {
          preset: { type: 'string', enum: ['everything', 'recommended', 'critical', 'nothing'] },
          organizationId: { type: ['string', 'null'] },
        },
      },
      ok: okOnly,
      errors: [400, 404],
    }),
  },
  [`${BASE}/notification-preferences/{id}`]: {
    delete: jsonOperation({
      path: `${BASE}/notification-preferences/{id}`,
      tag: TAG,
      summary: 'Delete a notification preference',
      description: 'Only the caller’s own rows.',
      ok: okOnly,
      errors: [404],
    }),
  },
  [`${BASE}/notification-settings`]: {
    put: jsonOperation({
      path: `${BASE}/notification-settings`,
      tag: TAG,
      summary: 'Choose whether an administrator hears about every organization',
      description: 'Platform administrators only.',
      body: {
        type: 'object',
        required: ['allOrganizations'],
        properties: { allOrganizations: { type: 'boolean' } },
      },
      ok: {
        type: 'object',
        required: ['ok', 'allOrganizations'],
        properties: {
          ok: { type: 'boolean', const: true },
          allOrganizations: { type: 'boolean' },
        },
      },
      errors: [400, 403],
    }),
  },
  [`${BASE}/notification-unsubscribe/{token}`]: {
    get: {
      tags: [TAG],
      summary: 'Open an unsubscribe link',
      description:
        'Public: the link in a notification mail. Redirects to the unsubscribe page with the token; nothing changes until it is posted.',
      parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '302': { description: 'Redirect to the unsubscribe page' } },
    },
    post: jsonOperation({
      path: `${BASE}/notification-unsubscribe/{token}`,
      tag: TAG,
      summary: 'Unsubscribe from a notification category',
      description: 'Public: the token in the mail is the credential. Mutes that category.',
      ok: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          organizationId: { type: ['string', 'null'] },
          categoryCode: { type: 'string' },
        },
      },
      errors: [400],
      detail: { 400: '`invalid_or_expired`' },
      anonymous: true,
    }),
  },
}
