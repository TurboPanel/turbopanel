const ENV_ID_PARAM = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
} as const

const ORG_ID_PARAM = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string' },
} as const

const PRINCIPAL_ID_PARAM = {
  name: 'principalId',
  in: 'path',
  required: true,
  schema: { type: 'string' },
} as const

const DATABASE_NAME_PARAM = {
  name: 'name',
  in: 'path',
  required: true,
  schema: { type: 'string' },
} as const

const BACKUP_ID_PARAM = {
  name: 'backupId',
  in: 'path',
  required: true,
  schema: { type: 'string' },
} as const

const MEMBER_ID_PARAM = {
  name: 'memberId',
  in: 'path',
  required: true,
  schema: { type: 'string' },
} as const

const POLICY_ID_PARAM = {
  name: 'policyId',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
} as const

const BACKUP_POLICY_INVALID_RESPONSE = {
  description:
    'backup_policy_invalid / backup_schedule_invalid / backup_timezone_invalid / backup_target_unsupported / managed_backup_unsupported',
  ...jsonSchema('BackupPolicyInvalidError'),
} as const

const BACKUP_POLICY_NOT_FOUND_RESPONSE = {
  description: 'backup_policy_not_found',
  ...jsonSchema('BackupPolicyNotFoundError'),
} as const

function errorSchema(constError: string) {
  return {
    type: 'object',
    required: ['error'],
    properties: {
      error: { type: 'string', const: constError },
    },
  }
}

function jsonSchema(ref: string) {
  return {
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${ref}` },
      },
    },
  }
}

export const managedSchemas = {
  ManagedMember: {
    type: 'object',
    required: [
      'id',
      'serverId',
      'serverName',
      'role',
      'replicaClass',
      'readEligible',
      'ordinal',
      'status',
      'replicationTransport',
    ],
    properties: {
      id: { type: 'string' },
      serverId: { type: 'string' },
      serverName: { type: 'string', nullable: true },
      role: { type: 'string', enum: ['primary', 'replica'] },
      replicaClass: {
        type: 'string',
        nullable: true,
        enum: ['failover', 'read'],
        description:
          'Null on primary. Failover replicas are same-datacenter and promotable; read replicas may use fabric/public.',
      },
      readEligible: { type: 'boolean' },
      ordinal: { type: 'integer', minimum: 1 },
      status: {
        type: 'string',
        nullable: true,
        enum: ['provisioning', 'applying', 'ready', 'stopped', 'failed'],
      },
      replicationTransport: {
        type: 'string',
        nullable: true,
        enum: ['local', 'datacenter', 'fabric', 'public'],
      },
    },
  },
  ManagedEnvironmentRow: {
    type: 'object',
    required: [
      'id',
      'environmentId',
      'name',
      'engine',
      'status',
      'host',
      'port',
      'serverId',
      'metadata',
      'options',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: { type: 'string' },
      environmentId: { type: 'string', nullable: true },
      name: { type: 'string', nullable: true },
      engine: {
        type: 'string',
        nullable: true,
        enum: ['postgres', 'mysql', 'mariadb', 'redis', 'clickhouse'],
      },
      status: {
        type: 'string',
        enum: ['provisioning', 'applying', 'ready', 'stopped', 'failed'],
      },
      host: { type: 'string', nullable: true },
      port: { type: 'number', nullable: true },
      serverId: {
        type: 'string',
        nullable: true,
        description: 'Placement pin (`managed.server_id`)',
      },
      metadata: {
        type: 'object',
        additionalProperties: true,
        description:
          'Residual metadata only (`rootPrincipalId`, `error`). Engine/status/host/port are top-level.',
      },
      options: { type: 'object', additionalProperties: true, nullable: true },
      members: {
        type: 'array',
        items: { $ref: '#/components/schemas/ManagedMember' },
        description: 'Cluster members (primary + replicas)',
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  ManagedSettings: {
    type: 'object',
    additionalProperties: true,
    description:
      'Engine settings (`image`, `ssl`, `resources`, `dockerOptions`, `engineConfig`, plus engine extras such as `initialDatabase`).',
  },
  ManagedConnectionInfo: {
    type: 'object',
    required: ['dsn', 'host', 'port', 'database', 'username'],
    properties: {
      dsn: {
        type: 'string',
        description: 'Connection string with password masked as `***`',
      },
      host: { type: 'string' },
      port: { type: 'number' },
      database: { type: 'string' },
      username: { type: 'string' },
    },
  },
  ManagedDetailResponse: {
    type: 'object',
    required: ['managed', 'connection', 'settings', 'server', 'rootUsername', 'members'],
    properties: {
      managed: {
        oneOf: [
          { $ref: '#/components/schemas/ManagedEnvironmentRow' },
          {
            type: 'null',
          },
        ],
      },
      connection: {
        oneOf: [
          { $ref: '#/components/schemas/ManagedConnectionInfo' },
          {
            type: 'null',
          },
        ],
      },
      settings: {
        oneOf: [
          { $ref: '#/components/schemas/ManagedSettings' },
          {
            type: 'null',
          },
        ],
      },
      server: {
        type: 'object',
        nullable: true,
        properties: {
          id: { type: 'string' },
          name: { type: 'string', nullable: true },
        },
      },
      rootUsername: { type: 'string', nullable: true },
      endpoints: {
        type: 'array',
        description:
          'Where clients connect: one `external` entry per address clients use that reaches this engine (only while external access is on), main one first, then the `local` loopback endpoint.',
        items: { $ref: '#/components/schemas/ManagedAccessEndpoint' },
      },
      connections: {
        type: 'array',
        description:
          'One connection string per `external` endpoint, main one first. The main one is also `connection`.',
        items: {
          allOf: [
            { $ref: '#/components/schemas/ManagedConnectionInfo' },
            {
              type: 'object',
              required: ['label', 'scope', 'datacenterId', 'primary'],
              properties: {
                label: { type: 'string', description: '`Public`, or the datacenter name.' },
                scope: { type: 'string', enum: ['public', 'datacenter'] },
                datacenterId: { type: ['string', 'null'], format: 'uuid' },
                primary: { type: 'boolean' },
              },
            },
          ],
        },
      },
      addressNeeded: {
        type: 'boolean',
        description:
          'External access is on but the server has no address clients can use (at most a one-word Linux hostname, which never goes into a connection string). Prompt to set the address clients use.',
      },
      externalAccess: {
        $ref: '#/components/schemas/ManagedExternalAccess',
        description:
          'The "allow external access to the databases on this server" setting of every server that fronts this cluster. The setting belongs to the server and covers every cluster on it.',
      },
      members: {
        type: 'array',
        items: { $ref: '#/components/schemas/ManagedMember' },
      },
      recovery: {
        oneOf: [
          { $ref: '#/components/schemas/ManagedRecoveryRecord' },
          {
            type: 'null',
          },
        ],
        description: 'Latest HA recovery journal row for this cluster (`null` when none).',
      },
    },
  },
  ManagedAccessEndpoint: {
    type: 'object',
    required: ['reach', 'host', 'port'],
    properties: {
      reach: { type: 'string', enum: ['external', 'local'] },
      host: { type: 'string' },
      port: { type: 'integer' },
      label: { type: 'string', description: 'External only: `Public`, or the datacenter name.' },
      scope: { type: 'string', enum: ['public', 'datacenter'], description: 'External only.' },
      datacenterId: { type: ['string', 'null'], format: 'uuid', description: 'External only.' },
      primary: { type: 'boolean', description: 'External only: fills the main connection string.' },
    },
  },
  ManagedExternalAccess: {
    type: 'object',
    required: ['servers'],
    properties: {
      servers: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'name', 'enabled', 'pending', 'otherClusters'],
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            enabled: {
              type: 'boolean',
              description:
                'Yes: the databases on this server can be reached from outside it. No (the default): only services on the server itself can connect.',
            },
            pending: {
              type: 'boolean',
              description:
                'The server was told the new setting and has not confirmed it yet (still applying, offline, or the push failed). Retried automatically.',
            },
            otherClusters: {
              type: 'integer',
              description: 'Other clusters on this server that the setting also covers.',
            },
          },
        },
      },
    },
  },
  ManagedPatchResponse: {
    type: 'object',
    required: ['ok', 'managed', 'settings'],
    properties: {
      ok: { type: 'boolean', const: true },
      managed: { $ref: '#/components/schemas/ManagedEnvironmentRow' },
      settings: { $ref: '#/components/schemas/ManagedSettings' },
    },
  },
  ServerManagedExternalAccessSaved: {
    type: 'object',
    required: ['ok', 'enabled', 'pending', 'clusterCount'],
    properties: {
      ok: { type: 'boolean', const: true },
      enabled: { type: 'boolean' },
      pending: {
        type: 'boolean',
        description: 'The server was told and has not confirmed yet. Retried automatically.',
      },
      clusterCount: { type: 'integer' },
    },
  },
  ServerManagedExternalAccessPushFailed: {
    type: 'object',
    required: ['error', 'message', 'enabled', 'pending', 'clusterCount'],
    description: 'The setting is saved; the server has not been told yet.',
    properties: {
      error: { type: 'string', const: 'ingress_reconcile_failed' },
      message: { type: 'string' },
      enabled: { type: 'boolean' },
      pending: { type: 'boolean', const: true },
      clusterCount: { type: 'integer' },
    },
  },
  ServerManagedExternalAccess: {
    type: 'object',
    required: ['enabled', 'pending', 'clusterCount'],
    properties: {
      enabled: {
        type: 'boolean',
        description:
          "Yes: the databases on this server are published beyond the server (every address; the firewall and network rules decide who can reach them). No (the default): only services on the server itself can connect, either sites run by a site owner's Linux user through 127.0.0.1 or containers bound to the cluster over the managed Docker network.",
      },
      pending: {
        type: 'boolean',
        description: 'The server was told and has not confirmed yet. Retried automatically.',
      },
      clusterCount: {
        type: 'integer',
        description: 'Managed clusters on this server that the setting covers.',
      },
    },
  },
  ManagedRecoveryRecord: {
    type: 'object',
    required: [
      'id',
      'kind',
      'state',
      'sourcePrimaryMemberId',
      'targetMemberId',
      'startedAt',
      'completedAt',
      'blockedReason',
      'needsOperator',
      'failedReason',
      'lagBytes',
      'sourceDatacenterId',
      'targetDatacenterId',
      'sourceServerId',
      'targetServerId',
      'freshStandby',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      kind: {
        type: 'string',
        enum: ['automatic-failover', 'switchover', 'disaster-recovery'],
      },
      state: {
        type: 'string',
        enum: [
          'detecting',
          'fencing',
          'promoting',
          'repointing',
          'reconciling-ingress',
          'verifying',
          'completed',
          'failed',
          'blocked',
        ],
      },
      sourcePrimaryMemberId: { type: 'string', format: 'uuid' },
      targetMemberId: { type: 'string', format: 'uuid', nullable: true },
      startedAt: { type: 'string', format: 'date-time' },
      completedAt: { type: 'string', format: 'date-time', nullable: true },
      blockedReason: { type: 'string', nullable: true },
      needsOperator: {
        type: 'boolean',
        description:
          'True on a terminal `failed` row that nothing will advance (a command was lost or a step after the role change failed): the cluster may be half way through a role change, so an operator has to check which member is the writer before the next one.',
      },
      failedReason: {
        type: 'string',
        nullable: true,
        description: 'Why a `needsOperator` recovery stopped; `null` otherwise.',
      },
      lagBytes: { type: 'number', nullable: true },
      sourceDatacenterId: { type: 'string', format: 'uuid', nullable: true },
      targetDatacenterId: { type: 'string', format: 'uuid', nullable: true },
      sourceServerId: { type: 'string', format: 'uuid', nullable: true },
      targetServerId: { type: 'string', format: 'uuid', nullable: true },
      freshStandby: {
        type: 'string',
        nullable: true,
        description:
          'Automatic failover only: the event-time fresh-standby verdict per probed replica (accepted basis or refusal reason).',
      },
    },
  },
  CreateManagedRequest: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Optional name; defaults to the environment name',
      },
      engineSeries: {
        type: 'string',
        description:
          'Optional engine series (major version, for example `18`). Only tested series are accepted; omitted = the engine default. A non-string answers 400; an unknown or untested series answers 422 `managed_version_unsupported`.',
      },
      imageVariant: {
        type: 'string',
        description:
          'Optional base-OS image variant of the series (for example `alpine` or `debian`). Alone, it selects that variant of the default series; omitted = the first variant of the series. A non-string answers 400; an unknown variant answers 422 `managed_version_unsupported`.',
      },
    },
  },
  CreateManagedResponse: {
    type: 'object',
    required: ['ok', 'managed'],
    properties: {
      ok: { type: 'boolean', const: true },
      alreadyProvisioned: {
        type: 'boolean',
        description: 'True when an existing managed row was returned unchanged',
      },
      managed: { $ref: '#/components/schemas/ManagedEnvironmentRow' },
      commandId: {
        type: 'string',
        description: 'Present when a `managed.apply` command was enqueued',
      },
      serverId: { type: 'string' },
      rootPassword: {
        type: 'string',
        description: 'Show-once plaintext root password — returned only on first create',
      },
    },
  },
  ManagedApplyResponse: {
    type: 'object',
    required: ['ok', 'commandId', 'serverId'],
    properties: {
      ok: { type: 'boolean', const: true },
      commandId: { type: 'string' },
      serverId: { type: 'string' },
      status: { type: 'string', const: 'queued' },
      results: {
        type: 'array',
        description: 'One entry per member the command was fanned out to.',
        items: { $ref: '#/components/schemas/ManagedMemberEnqueueResult' },
      },
    },
  },
  ManagedMemberEnqueueResult: {
    type: 'object',
    required: ['memberId', 'serverId', 'status'],
    properties: {
      memberId: { type: 'string', format: 'uuid' },
      serverId: { type: 'string', format: 'uuid' },
      commandId: { type: 'string' },
      status: { type: 'string', enum: ['queued', 'failed'] },
      error: {
        type: 'string',
        description:
          'Set when `status` is `failed`. `managed_member_needs_resync`: a start or restart skipped a demoted old primary that still holds a writable data directory; resync it first (stop is always allowed).',
      },
    },
  },
  ManagedLifecycleRequest: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['start', 'stop', 'restart'] },
    },
  },
  ManagedDeleteResponse: {
    type: 'object',
    required: ['ok', 'deleted'],
    properties: {
      ok: { type: 'boolean', const: true },
      deleted: {
        type: 'boolean',
        description:
          'True when the row was hard-deleted (unplaced cluster); false when `managed.destroy` was enqueued for a placed cluster',
      },
      commandId: { type: 'string' },
      serverId: { type: 'string' },
      detached: {
        type: 'array',
        items: { type: 'object' },
        description:
          'Present when `detach=true` and services were bound: the services (`serviceId`, `name`, `environmentId`, `projectId`, `keyPrefix`) whose bindings and database variables go with the cluster. Removed at once on a forced or unplaced delete; otherwise removed only when the queued destroy succeeds (a destroy that fails leaves the cluster and its bindings in place)',
      },
    },
  },
  ManagedRootPasswordResponse: {
    type: 'object',
    required: ['ok', 'rootPassword'],
    properties: {
      ok: { type: 'boolean', const: true },
      rootPassword: {
        type: 'string',
        description: 'Show-once plaintext root password',
      },
      commandId: { type: 'string' },
      serverId: { type: 'string' },
      results: { type: 'array', items: { type: 'object' } },
      redeployRequired: {
        $ref: '#/components/schemas/ManagedRedeployRequired',
        description:
          'Services whose binding-materialized variables still carry the old password; API never redeploys',
      },
    },
  },
  ManagedRedeployRequired: {
    type: 'object',
    required: ['count', 'services'],
    properties: {
      count: { type: 'integer' },
      services: {
        type: 'array',
        items: {
          type: 'object',
          required: ['serviceId', 'environmentId', 'projectId', 'keyPrefix'],
          properties: {
            serviceId: { type: 'string' },
            name: { type: ['string', 'null'] },
            environmentId: { type: 'string' },
            projectId: { type: 'string' },
            keyPrefix: { type: 'string' },
          },
        },
      },
    },
  },
  ManagedUserPasswordResponse: {
    type: 'object',
    required: ['ok', 'password'],
    properties: {
      ok: { type: 'boolean', const: true },
      password: {
        type: 'string',
        description: 'Show-once plaintext user password',
      },
      commandId: { type: 'string' },
      serverId: { type: 'string' },
      results: { type: 'array', items: { type: 'object' } },
      redeployRequired: {
        $ref: '#/components/schemas/ManagedRedeployRequired',
      },
    },
  },
  ManagedUserRecord: {
    type: 'object',
    required: ['id', 'username', 'appliedUsername', 'databases', 'privileges', 'createdAt'],
    properties: {
      id: {
        type: 'string',
        description: 'The principal id; the routes under /managed/users address a user by it.',
      },
      principalId: {
        type: ['string', 'null'],
        description: 'The principal (identity) the login belongs to.',
      },
      loginId: { type: 'string', description: 'The database login on this cluster.' },
      username: { type: 'string' },
      appliedUsername: {
        type: 'string',
        description:
          'Engine login actually created (the system name): per nameScheme it equals the typed username (plain), adds a random _<11 chars> suffix (partial) or is fully random. Connect with this name.',
      },
      nameScheme: {
        type: 'string',
        enum: ['plain', 'partial', 'random'],
        description: 'Scheme the system name was derived with.',
      },
      databases: { type: 'array', items: { type: 'string' } },
      privileges: { type: 'array', items: { type: 'string' } },
      connectionRole: {
        type: 'string',
        enum: ['read-write', 'read-only'],
        description:
          'Where the login is routed: `read-write` to the primary, `read-only` to read replicas (or the primary when the cluster has none).',
      },
      grantMode: {
        type: 'string',
        enum: ['preset', 'recipe', 'self'],
        description:
          "Who sets the login's permissions. `preset` = logins made before modes existed (the panel resets permissions on every apply, as before). `recipe` = the panel sets them. `self` = you set them by hand and the panel never resets them; it still owns the password, LOGIN, connection limit and CONNECT on the listed databases.",
      },
      tool: {
        type: 'boolean',
        description:
          'A database-tool login: everything goes to the primary, never split between reader and writer.',
      },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  PrivilegeCatalogueResponse: {
    type: 'object',
    required: [
      'engine',
      'series',
      'levels',
      'privileges',
      'roles',
      'attributes',
      'membershipOptions',
      'defaultPrivilegeObjects',
      'blocked',
    ],
    description:
      "Everything the cluster's exact engine series can grant, in plain words. Only series the panel supports have a catalogue.",
    properties: {
      engine: { type: 'string', enum: ['postgres', 'mysql', 'mariadb'] },
      series: { type: 'string', description: 'Engine series, for example 18, 9.7 or 11.8.' },
      levels: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'label', 'explanation'],
          properties: {
            id: {
              type: 'string',
              enum: [
                'global',
                'database',
                'schema',
                'table',
                'column',
                'sequence',
                'routine',
                'type',
                'parameter',
                'tablespace',
                'language',
                'foreign',
                'largeobject',
              ],
            },
            label: { type: 'string' },
            explanation: { type: 'string' },
          },
        },
      },
      privileges: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'level', 'keyword', 'label', 'explanation', 'allowed', 'grid'],
          properties: {
            id: { type: 'string', description: '`<level>:<keyword>`, for example `table:SELECT`.' },
            level: { type: 'string' },
            keyword: { type: 'string', description: 'The word used in GRANT.' },
            aliases: { type: 'array', items: { type: 'string' } },
            label: { type: 'string' },
            explanation: { type: 'string' },
            since: { type: 'string', description: 'First series that has it, when not all.' },
            allowed: {
              type: 'string',
              enum: ['yes', 'needs-admin', 'no'],
              description:
                "Whether a site owner's login may hold it: `yes`, `needs-admin` (reserved for a Database admin login) or `no` (never).",
            },
            reason: { type: 'string' },
            aclLetter: { type: 'string', description: 'Postgres access-list letter.' },
            grid: { type: 'boolean', description: 'False when it never shows as a grid cell.' },
          },
        },
      },
      roles: {
        type: 'array',
        description: 'Postgres predefined roles. Empty for MySQL and MariaDB.',
        items: {
          type: 'object',
          required: ['name', 'label', 'explanation', 'grantable', 'allowed'],
          properties: {
            name: { type: 'string' },
            label: { type: 'string' },
            explanation: { type: 'string' },
            since: { type: 'string' },
            grantable: { type: 'boolean' },
            allowed: { type: 'string', enum: ['yes', 'needs-admin', 'no'] },
            reason: { type: 'string' },
          },
        },
      },
      attributes: {
        type: 'array',
        description: 'Postgres role attributes. Empty for MySQL and MariaDB.',
        items: {
          type: 'object',
          required: ['name', 'column', 'label', 'explanation', 'allowed'],
          properties: {
            name: { type: 'string' },
            column: { type: 'string' },
            label: { type: 'string' },
            explanation: { type: 'string' },
            allowed: { type: 'string', enum: ['yes', 'needs-admin', 'no'] },
            reason: { type: 'string' },
          },
        },
      },
      membershipOptions: {
        type: 'array',
        description: 'Options on a Postgres role membership (INHERIT and SET exist from 16).',
        items: { type: 'object' },
      },
      defaultPrivilegeObjects: {
        type: 'array',
        description: 'Object kinds Postgres default privileges can name.',
        items: { type: 'object' },
      },
      blocked: {
        type: 'object',
        required: ['databases', 'schemas', 'reservedPrefixes'],
        properties: {
          databases: { type: 'array', items: { type: 'string' } },
          schemas: { type: 'array', items: { type: 'string' } },
          reservedPrefixes: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  PrivilegeCatalogueUnsupportedError: {
    type: 'object',
    required: ['error', 'message'],
    properties: {
      error: { type: 'string', const: 'privilege_catalogue_unsupported_version' },
      message: { type: 'string' },
    },
  },
  ManagedUsersResponse: {
    type: 'object',
    required: ['users'],
    properties: {
      users: {
        type: 'array',
        items: { $ref: '#/components/schemas/ManagedUserRecord' },
      },
    },
  },
  CreateManagedUserRequest: {
    type: 'object',
    required: ['databases'],
    properties: {
      username: {
        type: 'string',
        description:
          'Name for a new principal and login. Required unless `principalId` is given; ignored when it is.',
      },
      principalId: {
        type: 'string',
        description:
          "Create a login for an existing principal of the organization instead of a new one. The engine role takes the principal's own name, so it must be a valid role name for the engine (422 `principal_name_does_not_fit` or `principal_name_reserved` otherwise); 404 `principal_not_found` for an unknown principal; 409 `managed_login_exists` when it already has a login on this cluster.",
      },
      databases: { type: 'array', items: { type: 'string' } },
      privileges: {
        type: 'array',
        items: { type: 'string', enum: ['owner', 'read-write', 'read-only'] },
        description:
          'What the login may do in each listed database. Omitted = `read-only` for a `read-only` connectionRole, otherwise `read-write`. An empty list or an unknown name answers 400 `managed_user_privileges_invalid`, because a login with no grants can connect but is refused everywhere.',
      },
      connectionRole: {
        type: 'string',
        enum: ['read-write', 'read-only'],
        description: 'Default `read-write`.',
      },
      grantMode: {
        type: 'string',
        enum: ['recipe', 'self'],
        description:
          'Default `recipe` (the panel sets permissions). `self` = you set permissions yourself and the panel never resets them. Anything else answers 400 `managed_grant_mode_invalid`.',
      },
      tool: {
        type: 'boolean',
        description: 'Mark the login as used by a database tool: routed to the primary only.',
      },
      nameScheme: {
        type: 'string',
        enum: ['plain', 'partial', 'random'],
        description:
          'Name scheme for the system name (the login on the host or engine): plain = the typed name, partial = typed name + _<11 random chars> (platform default), random = fully random with no trace of the typed name. Omit to use the organization default. The server derives the system name; clients never supply it. When the organization locks the scheme, asking for a different one returns 409 principal_scheme_locked.',
      },
    },
  },
  CreateManagedUserResponse: {
    type: 'object',
    required: ['ok', 'user', 'password', 'commandId', 'serverId'],
    properties: {
      ok: { type: 'boolean', const: true },
      user: { $ref: '#/components/schemas/ManagedUserRecord' },
      password: {
        type: 'string',
        description: 'Show-once plaintext password',
      },
      commandId: { type: 'string' },
      serverId: { type: 'string' },
    },
  },
  ManagedDatabasesResponse: {
    type: 'object',
    required: ['databases'],
    properties: {
      databases: { type: 'array', items: { type: 'string' } },
    },
  },
  CreateManagedDatabaseRequest: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
    },
  },
  ManagedDatabaseMutationResponse: {
    type: 'object',
    required: ['ok', 'databases', 'commandId', 'serverId'],
    properties: {
      ok: { type: 'boolean', const: true },
      databases: { type: 'array', items: { type: 'string' } },
      commandId: { type: 'string' },
      serverId: { type: 'string' },
    },
  },
  ManagedStatusResponse: {
    type: 'object',
    required: ['status', 'host', 'port', 'containers', 'members'],
    properties: {
      status: { type: 'string', nullable: true },
      host: { type: 'string', nullable: true },
      port: { type: 'number', nullable: true },
      error: {
        type: 'string',
        nullable: true,
        description:
          'Latest apply-family and/or ingress reconcile failure when status is failed; otherwise null.',
      },
      healthRefresh: {
        type: 'object',
        description:
          'Present only when `?refresh=1` was sent: how many replica probes returned a fresh reading (`observed`) and how many kept the stored observation (`unavailable`: daemon offline, without `managed-health-v1`, timed out, or errored).',
        required: ['observed', 'unavailable'],
        properties: {
          observed: { type: 'integer' },
          unavailable: { type: 'integer' },
        },
      },
      containers: {
        type: 'array',
        items: { $ref: '#/components/schemas/ContainerRow' },
      },
      members: {
        type: 'array',
        items: {
          type: 'object',
          required: ['memberId', 'serverId', 'role'],
          properties: {
            memberId: { type: 'string' },
            serverId: { type: 'string' },
            role: { type: 'string', enum: ['primary', 'replica'] },
            replicaClass: {
              type: 'string',
              nullable: true,
              enum: ['failover', 'read'],
            },
            status: { type: 'string', nullable: true },
            replicationTransport: {
              type: 'string',
              nullable: true,
              enum: ['local', 'datacenter', 'fabric', 'public'],
            },
          },
        },
      },
    },
  },
  ManagedLogsResponse: {
    type: 'object',
    required: ['logs'],
    properties: {
      logs: { type: 'string' },
    },
  },
  OrganizationManagedListItem: {
    type: 'object',
    required: [
      'id',
      'engine',
      'engineDisplayName',
      'name',
      'projectId',
      'projectName',
      'environmentId',
      'environmentName',
      'serverId',
      'serverName',
      'status',
      'host',
      'port',
      'createdAt',
    ],
    properties: {
      id: { type: 'string' },
      engine: { type: 'string', nullable: true },
      engineDisplayName: { type: 'string', nullable: true },
      name: { type: 'string', nullable: true },
      projectId: { type: 'string' },
      projectName: { type: 'string', nullable: true },
      environmentId: { type: 'string' },
      environmentName: { type: 'string', nullable: true },
      serverId: { type: 'string', nullable: true },
      serverName: { type: 'string', nullable: true },
      status: { type: 'string', nullable: true },
      host: { type: 'string', nullable: true },
      port: { type: 'number', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      members: {
        type: 'array',
        items: { $ref: '#/components/schemas/ManagedMember' },
      },
    },
  },
  OrganizationManagedListResponse: {
    type: 'object',
    required: ['managed'],
    properties: {
      managed: {
        type: 'array',
        items: { $ref: '#/components/schemas/OrganizationManagedListItem' },
      },
    },
  },
  ManagedBackupRecord: {
    type: 'object',
    required: ['id', 'createdAt', 'sizeBytes', 'checksum', 'path'],
    properties: {
      id: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      sizeBytes: { type: 'integer' },
      checksum: {
        type: 'string',
        description: 'SHA-256 hex digest of the artifact',
      },
      database: { type: 'string' },
      path: {
        type: 'string',
        description: 'Daemon-local artifact path — never a downloadable URL',
      },
      retentionId: {
        type: 'string',
        format: 'uuid',
        description: 'The backup schedule whose run made this artifact; absent for a manual backup',
      },
      storedOnServerId: {
        type: 'string',
        format: 'uuid',
        description:
          'Host that holds the on-disk artifact (the primary when the backup ran). Absent on older records.',
      },
    },
  },
  ManagedBackupsResponse: {
    type: 'object',
    required: ['backups'],
    properties: {
      backups: {
        type: 'array',
        items: { $ref: '#/components/schemas/ManagedBackupRecord' },
        description: 'Newest first',
      },
    },
  },
  CreateManagedBackupRequest: {
    type: 'object',
    properties: {
      database: {
        type: 'string',
        description: 'Must be one of the managed databases; defaults to the initial database',
      },
    },
  },
  CreateManagedBackupResponse: {
    type: 'object',
    required: ['ok', 'backupId', 'commandId', 'serverId'],
    properties: {
      ok: { type: 'boolean', const: true },
      backupId: { type: 'string' },
      commandId: { type: 'string' },
      serverId: { type: 'string' },
    },
  },
  ManagedBackupCommandResponse: {
    type: 'object',
    required: ['ok', 'commandId', 'serverId'],
    properties: {
      ok: { type: 'boolean', const: true },
      commandId: { type: 'string' },
      serverId: { type: 'string' },
    },
  },
  BackupSchedulePreset: {
    description:
      'A preset schedule. Stored as cron (`0 * * * *`, `<m> <h> * * *`, `<m> <h> * * <dow>`) and read back out for display.',
    oneOf: [
      {
        type: 'object',
        required: ['preset'],
        properties: { preset: { type: 'string', const: 'hourly' } },
      },
      {
        type: 'object',
        required: ['preset', 'time'],
        properties: {
          preset: { type: 'string', const: 'daily' },
          time: { type: 'string', description: 'HH:MM, 24-hour' },
        },
      },
      {
        type: 'object',
        required: ['preset', 'day', 'time'],
        properties: {
          preset: { type: 'string', const: 'weekly' },
          day: {
            type: 'string',
            enum: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
          },
          time: { type: 'string', description: 'HH:MM, 24-hour' },
        },
      },
    ],
  },
  BackupRun: {
    type: 'object',
    required: ['runId', 'serverId', 'startedAt', 'finishedAt', 'status', 'error', 'backupId'],
    properties: {
      runId: { type: 'string' },
      serverId: { type: 'string' },
      startedAt: { type: 'string', format: 'date-time' },
      finishedAt: { type: 'string', format: 'date-time' },
      status: { type: 'string', enum: ['succeeded', 'failed'] },
      error: { type: ['string', 'null'] },
      backupId: {
        type: ['string', 'null'],
        description: 'The `bk_` id of the artifact; null when the run failed',
      },
    },
  },
  BackupPolicy: {
    type: 'object',
    required: [
      'id',
      'name',
      'targetKind',
      'managedId',
      'copyId',
      'schedule',
      'preset',
      'timezone',
      'retentionKeep',
      'enabled',
      'automatic',
      'nextRunAt',
      'lastRun',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      targetKind: { type: 'string', enum: ['managed', 'copy'] },
      managedId: {
        type: ['string', 'null'],
        format: 'uuid',
        description: 'The managed engine a `managed` policy backs up; null for a copy',
      },
      copyId: {
        type: ['string', 'null'],
        format: 'uuid',
        description: 'The storage copy a `copy` policy backs up; null for an engine',
      },
      schedule: { type: 'string', description: 'Cron text as stored' },
      preset: {
        oneOf: [
          { $ref: '#/components/schemas/BackupSchedulePreset' },
          {
            type: 'null',
          },
        ],
        description: 'The preset this schedule matches; null for custom cron',
      },
      timezone: {
        type: ['string', 'null'],
        description: 'IANA zone; null means the host local time',
      },
      retentionKeep: { type: 'integer', minimum: 1 },
      enabled: { type: 'boolean' },
      automatic: {
        type: 'boolean',
        description: 'True for the daily policy created with the engine',
      },
      nextRunAt: {
        type: ['string', 'null'],
        format: 'date-time',
        description: 'As last reported by the host; null until a report arrives',
      },
      lastRun: {
        oneOf: [{ $ref: '#/components/schemas/BackupRun' }, { type: 'null' }],
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  BackupPoliciesResponse: {
    type: 'object',
    required: ['policies'],
    properties: {
      policies: {
        type: 'array',
        items: { $ref: '#/components/schemas/BackupPolicy' },
        description: 'Oldest first',
      },
    },
  },
  BackupScheduleInput: {
    description: 'A preset object, or cron text (5 fields or an @alias; @reboot is refused)',
    oneOf: [
      { $ref: '#/components/schemas/BackupSchedulePreset' },
      {
        type: 'string',
      },
    ],
  },
  CreateBackupPolicyRequest: {
    type: 'object',
    required: ['name', 'schedule', 'retentionKeep'],
    properties: {
      name: { type: 'string', maxLength: 64 },
      schedule: { $ref: '#/components/schemas/BackupScheduleInput' },
      timezone: { type: ['string', 'null'] },
      retentionKeep: {
        type: 'integer',
        minimum: 1,
        description: "Up to the engine's own maximum",
      },
      enabled: { type: 'boolean', default: true },
      targetKind: {
        type: 'string',
        enum: ['managed', 'copy'],
        description:
          'Optional. Must match the route: `managed` on the managed-engine route, `copy` on the storage-copy route (`/storage/{id}/copies/{copyId}/backup-policies`). A mismatch is refused with `backup_target_unsupported`.',
      },
    },
  },
  UpdateBackupPolicyRequest: {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: 64 },
      schedule: { $ref: '#/components/schemas/BackupScheduleInput' },
      timezone: {
        type: ['string', 'null'],
        description: 'null clears it (host local time)',
      },
      retentionKeep: { type: 'integer', minimum: 1 },
      enabled: { type: 'boolean' },
    },
  },
  BackupsReconcileOutcome: {
    type: 'object',
    required: ['queuedServerIds', 'failedServerIds'],
    description:
      'Best-effort push of the full policy set to the engine host. A failed server catches up on its next reconnect.',
    properties: {
      queuedServerIds: { type: 'array', items: { type: 'string' } },
      failedServerIds: { type: 'array', items: { type: 'string' } },
    },
  },
  BackupPolicyResponse: {
    type: 'object',
    required: ['policy', 'reconcile'],
    properties: {
      policy: { $ref: '#/components/schemas/BackupPolicy' },
      reconcile: {
        oneOf: [
          { $ref: '#/components/schemas/BackupsReconcileOutcome' },
          {
            type: 'null',
          },
        ],
        description: 'null when the change did not affect what the host runs (a rename)',
      },
    },
  },
  DeleteBackupPolicyResponse: {
    type: 'object',
    required: ['ok', 'reconcile'],
    properties: {
      ok: { type: 'boolean', const: true },
      reconcile: { $ref: '#/components/schemas/BackupsReconcileOutcome' },
    },
  },
  BackupRunsResponse: {
    type: 'object',
    required: ['runs'],
    properties: {
      runs: {
        type: 'array',
        items: { $ref: '#/components/schemas/BackupRun' },
        description: 'Newest first',
      },
    },
  },
  BackupPolicyInvalidError: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'string',
        enum: [
          'backup_policy_invalid',
          'backup_schedule_invalid',
          'backup_timezone_invalid',
          'backup_target_unsupported',
          'managed_backup_unsupported',
        ],
      },
      field: { type: 'string' },
      detail: { type: 'string' },
    },
  },
  BackupPolicyNotFoundError: errorSchema('backup_policy_not_found'),
  BackupPolicyLimitError: {
    type: 'object',
    required: ['error', 'limit'],
    properties: {
      error: { type: 'string', const: 'backup_policy_limit' },
      limit: { type: 'integer' },
    },
  },
  ManagedBusyError: {
    type: 'object',
    required: ['error'],
    properties: {
      error: { type: 'string', const: 'managed_busy' },
      reason: {
        type: 'string',
        enum: ['recovery_in_flight'],
        description:
          'Present when the cluster is not `applying` but an HA recovery (failover, switchover or disaster recovery) is still fencing or promoting in the journal. Every mutating managed route answers it until the recovery reaches a terminal state.',
      },
    },
  },
  ManagedSslMinimumRefusal: {
    type: 'object',
    required: ['error', 'message'],
    description:
      'While a server allows external access, every database it serves must use SSL mode require or stronger. Nothing is saved.',
    properties: {
      error: {
        type: 'string',
        enum: [
          'managed_ssl_external_access_minimum',
          'managed_ssl_default_external_access_minimum',
          'external_access_weak_ssl',
        ],
      },
      message: { type: 'string', description: 'Plain-words explanation of the refusal.' },
      servers: {
        type: 'array',
        items: { type: 'string' },
        description:
          '`managed_ssl_external_access_minimum`: the servers serving this database that allow external access.',
      },
      databases: {
        type: 'array',
        items: { type: 'string' },
        description:
          "The other two codes: the databases that would accept connections without SSL. For `external_access_weak_ssl`, only the server owner's own databases.",
      },
      otherDatabases: {
        type: 'integer',
        description:
          '`external_access_weak_ssl`: how many databases of other organizations on the server (granted placements) would accept connections without SSL. Counted, never named.',
      },
    },
  },
  ManagedImageRefusalError: {
    type: 'object',
    required: ['error', 'message'],
    properties: {
      error: {
        type: 'string',
        enum: ['managed_series_immutable', 'managed_variant_swap_unsafe'],
      },
      message: {
        type: 'string',
        description: 'Plain-words explanation of the refusal.',
      },
    },
  },
  ManagedVersionUnsupportedError: errorSchema('managed_version_unsupported'),
  ServerPlacementRequiredError: errorSchema('server_placement_required'),
  ServerOfflineError: errorSchema('server_offline'),
  ManagedSettingsInvalidError: errorSchema('managed_settings_invalid'),
  NotManagedEnvironmentError: errorSchema('not_managed_environment'),
  ManagedEngineUnavailableError: errorSchema('managed_engine_unavailable'),
  ManagedUserExistsError: errorSchema('managed_user_exists'),
  UsernameInUseError: errorSchema('username_in_use'),
  ManagedMemberExistsError: errorSchema('managed_member_exists'),
  ManagedMemberIsPrimaryError: errorSchema('managed_member_is_primary'),
  ManagedReplicaNotPromotableError: errorSchema('managed_replica_not_promotable'),
  ManagedAutomaticFailoverBlockedError: errorSchema('managed_automatic_failover_blocked'),
  FailoverReplicaRequiresDatacenterTransportError: errorSchema(
    'failover_replica_requires_datacenter_transport'
  ),
  DatacenterRequiredError: errorSchema('datacenter_required'),
  DatacenterCidrRequiredError: errorSchema('datacenter_cidr_required'),
  PrivatePathUnavailableError: errorSchema('private_path_unavailable'),
  FailoverRequiresTrustedDatacenterError: errorSchema('failover_requires_trusted_datacenter'),
  ManagedFailoverUnsupportedError: {
    type: 'object',
    required: ['error', 'code'],
    properties: {
      error: {
        type: 'string',
        description:
          'Plain-words reason. MariaDB 12.3 can run on one server; automatic failover needs MariaDB 11.8 for now.',
      },
      code: { type: 'string', const: 'managed_failover_unsupported' },
    },
  },
  ManagedBackupUnsupportedError: errorSchema('managed_backup_unsupported'),
  BackupNotFoundError: errorSchema('backup_not_found'),
  BackupOnOtherServerError: {
    type: 'object',
    required: ['error', 'message'],
    properties: {
      error: { type: 'string', const: 'backup_on_other_server' },
      message: {
        type: 'string',
        description:
          'The artifact is on a former primary. Restore it there, take a new backup, or switch back first.',
      },
    },
  },
  ManagedReplicaNotStreamingError: errorSchema('managed_replica_not_streaming'),
  ManagedReplicaLaggingError: errorSchema('managed_replica_lagging'),
  ManagedReplicaHealthStaleError: errorSchema('managed_replica_health_stale'),
  ManagedReplicaLiveCheckFailedError: {
    type: 'object',
    required: ['error', 'message'],
    properties: {
      error: { type: 'string', const: 'managed_replica_live_check_failed' },
      message: {
        type: 'string',
        description:
          'The replica did not answer a live check, so it cannot be proven caught up. Try again, or force the promote if you accept possible data loss.',
      },
    },
  },
}

export const managedPaths = {
  '/api/client/v1/servers/{id}/managed-external-access': {
    get: {
      tags: ['Managed services'],
      summary: 'Get "allow external access to the databases on this server"',
      description:
        'Owners and managers only; a server of another organization is 404. One setting for the whole server, because one connection listener serves every managed cluster on it. Default no.',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ],
      responses: {
        200: {
          description: 'The setting',
          ...jsonSchema('ServerManagedExternalAccess'),
        },
        403: { description: 'Not an owner or manager of the server' },
        404: { description: 'Server not found in the caller organization' },
      },
    },
    put: {
      tags: ['Managed services'],
      summary: 'Set "allow external access to the databases on this server"',
      description:
        "Owners and managers only. No (the default): only services on the server itself can connect (sites run by a site owner's Linux user through 127.0.0.1 on port 13306 for MySQL/MariaDB or 15432 for Postgres, and bound containers over the managed Docker network). Yes: those ports are published on all the server's addresses; the firewall and network rules decide who can then reach them. Saving tells the server at once; a push that cannot be queued answers 502 `ingress_reconcile_failed` (saved, retried automatically).",
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
              required: ['enabled'],
              properties: { enabled: { type: 'boolean' } },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Saved',
          ...jsonSchema('ServerManagedExternalAccessSaved'),
        },
        400: {
          description: '`invalid_external_access`: `enabled` is not a boolean',
        },
        403: { description: 'Not an owner or manager of the server' },
        404: { description: 'Server not found in the caller organization' },
        409: {
          description:
            '`external_access_weak_ssl`: turning it on is refused while a database on the server uses an SSL mode weaker than require; `databases` names them. Turning it off is never refused.',
          ...jsonSchema('ManagedSslMinimumRefusal'),
        },
        422: {
          description: '`daemon_key_unavailable`: the server cannot take changes yet',
        },
        502: {
          description: 'Saved, but the server could not be told yet; retried automatically',
          ...jsonSchema('ServerManagedExternalAccessPushFailed'),
        },
        503: {
          description: 'Command queue or daemon cell registry unavailable',
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed': {
    get: {
      tags: ['Managed services'],
      summary: 'Get managed service detail for an environment',
      parameters: [ENV_ID_PARAM],
      responses: {
        200: {
          description: 'Managed detail (connection never includes a password)',
          ...jsonSchema('ManagedDetailResponse'),
        },
      },
    },
    post: {
      tags: ['Managed services'],
      summary: 'Create / provision a managed engine on an environment',
      description:
        'Requires organization:manage and `environment.server_id`. Returns show-once `rootPassword` on first create. Idempotent thereafter.',
      parameters: [ENV_ID_PARAM],
      requestBody: {
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateManagedRequest' },
          },
        },
      },
      responses: {
        200: {
          description: 'Managed service created or already provisioned',
          ...jsonSchema('CreateManagedResponse'),
        },
        400: {
          description:
            'not_managed_environment / managed_engine_unavailable / managed_settings_invalid; also `Invalid engineSeries` / `Invalid imageVariant` when either is not a string',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/NotManagedEnvironmentError' },
                  {
                    $ref: '#/components/schemas/ManagedEngineUnavailableError',
                  },
                  { $ref: '#/components/schemas/ManagedSettingsInvalidError' },
                ],
              },
            },
          },
        },
        422: {
          description:
            'managed_version_unsupported (the requested engineSeries / imageVariant is unknown or not a tested version; nothing is created)',
          ...jsonSchema('ManagedVersionUnsupportedError'),
        },
        409: {
          description: 'server_placement_required / server_offline / managed_busy',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/ServerPlacementRequiredError' },
                  { $ref: '#/components/schemas/ServerOfflineError' },
                  { $ref: '#/components/schemas/ManagedBusyError' },
                ],
              },
            },
          },
        },
      },
    },
    patch: {
      tags: ['Managed services'],
      summary: 'Update managed settings (does not apply)',
      description:
        'Saves settings and, optionally, the cluster `name` (a label only; `null` clears it). Settings reach the engine on the next apply. Who can reach the database from outside the server is not a cluster setting: it is the server\'s "allow external access" setting (`/servers/{id}/managed-external-access`).',
      parameters: [ENV_ID_PARAM],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                settings: { $ref: '#/components/schemas/ManagedSettings' },
                name: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Settings persisted',
          ...jsonSchema('ManagedPatchResponse'),
        },
        400: {
          description: 'managed_settings_invalid, or a name that is not valid (Invalid request)',
          ...jsonSchema('ManagedSettingsInvalidError'),
        },
        409: {
          description:
            'managed_busy, or an image change that is refused before anything is written: managed_series_immutable (the engine series cannot change on an existing cluster; create a new cluster and restore a backup into it) / managed_variant_swap_unsafe (PostgreSQL alpine <-> debian would corrupt text indexes); both carry a `message`. Also managed_ssl_external_access_minimum: a new SSL mode (or following an organization default) weaker than require while a server serving the cluster allows external access.',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/ManagedBusyError' },
                  { $ref: '#/components/schemas/ManagedImageRefusalError' },
                  { $ref: '#/components/schemas/ManagedSslMinimumRefusal' },
                ],
              },
            },
          },
        },
      },
    },
    delete: {
      tags: ['Managed services'],
      summary: 'Destroy managed service (two-step when running)',
      description:
        "Refused with 409 `managed_has_bindings` (and the bound `services`) while any service is bound to one of the cluster's logins. Pass `detach=true` to remove those bindings and their variables with the cluster (when the destroy succeeds; at once on a forced or unplaced delete); the response then lists them in `detached`. New bindings are refused with 409 `managed_busy` (`destroy_in_flight`) while a destroy is queued. Needs the same rights as the destroy itself. The services keep running with the values they already have until their next deploy.",
      parameters: [
        ENV_ID_PARAM,
        {
          name: 'detach',
          in: 'query',
          required: false,
          schema: { type: 'boolean' },
          description:
            "Remove the cluster's service bindings (and their variables) with the cluster, once the destroy succeeds",
        },
      ],
      responses: {
        200: {
          description: 'Hard-deleted or destroy command enqueued',
          ...jsonSchema('ManagedDeleteResponse'),
        },
        409: {
          description: 'managed_busy, or managed_has_bindings (lists `services`)',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/ManagedBusyError' },
                  {
                    type: 'object',
                    required: ['error', 'services'],
                    properties: {
                      error: { type: 'string', const: 'managed_has_bindings' },
                      services: { type: 'array', items: { type: 'object' } },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/apply': {
    post: {
      tags: ['Managed services'],
      summary: 'Enqueue managed.apply',
      parameters: [ENV_ID_PARAM],
      responses: {
        200: {
          description: 'Apply enqueued',
          ...jsonSchema('ManagedApplyResponse'),
        },
        409: {
          description: 'managed_busy / server_offline',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/ManagedBusyError' },
                  { $ref: '#/components/schemas/ServerOfflineError' },
                ],
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/lifecycle': {
    post: {
      tags: ['Managed services'],
      summary: 'Start / stop / restart managed service',
      parameters: [ENV_ID_PARAM],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ManagedLifecycleRequest' },
          },
        },
      },
      responses: {
        200: {
          description: 'Lifecycle command enqueued',
          ...jsonSchema('ManagedApplyResponse'),
        },
        409: {
          description: 'managed_busy / server_offline',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/ManagedBusyError' },
                  { $ref: '#/components/schemas/ServerOfflineError' },
                ],
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/root-password': {
    post: {
      tags: ['Managed services'],
      summary: 'Rotate root password (show-once) and enqueue apply',
      parameters: [ENV_ID_PARAM],
      responses: {
        200: {
          description: 'Rotated',
          ...jsonSchema('ManagedRootPasswordResponse'),
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/privilege-catalogue': {
    get: {
      tags: ['Managed services'],
      summary: "Privilege catalogue for the cluster's engine version",
      description:
        "Read only. Lists every privilege, predefined role and role attribute that exists in the cluster's exact engine series, with a plain-words label and whether a site owner's login may hold it. A series the panel does not support answers 422 `privilege_catalogue_unsupported_version`.",
      parameters: [ENV_ID_PARAM],
      responses: {
        200: {
          description: 'The catalogue for this cluster',
          ...jsonSchema('PrivilegeCatalogueResponse'),
        },
        422: {
          description: 'privilege_catalogue_unsupported_version',
          ...jsonSchema('PrivilegeCatalogueUnsupportedError'),
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/users': {
    get: {
      tags: ['Managed services'],
      summary: 'List managed users (never passwords)',
      parameters: [ENV_ID_PARAM],
      responses: {
        200: {
          description: 'Non-root principals',
          ...jsonSchema('ManagedUsersResponse'),
        },
      },
    },
    post: {
      tags: ['Managed services'],
      summary: 'Create managed user (show-once password) and enqueue apply',
      parameters: [ENV_ID_PARAM],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateManagedUserRequest' },
          },
        },
      },
      responses: {
        200: {
          description: 'User created',
          ...jsonSchema('CreateManagedUserResponse'),
        },
        409: {
          description:
            'managed_user_exists / managed_busy / username_in_use / principal_scheme_locked',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/ManagedUserExistsError' },
                  { $ref: '#/components/schemas/ManagedBusyError' },
                ],
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/users/{principalId}': {
    patch: {
      tags: ['Managed services'],
      summary: 'Change a login (grant mode, databases, connection role, privileges, tool flag)',
      description:
        'Every field is optional. `dryRun: true` changes nothing and returns `statements`, a plain-words list of the kinds of SQL the next apply would run. Refusals: 422 `managed_login_not_editable` (root/replication logins), 422 `managed_grant_mode_invalid_transition` (back to `preset`), 409 `managed_grant_reset_needs_confirm` (self back to panel-set permissions, or a read-only Postgres login moving to self, needs `confirmReset: true`), 422 `managed_self_login_has_no_privileges`, 400 `managed_grant_mode_invalid`.',
      parameters: [ENV_ID_PARAM, PRINCIPAL_ID_PARAM],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                grantMode: { type: 'string', enum: ['recipe', 'self'] },
                tool: { type: 'boolean' },
                databases: { type: 'array', items: { type: 'string' } },
                connectionRole: { type: 'string', enum: ['read-write', 'read-only'] },
                privileges: {
                  type: 'array',
                  items: { type: 'string', enum: ['owner', 'read-write', 'read-only'] },
                },
                confirmReset: { type: 'boolean' },
                dryRun: { type: 'boolean' },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Dry-run preview, or the login updated and an apply enqueued',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok'],
                properties: {
                  ok: { type: 'boolean' },
                  dryRun: { type: 'boolean', description: 'Present and true for a preview.' },
                  grantMode: { type: 'string', enum: ['preset', 'recipe', 'self'] },
                  statements: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Dry run only: plain-words kinds of SQL the next apply runs.',
                  },
                  user: { type: 'object', nullable: true, description: 'The updated login.' },
                  commandId: { type: 'string', description: 'The queued apply command.' },
                },
              },
            },
          },
        },
      },
    },
    delete: {
      tags: ['Managed services'],
      summary: 'Delete managed user and enqueue apply with dropUsers',
      parameters: [ENV_ID_PARAM, PRINCIPAL_ID_PARAM],
      responses: {
        200: {
          description: 'User deleted; apply enqueued',
          ...jsonSchema('ManagedApplyResponse'),
        },
        409: {
          description: 'managed_user_has_bindings',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: { type: 'string', const: 'managed_user_has_bindings' },
                  services: {
                    type: 'array',
                    items: { type: 'object' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/users/{principalId}/password': {
    post: {
      tags: ['Managed services'],
      summary: 'Rotate a managed user password (show-once), re-materialize bindings, enqueue apply',
      parameters: [ENV_ID_PARAM, PRINCIPAL_ID_PARAM],
      responses: {
        200: {
          description: 'Rotated',
          ...jsonSchema('ManagedUserPasswordResponse'),
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/databases': {
    get: {
      tags: ['Managed services'],
      summary: 'List managed databases',
      parameters: [ENV_ID_PARAM],
      responses: {
        200: {
          description: 'Database names',
          ...jsonSchema('ManagedDatabasesResponse'),
        },
      },
    },
    post: {
      tags: ['Managed services'],
      summary: 'Create managed database and enqueue apply',
      parameters: [ENV_ID_PARAM],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/CreateManagedDatabaseRequest',
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Database added',
          ...jsonSchema('ManagedDatabaseMutationResponse'),
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/databases/{name}': {
    delete: {
      tags: ['Managed services'],
      summary: 'Drop managed database and enqueue apply',
      parameters: [ENV_ID_PARAM, DATABASE_NAME_PARAM],
      responses: {
        200: {
          description: 'Database removed',
          ...jsonSchema('ManagedDatabaseMutationResponse'),
        },
        409: {
          description:
            'cannot_drop_initial_database, managed_database_has_bindings (a service binding references the database; lists `services`), or managed_database_has_users (SQL users still list the database; lists their typed usernames in `users`; delete those users first)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: {
                    type: 'string',
                    enum: [
                      'cannot_drop_initial_database',
                      'managed_database_has_bindings',
                      'managed_database_has_users',
                    ],
                  },
                  services: { type: 'array', items: { type: 'object' } },
                  users: { type: 'array', items: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/status': {
    get: {
      tags: ['Managed services'],
      summary: 'Postgres-only managed status + containers',
      description:
        "Database-only by default. With `?refresh=1` (the panel's Refresh button) each replica's daemon is first asked for a fresh replication reading (`managed-health-request`, parallel, best effort, 10s each) and the result is stored before the snapshot is read. The primary is asked too while the cluster has replicas (its answer carries the replication-slot report, so a replica does not keep reading as cut off after a Resync); it is not counted in `healthRefresh`. A daemon that is offline, lacks `managed-health-v1`, or times out keeps its stored observation.",
      parameters: [
        ENV_ID_PARAM,
        {
          name: 'refresh',
          in: 'query',
          required: false,
          schema: { type: 'string', enum: ['1'] },
          description: 'Ask replica daemons for a fresh health reading first.',
        },
      ],
      responses: {
        200: {
          description: 'Status read model (cell reads only when `refresh=1`)',
          ...jsonSchema('ManagedStatusResponse'),
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/logs': {
    get: {
      tags: ['Managed services'],
      summary: 'Fetch managed compose logs via cell round-trip',
      parameters: [
        ENV_ID_PARAM,
        {
          name: 'tail',
          in: 'query',
          required: false,
          schema: { type: 'integer', default: 200, maximum: 2000 },
        },
      ],
      responses: {
        200: {
          description: 'Bounded log text',
          ...jsonSchema('ManagedLogsResponse'),
        },
        503: {
          description: 'Timeout or daemon unavailable',
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/backups': {
    get: {
      tags: ['Managed services'],
      summary: 'List managed backups (Postgres-only read of the backup table)',
      parameters: [ENV_ID_PARAM],
      responses: {
        200: {
          description: 'Backup metadata only — never dump bytes',
          ...jsonSchema('ManagedBackupsResponse'),
        },
      },
    },
    post: {
      tags: ['Managed services'],
      summary: 'Back up now: enqueue managed.backup (action=create)',
      description: 'Streams the dump to the daemon state dir; no credential envelope is carried.',
      parameters: [ENV_ID_PARAM],
      requestBody: {
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateManagedBackupRequest' },
          },
        },
      },
      responses: {
        200: {
          description: 'Backup command enqueued',
          ...jsonSchema('CreateManagedBackupResponse'),
        },
        400: {
          description: 'managed_backup_unsupported',
          ...jsonSchema('ManagedBackupUnsupportedError'),
        },
        409: {
          description: 'managed_busy / server_offline',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/ManagedBusyError' },
                  { $ref: '#/components/schemas/ServerOfflineError' },
                ],
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/backups/{backupId}': {
    delete: {
      tags: ['Managed services'],
      summary: 'Delete a backup artifact: enqueue managed.backup (action=delete)',
      description:
        'The row is removed from the `backup` table by the consumer on success. The delete command is sent to the host that stores the artifact when that host is known.',
      parameters: [ENV_ID_PARAM, BACKUP_ID_PARAM],
      responses: {
        200: {
          description: 'Delete command enqueued',
          ...jsonSchema('ManagedBackupCommandResponse'),
        },
        404: {
          description: 'backup_not_found',
          ...jsonSchema('BackupNotFoundError'),
        },
        409: {
          description: 'managed_busy / server_offline',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/ManagedBusyError' },
                  { $ref: '#/components/schemas/ServerOfflineError' },
                ],
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/backups/{backupId}/restore': {
    post: {
      tags: ['Managed services'],
      summary: 'Restore a backup: enqueue managed.restore',
      description:
        'Daemon verifies the stored checksum/size before touching the running engine. Artifacts live on the host that made them; a backup from a former primary answers 409 backup_on_other_server and does not enqueue.',
      parameters: [ENV_ID_PARAM, BACKUP_ID_PARAM],
      responses: {
        200: {
          description: 'Restore command enqueued',
          ...jsonSchema('ManagedBackupCommandResponse'),
        },
        404: {
          description: 'backup_not_found',
          ...jsonSchema('BackupNotFoundError'),
        },
        409: {
          description: 'managed_busy / server_offline / backup_on_other_server',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/ManagedBusyError' },
                  { $ref: '#/components/schemas/ServerOfflineError' },
                  { $ref: '#/components/schemas/BackupOnOtherServerError' },
                ],
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/backup-policies': {
    get: {
      tags: ['Managed services'],
      summary: 'List scheduled backup policies for the managed engine',
      description:
        'Each policy with its newest run. Scheduled runs are fired by a timer on the host, not queued from here.',
      parameters: [ENV_ID_PARAM],
      responses: {
        200: {
          description: 'Policies, oldest first; empty when the environment has no managed engine',
          ...jsonSchema('BackupPoliciesResponse'),
        },
      },
    },
    post: {
      tags: ['Managed services'],
      summary: 'Create a scheduled backup policy',
      description:
        "Org owners and managers. Pushes the engine host's full policy set (`server.backups.reconcile`).",
      parameters: [ENV_ID_PARAM],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/CreateBackupPolicyRequest' },
          },
        },
      },
      responses: {
        201: {
          description: 'Policy created',
          ...jsonSchema('BackupPolicyResponse'),
        },
        400: BACKUP_POLICY_INVALID_RESPONSE,
        409: {
          description: 'backup_policy_limit',
          ...jsonSchema('BackupPolicyLimitError'),
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/backup-policies/{policyId}': {
    patch: {
      tags: ['Managed services'],
      summary: 'Update a scheduled backup policy',
      description:
        'Any subset of fields. A change to schedule, timezone, retention or enabled pushes the host a new set; a rename does not.',
      parameters: [ENV_ID_PARAM, POLICY_ID_PARAM],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/UpdateBackupPolicyRequest' },
          },
        },
      },
      responses: {
        200: {
          description: 'Policy updated',
          ...jsonSchema('BackupPolicyResponse'),
        },
        400: BACKUP_POLICY_INVALID_RESPONSE,
        404: BACKUP_POLICY_NOT_FOUND_RESPONSE,
      },
    },
    delete: {
      tags: ['Managed services'],
      summary: 'Delete a scheduled backup policy',
      description:
        'Removes the policy and its run history; the host drops its timer. Artifacts already written stay on the host and in the backup list.',
      parameters: [ENV_ID_PARAM, POLICY_ID_PARAM],
      responses: {
        200: {
          description: 'Policy deleted',
          ...jsonSchema('DeleteBackupPolicyResponse'),
        },
        404: BACKUP_POLICY_NOT_FOUND_RESPONSE,
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/backup-policies/{policyId}/runs': {
    get: {
      tags: ['Managed services'],
      summary: "List a backup policy's recent runs",
      parameters: [
        ENV_ID_PARAM,
        POLICY_ID_PARAM,
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      ],
      responses: {
        200: {
          description: 'Runs, newest first',
          ...jsonSchema('BackupRunsResponse'),
        },
        404: BACKUP_POLICY_NOT_FOUND_RESPONSE,
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/members': {
    get: {
      tags: ['Managed services'],
      summary: 'List managed cluster members',
      parameters: [ENV_ID_PARAM],
      responses: {
        200: {
          description: 'Member list with server display names',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['members'],
                properties: {
                  members: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/ManagedMember' },
                  },
                },
              },
            },
          },
        },
      },
    },
    post: {
      tags: ['Managed services'],
      summary: 'Add a managed replica member',
      description:
        'Body `{ serverId, replicaClass?, readEligible? }`. `replicaClass` defaults to `failover` (same datacenter as primary, promotable). `read` replicas may use local/datacenter/fabric/public paths to any org server. Requires private reachability to primary; failover additionally requires a ready datacenter CIDR. Refused with 422 `managed_failover_unsupported` when the cluster image cannot take a replica (MariaDB 12.3: single server until automatic failover supports it).',
      parameters: [ENV_ID_PARAM],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['serverId'],
              properties: {
                serverId: { type: 'string' },
                replicaClass: {
                  type: 'string',
                  enum: ['failover', 'read'],
                  default: 'failover',
                },
                readEligible: { type: 'boolean' },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Member added; cluster apply fan-out enqueued',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: true,
              },
            },
          },
        },
        409: {
          description: 'managed_member_exists / managed_busy',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/ManagedMemberExistsError' },
                  { $ref: '#/components/schemas/ManagedBusyError' },
                ],
              },
            },
          },
        },
        422: {
          description:
            'managed_failover_unsupported / failover_replica_requires_datacenter_transport / datacenter_required / datacenter_cidr_required / private_path_unavailable / failover_requires_trusted_datacenter',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/ManagedFailoverUnsupportedError' },
                  {
                    $ref: '#/components/schemas/FailoverReplicaRequiresDatacenterTransportError',
                  },
                  { $ref: '#/components/schemas/DatacenterRequiredError' },
                  { $ref: '#/components/schemas/DatacenterCidrRequiredError' },
                  { $ref: '#/components/schemas/PrivatePathUnavailableError' },
                  {
                    $ref: '#/components/schemas/FailoverRequiresTrustedDatacenterError',
                  },
                ],
              },
            },
          },
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/members/{memberId}': {
    patch: {
      tags: ['Managed services'],
      summary: 'Update managed member (readEligible and/or replicaClass)',
      description:
        'Body `{ readEligible?, replicaClass? }` — at least one field required. Converting `read` → `failover` re-runs failover placement (shared datacenter + datacenter address). Failover → read is always allowed.',
      parameters: [ENV_ID_PARAM, MEMBER_ID_PARAM],
      requestBody: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                readEligible: { type: 'boolean' },
                replicaClass: {
                  type: 'string',
                  enum: ['failover', 'read'],
                },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Member updated; apply re-emitted',
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: true },
            },
          },
        },
        422: {
          description:
            'failover_replica_requires_datacenter_transport / datacenter_required / datacenter_cidr_required / private_path_unavailable / failover_requires_trusted_datacenter',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  {
                    $ref: '#/components/schemas/FailoverReplicaRequiresDatacenterTransportError',
                  },
                  { $ref: '#/components/schemas/DatacenterRequiredError' },
                  { $ref: '#/components/schemas/DatacenterCidrRequiredError' },
                  { $ref: '#/components/schemas/PrivatePathUnavailableError' },
                  {
                    $ref: '#/components/schemas/FailoverRequiresTrustedDatacenterError',
                  },
                ],
              },
            },
          },
        },
      },
    },
    delete: {
      tags: ['Managed services'],
      summary: 'Remove a managed replica member',
      parameters: [ENV_ID_PARAM, MEMBER_ID_PARAM],
      responses: {
        200: {
          description: 'Replica removed; destroy + re-apply enqueued',
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: true },
            },
          },
        },
        409: {
          description: 'managed_member_is_primary — cannot delete the primary',
          ...jsonSchema('ManagedMemberIsPrimaryError'),
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/members/{memberId}/promote': {
    post: {
      tags: ['Managed services'],
      summary: 'Enqueue managed.promote for a replica member',
      description:
        "Promotes a streaming **failover** replica to primary (recorded switchover). Read-class replicas return 422 `managed_replica_not_promotable` with no class bypass — use `POST …/disaster-recovery/promote`. Body may include `{ force: true }` to bypass the lag/health gate on a **failover** replica (accepts possible data loss). Without `force`, a missing or stale stored observation (older than 120s) makes the route ask the replica's daemon for a fresh reading first (`managed-health-request`, 8s); the unchanged lag/health gate then judges that reading. On timeout, an offline host, or a daemon without `managed-health-v1` the gate runs on the stored observation, so the route fails closed exactly as before. Best-effort fences the old primary with managed.lifecycle stop when online. On success the consumer flips roles and re-reconciles ProxySQL plus managed HA. The enqueued managed.promote payload includes optional `engine` (postgres|mysql|mariadb); older commands without `engine` default to postgres on the daemon.",
      parameters: [ENV_ID_PARAM, MEMBER_ID_PARAM],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                force: {
                  type: 'boolean',
                  description:
                    'Bypass lag gate for failover when the primary is dead. Risk: unreplicated commits on the old primary may be lost.',
                },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Promote command queued (managed.status → applying)',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'commandId', 'status', 'serverId'],
                properties: {
                  ok: { type: 'boolean', const: true },
                  commandId: { type: 'string' },
                  status: { type: 'string', const: 'queued' },
                  serverId: { type: 'string' },
                },
              },
            },
          },
        },
        409: {
          description:
            'managed_replica_not_streaming / managed_replica_lagging / managed_replica_health_stale / managed_replica_live_check_failed / managed_busy / server_offline',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  {
                    $ref: '#/components/schemas/ManagedReplicaNotStreamingError',
                  },
                  { $ref: '#/components/schemas/ManagedReplicaLaggingError' },
                  {
                    $ref: '#/components/schemas/ManagedReplicaHealthStaleError',
                  },
                  {
                    $ref: '#/components/schemas/ManagedReplicaLiveCheckFailedError',
                  },
                  { $ref: '#/components/schemas/ManagedBusyError' },
                  { $ref: '#/components/schemas/ServerOfflineError' },
                ],
              },
            },
          },
        },
        422: {
          description:
            'managed_replica_not_promotable — read-class replica (no force class bypass)',
          ...jsonSchema('ManagedReplicaNotPromotableError'),
        },
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/disaster-recovery/promote': {
    post: {
      tags: ['Managed services'],
      summary: 'Promote a read replica for disaster recovery',
      description:
        'Dedicated DR path for **read** replicas (`confirm: true` required). Records a `disaster-recovery` journal row, fences when the old primary is reachable, promotes the target, then reclassifies leftover `failover` members outside the new primary datacenter to `read`. Failover replicas must use `POST …/members/{memberId}/promote`.',
      parameters: [ENV_ID_PARAM],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['memberId', 'confirm'],
              properties: {
                memberId: { type: 'string', format: 'uuid' },
                confirm: { type: 'boolean', const: true },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description: 'Disaster-recovery command queued',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: [
                  'ok',
                  'commandId',
                  'status',
                  'serverId',
                  'fencePending',
                  'kind',
                  'lagBytes',
                  'source',
                  'target',
                ],
                properties: {
                  ok: { type: 'boolean', const: true },
                  commandId: { type: 'string' },
                  status: { type: 'string', const: 'queued' },
                  serverId: { type: 'string' },
                  fencePending: { type: 'boolean' },
                  kind: { type: 'string', const: 'disaster-recovery' },
                  lagBytes: { type: 'number', nullable: true },
                  source: {
                    type: 'object',
                    required: ['memberId', 'serverId', 'datacenterId'],
                    properties: {
                      memberId: { type: 'string', format: 'uuid' },
                      serverId: { type: 'string', format: 'uuid' },
                      datacenterId: {
                        type: 'string',
                        format: 'uuid',
                        nullable: true,
                      },
                    },
                  },
                  target: {
                    type: 'object',
                    required: ['memberId', 'serverId', 'datacenterId'],
                    properties: {
                      memberId: { type: 'string', format: 'uuid' },
                      serverId: { type: 'string', format: 'uuid' },
                      datacenterId: {
                        type: 'string',
                        format: 'uuid',
                        nullable: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        400: {
          description: 'Invalid request — confirm must be true',
        },
        404: {
          description: 'Managed row, member, or current primary not found',
        },
        422: {
          description: 'managed_replica_not_promotable — target is not a read replica',
          ...jsonSchema('ManagedReplicaNotPromotableError'),
        },
      },
    },
  },
  '/api/client/v1/organizations/{id}/managed': {
    get: {
      tags: ['Managed services'],
      summary: 'List org managed services (Postgres join read model)',
      parameters: [ORG_ID_PARAM],
      responses: {
        200: {
          description: 'One row per managed service',
          ...jsonSchema('OrganizationManagedListResponse'),
        },
      },
    },
  },
}
