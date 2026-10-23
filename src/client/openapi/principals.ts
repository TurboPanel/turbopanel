export const principalSchemas = {
  PrincipalReconcileOutcome: {
    type: 'object',
    required: ['queuedServerIds', 'failedServerIds'],
    properties: {
      queuedServerIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        description: 'Servers the change was queued to.',
      },
      failedServerIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        description:
          'Servers the change could not be queued to; the Hosting Account may remain there.',
      },
    },
  },
  ProjectPrincipalRow: {
    type: 'object',
    required: [
      'id',
      'username',
      'appliedUsername',
      'nameScheme',
      'serviceIds',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      id: { type: 'string' },
      username: { type: 'string' },
      appliedUsername: {
        type: 'string',
        description:
          'Login actually created on the host (the system name): per nameScheme it equals the typed username (plain), adds a random _<11 chars> suffix (partial) or is fully random. SSH/SFTP with this name.',
      },
      nameScheme: {
        type: 'string',
        enum: ['plain', 'partial', 'random'],
        description:
          'Scheme the system name was derived with. Older users are derived from their names.',
      },
      projectId: { type: ['string', 'null'] },
      metadata: { type: 'object', nullable: true },
      options: { type: 'object', nullable: true },
      access: {
        type: 'string',
        enum: ['none', 'sftp', 'shell'],
        description:
          'Stored SSH access level: none (no login, keys stay on file), sftp (file transfer only) or shell (interactive shell plus transfer).',
      },
      serviceIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        description: 'Services this Linux (server) user is bound to (storage owner)',
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
    description: 'Password is never returned on GET',
  },
  ProjectPrincipalsResponse: {
    type: 'object',
    required: ['principals'],
    properties: {
      principals: {
        type: 'array',
        items: { $ref: '#/components/schemas/ProjectPrincipalRow' },
      },
    },
  },
  OrganizationPrincipalRow: {
    type: 'object',
    required: [
      'id',
      'name',
      'appliedUsername',
      'forms',
      'projectId',
      'projectName',
      'servers',
      'logins',
      'usedBy',
      'state',
      'orphaned',
      'canDelete',
      'createdAt',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string', description: 'The typed name.' },
      appliedUsername: {
        type: 'string',
        description: 'The login on the host or engine (the system name).',
      },
      forms: {
        type: 'array',
        items: { type: 'string', enum: ['system', 'database'] },
        description:
          'The forms the principal has: a system user on servers, a database login on clusters, or both.',
      },
      projectId: {
        type: ['string', 'null'],
        description: 'The project that created it; null once that project was deleted.',
      },
      projectName: { type: ['string', 'null'] },
      servers: {
        type: 'array',
        description: 'Servers the principal is placed on.',
        items: {
          type: 'object',
          required: ['serverId', 'serverName', 'state', 'uid', 'gid'],
          properties: {
            serverId: { type: 'string', format: 'uuid' },
            serverName: { type: ['string', 'null'] },
            state: { type: 'string', enum: ['pending', 'present', 'retiring', 'absent'] },
            uid: { type: ['integer', 'null'] },
            gid: { type: ['integer', 'null'] },
          },
        },
      },
      logins: {
        type: 'array',
        description: 'Database logins linked to the principal.',
        items: {
          type: 'object',
          required: ['id', 'managedId', 'role', 'appliedUsername'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            managedId: { type: 'string', format: 'uuid' },
            role: { type: 'string', enum: ['root', 'replication', 'user'] },
            appliedUsername: { type: 'string' },
          },
        },
      },
      usedBy: {
        type: 'object',
        description: 'What still uses the principal, counted per kind.',
        required: ['tenancies', 'bindings', 'storages', 'secrets', 'logins', 'folders'],
        properties: {
          tenancies: { type: 'integer' },
          bindings: { type: 'integer' },
          storages: { type: 'integer' },
          secrets: { type: 'integer' },
          logins: { type: 'integer' },
          folders: { type: 'integer' },
        },
      },
      state: {
        type: 'string',
        enum: ['none', 'pending', 'present', 'retiring', 'absent'],
        description: 'The most pressing placement state; none when placed on no server.',
      },
      orphaned: {
        type: 'boolean',
        description: 'No project and nothing uses it: left behind by a deleted project.',
      },
      canDelete: {
        type: 'boolean',
        description: 'DELETE /organizations/{id}/principals/{principalId} would be accepted.',
      },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  OrganizationPrincipalsResponse: {
    type: 'object',
    required: ['principals'],
    properties: {
      principals: {
        type: 'array',
        items: { $ref: '#/components/schemas/OrganizationPrincipalRow' },
      },
    },
  },
  ServerPrincipalRow: {
    type: 'object',
    required: [
      'placementId',
      'principalId',
      'username',
      'appliedUsername',
      'projectId',
      'state',
      'uid',
      'gid',
      'home',
      'source',
      'usedBy',
    ],
    properties: {
      placementId: { type: 'string', format: 'uuid' },
      principalId: { type: 'string', format: 'uuid' },
      username: { type: 'string' },
      appliedUsername: { type: 'string' },
      projectId: { type: ['string', 'null'] },
      state: { type: 'string', enum: ['pending', 'present', 'retiring', 'absent'] },
      uid: { type: ['integer', 'null'] },
      gid: { type: ['integer', 'null'] },
      home: { type: 'string' },
      source: { type: 'string', enum: ['compose', 'manual', 'storage'] },
      usedBy: {
        type: 'object',
        description:
          'What else uses the principal; otherPlacements and folders leave this server out.',
        required: [
          'tenancies',
          'bindings',
          'storages',
          'secrets',
          'logins',
          'folders',
          'otherPlacements',
        ],
        properties: {
          tenancies: { type: 'integer' },
          bindings: { type: 'integer' },
          storages: { type: 'integer' },
          secrets: { type: 'integer' },
          logins: { type: 'integer' },
          folders: { type: 'integer' },
          otherPlacements: { type: 'integer' },
        },
      },
    },
  },
  ResourceLimits: {
    type: 'object',
    properties: {
      maxCpus: { type: 'number' },
      maxMemoryBytes: { type: 'number' },
      maxServicesPerEnvironment: { type: 'number' },
    },
  },
  ResourceLimitsResponse: {
    type: 'object',
    required: ['resourceLimits'],
    properties: {
      resourceLimits: { $ref: '#/components/schemas/ResourceLimits' },
    },
  },
  SaveResourceLimitsRequest: {
    type: 'object',
    required: ['resourceLimits'],
    properties: {
      resourceLimits: { $ref: '#/components/schemas/ResourceLimits' },
    },
  },
  UpdateProjectPrincipalAssignmentsRequest: {
    type: 'object',
    required: ['serviceIds'],
    properties: {
      serviceIds: {
        type: 'array',
        items: { type: 'string', format: 'uuid' },
      },
    },
  },
}

export const principalPaths = {
  '/api/client/v1/projects/{projectId}/principals': {
    get: {
      tags: ['Principals'],
      summary: 'List project principals',
      parameters: [
        {
          name: 'projectId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: {
          description: 'Project principals',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ProjectPrincipalsResponse',
              },
            },
          },
        },
      },
    },
    post: {
      tags: ['Principals'],
      summary: 'Create a Linux (server) user for the project',
      parameters: [
        {
          name: 'projectId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['username'],
              properties: {
                username: {
                  type: 'string',
                  description:
                    'Typed (display) name (POSIX allowlist; ≤ 28 chars, or ≤ 16 when the scheme is partial so the random _<11 chars> suffix still fits). The host account is the applied username; home is /srv/users/<appliedUsername>.',
                },
                nameScheme: {
                  type: 'string',
                  enum: ['plain', 'partial', 'random'],
                  description:
                    'Name scheme for the system name (the login on the host or engine): plain = the typed name, partial = typed name + _<11 random chars> (platform default), random = fully random with no trace of the typed name. Omit to use the organization default. The server derives the system name; clients never supply it. When the organization locks the scheme, asking for a different one returns 409 principal_scheme_locked.',
                },
                serviceIds: {
                  type: 'array',
                  items: { type: 'string', format: 'uuid' },
                  description: 'Services this Linux (server) user is bound to',
                },
                options: {
                  type: 'object',
                  description:
                    'Optional principal options; `shell` (allowlisted) is accepted and stored as the access level',
                },
                uid: {
                  type: 'integer',
                  description:
                    'Optional operator uid override, integer 15001–60000 (both uid and gid required together; omit for host allocation)',
                },
                gid: {
                  type: 'integer',
                  description:
                    'Optional operator gid override, integer 15001–60000 (both uid and gid required together; omit for host allocation)',
                },
              },
            },
          },
        },
      },
      responses: {
        200: {
          description:
            'Created Linux (server) user. uid/gid are echoed only when an explicit override was supplied.',
        },
        400: {
          description:
            "invalid_service_ids | username_too_long | invalid_name_scheme | Invalid request. username_reserved: the typed name is already a host system user or group (examples: ftp, git), so it cannot be a site owner's Linux user.",
        },
        409: { description: 'username_in_use | principal_scheme_locked' },
      },
    },
  },
  '/api/client/v1/projects/{projectId}/principals/{id}': {
    patch: {
      tags: ['Principals'],
      summary: 'Replace service assignments for a Linux (server) user',
      parameters: [
        {
          name: 'projectId',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/UpdateProjectPrincipalAssignmentsRequest',
            },
          },
        },
      },
      responses: {
        200: { description: 'Updated assignments' },
        400: { description: 'invalid_service_ids' },
      },
    },
  },
  '/api/client/v1/organizations/{id}/principals': {
    get: {
      tags: ['Principals'],
      summary: 'List every principal in the organization',
      description:
        'Org owner or manager. A principal is an account responsible for the contents within it: a system user on servers and a database login on clusters. Each row says which forms it has, the servers it is placed on, the project and logins that use it and its state.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Principals of the organization',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/OrganizationPrincipalsResponse' },
            },
          },
        },
        403: { description: 'Not an owner or manager of the organization' },
        404: { description: 'Organization not reachable' },
      },
    },
  },
  '/api/client/v1/organizations/{id}/principals/{principalId}': {
    delete: {
      tags: ['Principals'],
      summary: 'Delete a principal its project left behind',
      description:
        'Org owner or manager. Only a system user with no project. Refused while a service, binding, storage entry, secret or database login still uses it; otherwise the Linux account is retired on every server it reached.',
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'principalId', in: 'path', required: true, schema: { type: 'string' } },
      ],
      responses: {
        200: {
          description: 'Deleted; `reconciled` lists the servers reached and not reached',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['ok', 'reconciled'],
                properties: {
                  ok: { type: 'boolean', enum: [true] },
                  reconciled: { $ref: '#/components/schemas/PrincipalReconcileOutcome' },
                },
              },
            },
          },
        },
        403: { description: 'Not an owner or manager of the organization' },
        404: { description: 'Organization or principal not found' },
        409: {
          description:
            '`code`: principal_in_use (with `usedBy`: tenancies, bindings, storages, secrets, logins, folders) | principal_has_project',
        },
      },
    },
  },
  '/api/client/v1/servers/{id}/principals': {
    get: {
      tags: ['Principals'],
      summary: 'List the principals placed on a server',
      description:
        'Org owner or manager of the server organization (the same rule as the removal plan). One row per placement with its state, ids, home and what else uses the principal.',
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        200: {
          description: 'Placements on the server',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['serverId', 'principals'],
                properties: {
                  serverId: { type: 'string', format: 'uuid' },
                  principals: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/ServerPrincipalRow' },
                  },
                },
              },
            },
          },
        },
        403: { description: 'Not an owner or manager of the organization' },
        404: { description: 'Server not found' },
      },
    },
  },
  '/api/client/v1/organizations/{id}/resource-limits': {
    get: {
      tags: ['Resource limits'],
      summary: 'Get organization resource limits',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: {
          description: 'Organization limits',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ResourceLimitsResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Resource limits'],
      summary: 'Update organization resource limits',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SaveResourceLimitsRequest' },
          },
        },
      },
      responses: {
        200: { description: 'Updated limits' },
      },
    },
  },
  '/api/client/v1/organizations/{id}/audit': {
    get: {
      tags: ['Organizations'],
      summary: "Read the organization's audit trail",
      description:
        'Security-relevant operator actions, newest first: daemon-key revokes, server deletes, ' +
        'grant changes, forge credential edits, organization gate flips. Owner only — the trail ' +
        "names who did what. Keyset pagination: pass the last row's createdAt as `before`.",
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        {
          name: 'before',
          in: 'query',
          required: false,
          schema: { type: 'string', format: 'date-time' },
          description: "createdAt of the previous page's last row",
        },
        {
          name: 'limit',
          in: 'query',
          required: false,
          schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        },
      ],
      responses: {
        200: {
          description: 'Audit entries',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['entries'],
                properties: {
                  entries: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id', 'createdAt', 'action', 'targetType'],
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        createdAt: { type: 'string', format: 'date-time' },
                        actorUserId: {
                          type: 'string',
                          format: 'uuid',
                          nullable: true,
                        },
                        actorEmail: { type: 'string', nullable: true },
                        action: { type: 'string' },
                        targetType: { type: 'string' },
                        targetId: {
                          type: 'string',
                          format: 'uuid',
                          nullable: true,
                        },
                        context: {
                          type: 'object',
                          nullable: true,
                          additionalProperties: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        400: { description: 'Invalid limit' },
        403: { description: 'organization owner required' },
      },
    },
  },
  '/api/client/v1/organizations/{id}/compose-resource-defaults': {
    get: {
      tags: ['Resource limits'],
      summary: "Get the organization's default per-service ceiling",
      description:
        'The ceiling applied at deploy to any container service whose compose sets none ' +
        '(mem_limit / cpus / deploy.resources.limits). Null when the organization has not ' +
        'opted into one — the default; the compose linter still advises per service.',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: {
          description: 'Organization default, or null',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['composeDefaultResourceLimits'],
                properties: {
                  composeDefaultResourceLimits: {
                    type: 'object',
                    nullable: true,
                    properties: {
                      cpus: { type: 'number', exclusiveMinimum: 0 },
                      memoryBytes: { type: 'integer', exclusiveMinimum: 0 },
                    },
                  },
                },
              },
            },
          },
        },
        403: { description: 'organization owner required' },
        404: { description: 'Not found' },
      },
    },
    put: {
      tags: ['Resource limits'],
      summary: "Set or clear the organization's default per-service ceiling",
      description:
        'Owner only. Send null to clear it. A service that declares its own ceiling is never ' +
        'overridden — the default fills a gap, it does not cap anyone.',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['composeDefaultResourceLimits'],
              properties: {
                composeDefaultResourceLimits: {
                  type: 'object',
                  nullable: true,
                  properties: {
                    cpus: { type: 'number', exclusiveMinimum: 0 },
                    memoryBytes: { type: 'integer', exclusiveMinimum: 0 },
                  },
                },
              },
            },
          },
        },
      },
      responses: {
        200: { description: 'Updated default' },
        400: {
          description:
            'Invalid composeDefaultResourceLimits; Invalid cpus; Invalid memoryBytes; ' +
            'composeDefaultResourceLimits needs cpus or memoryBytes',
        },
        403: { description: 'organization owner required' },
      },
    },
  },
  '/api/client/v1/servers/{id}/resource-limits': {
    get: {
      tags: ['Resource limits'],
      summary: 'Get server resource limits',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      responses: {
        200: {
          description: 'Server limits',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/ResourceLimitsResponse' },
            },
          },
        },
      },
    },
    put: {
      tags: ['Resource limits'],
      summary: 'Update server resource limits',
      parameters: [
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/SaveResourceLimitsRequest' },
          },
        },
      },
      responses: {
        200: { description: 'Updated limits' },
      },
    },
  },
}
