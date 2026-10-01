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
      'Engine settings (`image`, `ssl`, `resources`, `dockerOptions`, `engineConfig`, `exposure`, plus engine extras such as `initialDatabase`).',
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
        oneOf: [{ $ref: '#/components/schemas/ManagedEnvironmentRow' }, { type: 'null' }],
      },
      connection: {
        oneOf: [{ $ref: '#/components/schemas/ManagedConnectionInfo' }, { type: 'null' }],
      },
      settings: {
        oneOf: [{ $ref: '#/components/schemas/ManagedSettings' }, { type: 'null' }],
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
      members: {
        type: 'array',
        items: { $ref: '#/components/schemas/ManagedMember' },
      },
      recovery: {
        oneOf: [{ $ref: '#/components/schemas/ManagedRecoveryRecord' }, { type: 'null' }],
        description: 'Latest HA recovery journal row for this cluster (`null` when none).',
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
      'lagBytes',
      'sourceDatacenterId',
      'targetDatacenterId',
      'sourceServerId',
      'targetServerId',
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
      lagBytes: { type: 'number', nullable: true },
      sourceDatacenterId: { type: 'string', format: 'uuid', nullable: true },
      targetDatacenterId: { type: 'string', format: 'uuid', nullable: true },
      sourceServerId: { type: 'string', format: 'uuid', nullable: true },
      targetServerId: { type: 'string', format: 'uuid', nullable: true },
    },
  },
  CreateManagedRequest: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Optional name; defaults to the environment name',
      },
      exposure: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          scope: {
            type: 'string',
            enum: ['public', 'datacenter', 'local', 'turbofabric'],
            description:
              'SQL client access scope when enabled. Legacy `bind` is read-only migration input.',
          },
        },
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
      id: { type: 'string' },
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
      createdAt: { type: 'string', format: 'date-time' },
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
    required: ['username', 'databases'],
    properties: {
      username: { type: 'string' },
      databases: { type: 'array', items: { type: 'string' } },
      privileges: { type: 'array', items: { type: 'string' } },
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
          day: { type: 'string', enum: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
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
        oneOf: [{ $ref: '#/components/schemas/BackupSchedulePreset' }, { type: 'null' }],
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
    oneOf: [{ $ref: '#/components/schemas/BackupSchedulePreset' }, { type: 'string' }],
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
        const: 'managed',
        description: 'Storage-copy targets are not supported yet',
      },
    },
  },
  UpdateBackupPolicyRequest: {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: 64 },
      schedule: { $ref: '#/components/schemas/BackupScheduleInput' },
      timezone: { type: ['string', 'null'], description: 'null clears it (host local time)' },
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
        oneOf: [{ $ref: '#/components/schemas/BackupsReconcileOutcome' }, { type: 'null' }],
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
  ManagedBusyError: errorSchema('managed_busy'),
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
  ManagedBackupUnsupportedError: errorSchema('managed_backup_unsupported'),
  BackupNotFoundError: errorSchema('backup_not_found'),
  ManagedReplicaNotStreamingError: errorSchema('managed_replica_not_streaming'),
  ManagedReplicaLaggingError: errorSchema('managed_replica_lagging'),
  ManagedReplicaHealthStaleError: errorSchema('managed_replica_health_stale'),
}

export const managedPaths = {
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
            'not_managed_environment / managed_engine_unavailable / managed_settings_invalid',
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
      parameters: [ENV_ID_PARAM],
      requestBody: {
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/ManagedSettings' },
          },
        },
      },
      responses: {
        200: {
          description: 'Settings persisted',
          ...jsonSchema('ManagedDetailResponse'),
        },
        400: {
          description: 'managed_settings_invalid',
          ...jsonSchema('ManagedSettingsInvalidError'),
        },
        409: {
          description: 'managed_busy',
          ...jsonSchema('ManagedBusyError'),
        },
      },
    },
    delete: {
      tags: ['Managed services'],
      summary: 'Destroy managed service (two-step when running)',
      parameters: [ENV_ID_PARAM],
      responses: {
        200: {
          description: 'Hard-deleted or destroy command enqueued',
          ...jsonSchema('ManagedDeleteResponse'),
        },
        409: {
          description: 'managed_busy',
          ...jsonSchema('ManagedBusyError'),
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
      },
    },
  },
  '/api/client/v1/environments/{id}/managed/status': {
    get: {
      tags: ['Managed services'],
      summary: 'Postgres-only managed status + containers',
      description:
        "Database-only by default. With `?refresh=1` (the panel's Refresh button) each replica's daemon is first asked for a fresh replication reading (`managed-health-request`, parallel, best effort, 10s each) and the result is stored before the snapshot is read. A daemon that is offline, lacks `managed-health-v1`, or times out keeps its stored observation.",
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
      description: 'The row is removed from the `backup` table by the consumer on success.',
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
      description: 'Daemon verifies the stored checksum/size before touching the running engine.',
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
        'Body `{ serverId, replicaClass?, readEligible? }`. `replicaClass` defaults to `failover` (same datacenter as primary, promotable). `read` replicas may use local/datacenter/fabric/public paths to any org server. Requires private reachability to primary; failover additionally requires a ready datacenter CIDR.',
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
            'managed_replica_not_streaming / managed_replica_lagging / managed_replica_health_stale / managed_busy / server_offline',
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
