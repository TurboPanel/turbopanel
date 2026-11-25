import { ADMIN_API_PREFIX } from '../../app/surfaces.ts'
import {
  notificationHoldProperties,
  notificationRuleSchema,
} from '../../client/openapi/notifications.ts'
import { jsonOperation, schemaRef } from '../../client/openapi/shared.ts'
import { NOTIFICATION_CHANNEL_KINDS } from '../../features/notifications/records.ts'

type Operation = Parameters<typeof jsonOperation>[0]

/** Every admin route sits behind the admin session check, so 403 is always possible. */
function adminOperation(config: Operation): Record<string, unknown> {
  return jsonOperation({
    ...config,
    errors: [...new Set([403, ...(config.errors ?? [])])],
    detail: { 403: 'Forbidden: requires an administrator', ...config.detail },
  })
}

const SETTINGS = 'Settings'
const FLEET = 'Daemon Fleet'
const INSTANCE = 'Instance'
const rootOnly = 'Root administrator only.'

const okOnly = {
  type: 'object',
  required: ['ok'],
  properties: { ok: { type: 'boolean', const: true } },
}

export const adminNotificationSettingsSchemas = {
  AdminNotificationRule: notificationRuleSchema,
  AdminNotificationChannel: {
    type: 'object',
    description:
      'An instance channel: the operator’s own receiver. It hears install events, and an organization’s events only when `allOrganizations` is on.',
    properties: {
      id: { type: 'string' },
      scope: { type: 'string', const: 'instance' },
      kind: { type: 'string', enum: [...NOTIFICATION_CHANNEL_KINDS] },
      label: { type: 'string' },
      address: {
        type: 'string',
        description: 'Shown masked: secrets in a URL or token are hidden.',
      },
      allOrganizations: { type: 'boolean' },
      signed: { type: 'boolean' },
      verifiedAt: { type: ['string', 'null'], format: 'date-time' },
      disabledAt: { type: ['string', 'null'], format: 'date-time' },
      createdAt: { type: 'string', format: 'date-time' },
      digestCadence: notificationHoldProperties.digestCadence,
      quietHours: notificationHoldProperties.quietHours,
      timeZone: { type: 'string' },
      rules: { type: 'array', items: schemaRef('AdminNotificationRule') },
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
  AdminNotificationChannelResponse: {
    type: 'object',
    required: ['ok', 'channel'],
    properties: {
      ok: { type: 'boolean', const: true },
      channel: schemaRef('AdminNotificationChannel'),
    },
  },
  AdminNotificationChannelCreateRequest: {
    type: 'object',
    required: ['kind', 'label', 'address'],
    properties: {
      kind: { type: 'string', enum: NOTIFICATION_CHANNEL_KINDS.filter((kind) => kind !== 'push') },
      label: { type: 'string', maxLength: 80 },
      address: {
        type: 'string',
        maxLength: 2048,
        description:
          'An email address must be an administrator’s account email; other kinds take a URL (checked against the outbound policy) or Telegram `<bot token>/<chat id>`.',
      },
      signingSecret: { type: ['string', 'null'], maxLength: 256, description: 'Webhook only.' },
      allOrganizations: { type: 'boolean', description: 'Also hear every organization’s events.' },
      rules: { type: 'array', items: schemaRef('AdminNotificationRule') },
      digestCadence: notificationHoldProperties.digestCadence,
      quietHours: notificationHoldProperties.quietHours,
    },
  },
  AdminNotificationChannelPatchRequest: {
    type: 'object',
    properties: {
      label: { type: 'string', maxLength: 80 },
      disabled: { type: 'boolean' },
      allOrganizations: {
        type: 'boolean',
        description: 'The operator alert webhook channel cannot turn this off.',
      },
      rules: { type: 'array', items: schemaRef('AdminNotificationRule') },
      digestCadence: notificationHoldProperties.digestCadence,
      quietHours: notificationHoldProperties.quietHours,
    },
  },
  SignupSetting: {
    type: 'object',
    required: ['enabled', 'dbValue', 'isEnvForced', 'envOverride'],
    properties: {
      enabled: { type: 'boolean', description: 'What applies now.' },
      dbValue: { type: ['boolean', 'null'], description: 'The panel toggle, when set.' },
      isEnvForced: {
        type: 'boolean',
        description: 'Sign-up is fixed by `TURBOPANEL_IS_SIGNUP_ENABLED`; the toggle is ignored.',
      },
      envOverride: { type: ['boolean', 'null'] },
    },
  },
  ServerMetricsLiveSetting: {
    type: 'object',
    required: ['maxMinutes'],
    properties: {
      maxMinutes: {
        type: 'integer',
        description:
          'Longest live-metrics window a person may start; 0 turns it off, else 5 to 240.',
      },
    },
  },
  AuditRetentionSetting: {
    type: 'object',
    required: ['months'],
    properties: {
      months: {
        type: 'integer',
        description: 'Months of audit history kept; 0 keeps everything, else 3 to 120.',
      },
    },
  },
  AlertWebhookSetting: {
    type: 'object',
    required: ['configured', 'origin'],
    description: 'The URL is never returned: its path is the credential. Only the origin is shown.',
    properties: {
      configured: { type: 'boolean' },
      origin: { type: ['string', 'null'] },
    },
  },
  DaemonEchoPayloadRequest: {
    type: 'object',
    required: ['payload'],
    properties: { payload: { description: 'Any JSON value, echoed back by the daemon.' } },
  },
  DaemonAddressesResponse: {
    type: 'object',
    required: ['ok', 'daemonId', 'ips'],
    properties: {
      ok: { type: 'boolean', const: true },
      daemonId: { type: 'string' },
      hostname: { type: ['string', 'null'] },
      ips: {
        type: 'array',
        items: { type: 'object' },
        description: 'Addresses the daemon reports.',
      },
    },
  },
}

const CHANNELS = `${ADMIN_API_PREFIX}/notification-channels`
const SIGNUP = `${ADMIN_API_PREFIX}/settings/signup`
const LIVE = `${ADMIN_API_PREFIX}/settings/server-metrics-live`
const RETENTION = `${ADMIN_API_PREFIX}/settings/audit-retention`
const WEBHOOK = `${ADMIN_API_PREFIX}/settings/alert-webhook`

export const ADMIN_NOTIFICATION_SETTINGS_PATHS = {
  [CHANNELS]: {
    get: adminOperation({
      path: CHANNELS,
      tag: SETTINGS,
      summary: 'List instance notification channels',
      ok: {
        type: 'object',
        required: ['channels'],
        properties: { channels: { type: 'array', items: schemaRef('AdminNotificationChannel') } },
      },
    }),
    post: adminOperation({
      path: CHANNELS,
      tag: SETTINGS,
      summary: 'Create an instance notification channel',
      body: schemaRef('AdminNotificationChannelCreateRequest'),
      ok: schemaRef('AdminNotificationChannelResponse'),
      okStatus: '201',
      okDescription: 'Channel created',
      errors: [400, 422],
      detail: {
        422: '`address_rejected`, `address_not_a_member` (email must be an administrator’s) or `timing_push_unsupported`',
        503: 'Database unavailable, or no encryption key for a non-email channel',
      },
    }),
  },
  [`${CHANNELS}/{id}`]: {
    patch: adminOperation({
      path: `${CHANNELS}/{id}`,
      tag: SETTINGS,
      summary: 'Update an instance notification channel',
      body: schemaRef('AdminNotificationChannelPatchRequest'),
      ok: {
        type: 'object',
        required: ['ok', 'channel'],
        description:
          '`channel` is `null` when the channel vanished between the write and the read.',
        properties: {
          ok: { type: 'boolean', const: true },
          channel: { oneOf: [schemaRef('AdminNotificationChannel'), { type: 'null' }] },
        },
      },
      errors: [400, 404, 422],
    }),
    delete: adminOperation({
      path: `${CHANNELS}/{id}`,
      tag: SETTINGS,
      summary: 'Delete an instance notification channel',
      ok: okOnly,
      errors: [404],
    }),
  },
  [SIGNUP]: {
    get: adminOperation({
      path: SIGNUP,
      tag: SETTINGS,
      summary: 'Read the sign-up setting',
      ok: schemaRef('SignupSetting'),
    }),
    put: adminOperation({
      path: SIGNUP,
      tag: SETTINGS,
      summary: 'Turn sign-up on or off',
      description: rootOnly,
      body: {
        type: 'object',
        required: ['enabled'],
        properties: { enabled: { type: 'boolean' } },
      },
      ok: schemaRef('SignupSetting'),
      errors: [400, 409],
      detail: {
        409: 'Sign-up is fixed by `TURBOPANEL_IS_SIGNUP_ENABLED`; the body is the setting as it is',
      },
    }),
  },
  [LIVE]: {
    get: adminOperation({
      path: LIVE,
      tag: SETTINGS,
      summary: 'Read the live server metrics limit',
      ok: schemaRef('ServerMetricsLiveSetting'),
    }),
    put: adminOperation({
      path: LIVE,
      tag: SETTINGS,
      summary: 'Set the live server metrics limit',
      body: schemaRef('ServerMetricsLiveSetting'),
      ok: schemaRef('ServerMetricsLiveSetting'),
      errors: [400],
    }),
  },
  [RETENTION]: {
    get: adminOperation({
      path: RETENTION,
      tag: SETTINGS,
      summary: 'Read the audit retention setting',
      description: rootOnly,
      ok: schemaRef('AuditRetentionSetting'),
    }),
    put: adminOperation({
      path: RETENTION,
      tag: SETTINGS,
      summary: 'Set the audit retention',
      description: rootOnly,
      body: schemaRef('AuditRetentionSetting'),
      ok: schemaRef('AuditRetentionSetting'),
      errors: [400],
    }),
  },
  [WEBHOOK]: {
    get: adminOperation({
      path: WEBHOOK,
      tag: SETTINGS,
      summary: 'Read the operator alert webhook',
      ok: schemaRef('AlertWebhookSetting'),
    }),
    put: adminOperation({
      path: WEBHOOK,
      tag: SETTINGS,
      summary: 'Set or clear the operator alert webhook',
      description: `${rootOnly} The same channel appears as the operator alert webhook under notification channels.`,
      body: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: ['string', 'null'], description: '`null` or empty clears it.' },
        },
      },
      ok: schemaRef('AlertWebhookSetting'),
      errors: [400],
      detail: {
        400: '`url` is not a string or null, or the URL fails the alert webhook policy (`reason` says why)',
        503: 'Database unavailable, or no data encryption secrets to store a URL',
      },
    }),
  },
  [`${ADMIN_API_PREFIX}/daemon/{id}/send`]: {
    post: adminOperation({
      path: `${ADMIN_API_PREFIX}/daemon/{id}/send`,
      tag: FLEET,
      summary: 'Send an echo to one daemon',
      body: schemaRef('DaemonEchoPayloadRequest'),
      ok: {
        type: 'object',
        required: ['ok', 'id'],
        properties: { ok: { type: 'boolean', const: true }, id: { type: 'string' } },
      },
      errors: [400, 404],
      detail: { 404: '`daemon not connected`', 503: 'Daemon cell registry unavailable' },
    }),
  },
  [`${ADMIN_API_PREFIX}/daemon/{id}/addresses`]: {
    get: adminOperation({
      path: `${ADMIN_API_PREFIX}/daemon/{id}/addresses`,
      tag: FLEET,
      summary: 'Collect network addresses from one daemon',
      ok: schemaRef('DaemonAddressesResponse'),
      errors: [400, 404, 500],
      detail: {
        404: '`daemon not connected`',
        500: 'The daemon failed or did not answer in time',
        503: 'Daemon cell registry unavailable',
      },
    }),
  },
  [`${ADMIN_API_PREFIX}/instance/updates/servers`]: {
    get: adminOperation({
      path: `${ADMIN_API_PREFIX}/instance/updates/servers`,
      tag: INSTANCE,
      summary: 'List servers with their daemon update state',
      description:
        'One page of the fleet: installed daemon version and commit, whether an update is available, and the step of the running update, if any.',
      query: [
        { name: 'offset', description: 'Rows to skip; default 0.', schema: { type: 'integer' } },
        {
          name: 'limit',
          description: 'Rows to return, 1 to 100; default 50.',
          schema: { type: 'integer' },
        },
        { name: 'status', description: 'Only servers in this update state.' },
      ],
      ok: {
        type: 'object',
        required: ['ok', 'servers', 'total'],
        properties: {
          ok: { type: 'boolean', const: true },
          servers: { type: 'array', items: { type: 'object' } },
          total: { type: 'integer' },
        },
      },
    }),
  },
}
