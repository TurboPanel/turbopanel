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
      'serverDisplayName',
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
      serverDisplayName: { type: 'string', nullable: true },
      role: { type: 'string', enum: ['primary', 'replica'] },
      replicaClass: {
        type: 'string',
        nullable: true,
        enum: ['failover', 'read'],
        description: 'Null on primary. Failover replicas are same-datacenter and promotable; read replicas may use fabric/public.',
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
      'displayName',
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
      displayName: { type: 'string', nullable: true },
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
        oneOf: [
          { $ref: '#/components/schemas/ManagedEnvironmentRow' },
          { type: 'null' },
        ],
      },
      connection: {
        oneOf: [
          { $ref: '#/components/schemas/ManagedConnectionInfo' },
          { type: 'null' },
        ],
      },
      settings: {
        oneOf: [
          { $ref: '#/components/schemas/ManagedSettings' },
          { type: 'null' },
        ],
      },
      server: {
        type: 'object',
        nullable: true,
        properties: {
          id: { type: 'string' },
          displayName: { type: 'string', nullable: true },
        },
      },
      rootUsername: { type: 'string', nullable: true },
      members: {
        type: 'array',
        items: { $ref: '#/components/schemas/ManagedMember' },
      },
    },
  },
  CreateManagedRequest: {
    type: 'object',
    properties: {
      displayName: {
        type: 'string',
        description: 'Optional display name; defaults to the environment name',
      },
      exposure: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          bind: { type: 'string', enum: ['public', 'datacenter', 'local'] },
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
        description:
          'Show-once plaintext root password — returned only on first create',
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
          'True when the row was hard-deleted; false when `managed.destroy` was enqueued',
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
          required: [
            'serviceId',
            'environmentId',
            'projectId',
            'keyPrefix',
          ],
          properties: {
            serviceId: { type: 'string' },
            displayName: { type: ['string', 'null'] },
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
    required: ['id', 'username', 'databases', 'privileges', 'createdAt'],
    properties: {
      id: { type: 'string' },
      username: { type: 'string' },
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
      'displayName',
      'projectId',
      'projectDisplayName',
      'environmentId',
      'environmentDisplayName',
      'serverId',
      'serverDisplayName',
      'status',
      'host',
      'port',
      'createdAt',
    ],
    properties: {
      id: { type: 'string' },
      engine: { type: 'string', nullable: true },
      engineDisplayName: { type: 'string', nullable: true },
      displayName: { type: 'string', nullable: true },
      projectId: { type: 'string' },
      projectDisplayName: { type: 'string', nullable: true },
      environmentId: { type: 'string' },
      environmentDisplayName: { type: 'string', nullable: true },
      serverId: { type: 'string', nullable: true },
      serverDisplayName: { type: 'string', nullable: true },
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
        description:
          'Must be one of the managed databases; defaults to the initial database',
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
  FailoverReplicaRequiresDatacenterTransportError: errorSchema(
    'failover_replica_requires_datacenter_transport',
  ),
  DatacenterRequiredError: errorSchema('datacenter_required'),
  DatacenterCidrRequiredError: errorSchema('datacenter_cidr_required'),
  PrivatePathUnavailableError: errorSchema('private_path_unavailable'),
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
          description: 'not_managed_environment / managed_engine_unavailable / managed_settings_invalid',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/NotManagedEnvironmentError' },
                  { $ref: '#/components/schemas/ManagedEngineUnavailableError' },
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
          description: 'managed_user_exists / managed_busy',
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
      summary:
        'Rotate a managed user password (show-once), re-materialize bindings, enqueue apply',
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
            schema: { $ref: '#/components/schemas/CreateManagedDatabaseRequest' },
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
      parameters: [ENV_ID_PARAM],
      responses: {
        200: {
          description: 'Status read model (no cell/DO reads)',
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
      summary: 'List managed backups (Postgres-only read of managed.options.backups)',
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
      description:
        'Streams the dump to the daemon state dir; no credential envelope is carried.',
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
        'Metadata is removed from `managed.options.backups` by the consumer on success.',
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
        'Daemon verifies the stored checksum/size before touching the running engine.',
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
            'failover_replica_requires_datacenter_transport / datacenter_required / datacenter_cidr_required / private_path_unavailable',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/FailoverReplicaRequiresDatacenterTransportError' },
                  { $ref: '#/components/schemas/DatacenterRequiredError' },
                  { $ref: '#/components/schemas/DatacenterCidrRequiredError' },
                  { $ref: '#/components/schemas/PrivatePathUnavailableError' },
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
            'failover_replica_requires_datacenter_transport / datacenter_required / datacenter_cidr_required / private_path_unavailable',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/FailoverReplicaRequiresDatacenterTransportError' },
                  { $ref: '#/components/schemas/DatacenterRequiredError' },
                  { $ref: '#/components/schemas/DatacenterCidrRequiredError' },
                  { $ref: '#/components/schemas/PrivatePathUnavailableError' },
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
        'Promotes a streaming **failover** replica to primary. Read-class replicas return 422 `managed_replica_not_promotable` unless `{ force: true }`. Body may include `{ force: true }` to bypass the lag health gate (and the class gate) for dead-primary failover (accepts possible data loss). Best-effort fences the old primary with managed.lifecycle stop when online (payload carries the managed engine code so the daemon resolves the correct runtime). On success the consumer flips roles and re-reconciles ProxySQL. The enqueued managed.promote payload includes optional `engine` (postgres|mysql|mariadb) for multi-engine promote; older commands without `engine` default to postgres on the daemon.',
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
                  { $ref: '#/components/schemas/ManagedReplicaNotStreamingError' },
                  { $ref: '#/components/schemas/ManagedReplicaLaggingError' },
                  { $ref: '#/components/schemas/ManagedReplicaHealthStaleError' },
                  { $ref: '#/components/schemas/ManagedBusyError' },
                  { $ref: '#/components/schemas/ServerOfflineError' },
                ],
              },
            },
          },
        },
        422: {
          description: 'managed_replica_not_promotable — read-class replica without force',
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
