import { resolveSessionCookieName } from './authn/crypto.ts'

const clientErrorJson = {
  type: 'object',
  required: ['error'],
  properties: { error: { type: 'string' } },
}

function resourceErrorResponses(options?: {
  badRequest?: boolean
  forbidden?: boolean
  notFound?: boolean
}) {
  const responses: Record<string, unknown> = {
    '401': {
      description: 'Unauthorized',
      content: { 'application/json': { schema: clientErrorJson } },
    },
    '503': {
      description: 'Database unavailable',
      content: { 'application/json': { schema: clientErrorJson } },
    },
  }
  if (options?.badRequest) {
    responses['400'] = {
      description: 'Invalid request',
      content: { 'application/json': { schema: clientErrorJson } },
    }
  }
  if (options?.forbidden !== false) {
    responses['403'] = {
      description: 'Forbidden',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorResponse' },
        },
      },
    }
  }
  if (options?.notFound) {
    responses['404'] = {
      description: 'Not found',
      content: { 'application/json': { schema: clientErrorJson } },
    }
  }
  return responses
}

type ResourceCrudConfig = {
  plural: string
  singular: string
  listSchema: string
  rowSchema: string
  createSchema: string
  createBodyRequired?: boolean
  parentQuery?: { name: string; description: string }
}

function buildResourceCrudPaths(config: ResourceCrudConfig): Record<string, unknown> {
  const base = `/api/client/v1/${config.plural}`
  const idPath = `${base}/{id}`
  const security = [{ cookieAuth: [] }]
  const singleEntitySchema = {
    type: 'object',
    required: [config.singular],
    properties: {
      [config.singular]: { $ref: `#/components/schemas/${config.rowSchema}` },
    },
  }

  const listGet: Record<string, unknown> = {
    tags: ['resources'],
    summary: `List ${config.plural}`,
    security,
    responses: {
      '200': {
        description: `Visible ${config.plural} for the signed-in organization`,
        content: {
          'application/json': {
            schema: { $ref: `#/components/schemas/${config.listSchema}` },
          },
        },
      },
      ...resourceErrorResponses({ forbidden: false }),
    },
  }

  if (config.parentQuery) {
    listGet.parameters = [
      {
        name: config.parentQuery.name,
        in: 'query',
        required: false,
        schema: { type: 'string' },
        description: config.parentQuery.description,
      },
    ]
  }

  return {
    [base]: {
      get: listGet,
      post: {
        tags: ['resources'],
        summary: `Create ${config.singular}`,
        security,
        requestBody: {
          required: config.createBodyRequired ?? true,
          content: {
            'application/json': {
              schema: { $ref: `#/components/schemas/${config.createSchema}` },
            },
          },
        },
        responses: {
          '200': {
            description: `${config.singular} created`,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/EntityOkResponse' },
              },
            },
          },
          ...resourceErrorResponses({ badRequest: true, notFound: true }),
        },
      },
    },
    [idPath]: {
      get: {
        tags: ['resources'],
        summary: `Get ${config.singular}`,
        security,
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: `${config.singular} details`,
            content: {
              'application/json': { schema: singleEntitySchema },
            },
          },
          ...resourceErrorResponses({ notFound: true }),
        },
      },
      patch: {
        tags: ['resources'],
        summary: `Update ${config.singular}`,
        security,
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/UpdateEntityRequest' },
            },
          },
        },
        responses: {
          '200': {
            description: `${config.singular} updated`,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UpdateEntityOkResponse' },
              },
            },
          },
          ...resourceErrorResponses({ badRequest: true, notFound: true }),
        },
      },
      delete: {
        tags: ['resources'],
        summary: `Delete ${config.singular}`,
        security,
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: `${config.singular} deleted`,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UpdateEntityOkResponse' },
              },
            },
          },
          ...resourceErrorResponses({ notFound: true }),
        },
      },
    },
  }
}

/** Hand-authored OpenAPI 3.1 spec for documented client/install/health routes. */
export function getClientOpenApiSpec(serverUrl: string): object {
  const sessionCookieName = resolveSessionCookieName(serverUrl)

  const resourceTreePaths = {
    ...buildResourceCrudPaths({
      plural: 'realms',
      singular: 'realm',
      listSchema: 'RealmsResponse',
      rowSchema: 'RealmRow',
      createSchema: 'CreateRealmRequest',
      createBodyRequired: false,
    }),
    ...buildResourceCrudPaths({
      plural: 'environments',
      singular: 'environment',
      listSchema: 'EnvironmentsResponse',
      rowSchema: 'EnvironmentRow',
      createSchema: 'CreateEnvironmentRequest',
      parentQuery: {
        name: 'realmId',
        description: 'Filter environments under a realm',
      },
    }),
    ...buildResourceCrudPaths({
      plural: 'projects',
      singular: 'project',
      listSchema: 'ProjectsResponse',
      rowSchema: 'ProjectRow',
      createSchema: 'CreateProjectRequest',
      parentQuery: {
        name: 'environmentId',
        description: 'Filter projects under an environment',
      },
    }),
    ...buildResourceCrudPaths({
      plural: 'services',
      singular: 'service',
      listSchema: 'ServicesResponse',
      rowSchema: 'ServiceRow',
      createSchema: 'CreateServiceRequest',
      parentQuery: {
        name: 'projectId',
        description: 'Filter services under a project',
      },
    }),
    ...buildResourceCrudPaths({
      plural: 'hostings',
      singular: 'hosting',
      listSchema: 'HostingsResponse',
      rowSchema: 'HostingRow',
      createSchema: 'CreateHostingRequest',
      parentQuery: {
        name: 'projectId',
        description: 'Filter hostings under a project',
      },
    }),
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'TurboPanel Client API',
      version: '0.1.0',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: sessionCookieName,
        },
      },
      schemas: {
        OkHealth: {
          type: 'object',
          required: ['ok'],
          properties: {
            ok: { type: 'boolean', const: true },
          },
        },
        ClientStatus: {
          type: 'object',
          required: ['ok', 'surface'],
          properties: {
            ok: { type: 'boolean', const: true },
            surface: { type: 'string', const: 'client' },
          },
        },
        ErrorResponse: {
          type: 'object',
          required: ['ok'],
          properties: {
            ok: { type: 'boolean', const: false },
            error: { type: 'string' },
          },
        },
        UnauthorizedResponse: {
          type: 'object',
          required: ['ok'],
          properties: {
            ok: { type: 'boolean', const: false },
          },
        },
        SignInRequest: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string' },
            password: { type: 'string', format: 'password' },
          },
        },
        SessionResponse: {
          type: 'object',
          required: [
            'ok',
            'userId',
            'username',
            'email',
            'role',
            'needsInstall',
            'organizationId',
          ],
          properties: {
            ok: { type: 'boolean', const: true },
            userId: { type: ['string', 'null'] },
            username: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
            role: { type: ['string', 'null'] },
            needsInstall: { type: 'boolean' },
            organizationId: { type: ['string', 'null'] },
          },
        },
        SignOutResponse: {
          type: 'object',
          required: ['ok'],
          properties: {
            ok: { type: 'boolean', const: true },
          },
        },
        InstallStatusResponse: {
          type: 'object',
          required: ['ok', 'needsInstall', 'isInstallMode', 'isSignupEnabled'],
          description:
            'Dedicated install surface (`/api/install/v1`). On Workers, needsInstall and isInstallMode are always false; isSignupEnabled reflects DB + env. On Deno, all fields reflect self-hosted install wizard state.',
          properties: {
            ok: { type: 'boolean', const: true },
            needsInstall: {
              type: 'boolean',
              description: 'True when org + superadmin do not exist yet (Deno only).',
            },
            isInstallMode: {
              type: 'boolean',
              description: 'True while the install wizard is active (Deno only).',
            },
            isSignupEnabled: {
              type: 'boolean',
              description:
                'Whether public sign-up is enabled (DB setting or TURBOPANEL_IS_SIGNUP_ENABLED env override).',
            },
          },
        },
        InstallBootstrapRequest: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', description: 'Host root or sudo user' },
            password: { type: 'string', format: 'password' },
          },
        },
        InstallBootstrapResponse: {
          type: 'object',
          required: ['ok'],
          properties: {
            ok: { type: 'boolean', const: true },
          },
        },
        InstallRequest: {
          type: 'object',
          required: ['username', 'password', 'superadminEmail', 'superadminPassword'],
          description:
            'Host credentials are required as `username` + `password`.',
          properties: {
            username: {
              type: 'string',
              description: 'Host root or sudo user.',
            },
            password: { type: 'string', format: 'password' },
            superadminEmail: { type: 'string', format: 'email' },
            superadminPassword: { type: 'string', format: 'password' },
          },
        },
        ServerRow: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            displayName: { type: ['string', 'null'] },
            organizationId: { type: ['string', 'null'] },
            options: { type: ['object', 'null'], additionalProperties: true },
            createdAt: { type: 'string', format: 'date-time' },
            connected: { type: 'boolean' },
            hostname: { type: ['string', 'null'] },
            remoteAddress: {
              type: ['string', 'null'],
              description:
                'Client IP as seen by the instance (X-Real-IP from Caddy). Null when offline or co-located on a Unix socket.',
            },
          },
        },
        ServersResponse: {
          type: 'object',
          required: ['servers'],
          properties: {
            servers: {
              type: 'array',
              items: { $ref: '#/components/schemas/ServerRow' },
            },
          },
        },
        LicenseRecord: {
          type: 'object',
          required: ['id', 'displayName', 'createdAt'],
          properties: {
            id: { type: 'string' },
            displayName: { type: ['string', 'null'] },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        LicensesResponse: {
          type: 'object',
          required: ['licenses'],
          properties: {
            licenses: {
              type: 'array',
              items: { $ref: '#/components/schemas/LicenseRecord' },
            },
          },
        },
        CreateLicenseRequest: {
          type: 'object',
          properties: {
            displayName: { type: 'string' },
          },
        },
        CreateLicenseResponse: {
          type: 'object',
          required: ['licenseId', 'licenseToken', 'installCommand'],
          properties: {
            licenseId: { type: 'string' },
            licenseToken: {
              type: 'string',
              description: 'Shown once at creation; not stored in plaintext.',
            },
            installCommand: {
              type: 'string',
              description:
                'Shell command to install a daemon with this license on a target host.',
            },
          },
        },
        RevokeOkResponse: {
          type: 'object',
          required: ['ok'],
          properties: {
            ok: { type: 'boolean', const: true },
          },
        },
        InvitationAcceptResponse: {
          type: 'object',
          required: ['ok', 'organizationId'],
          properties: {
            ok: { type: 'boolean', const: true },
            organizationId: {
              type: 'string',
              description:
                'Organization joined by the invitation. The active session organizationId is updated to this value.',
            },
          },
        },
        InvitationGrantSpec: {
          type: 'object',
          required: ['resourceKind', 'itemId'],
          properties: {
            resourceKind: {
              type: 'string',
              description: 'Entity kind (e.g. organization, realm, project).',
            },
            itemId: {
              type: 'string',
              format: 'uuid',
              description: 'Primary key of the entity.',
            },
            effect: { type: 'string', enum: ['allow', 'deny'], default: 'allow' },
            accessProfileKey: {
              type: 'string',
              description: 'Access profile key expanded to atomic permissions on accept.',
            },
            permissionKey: {
              type: 'string',
              description: 'Single atomic permission key.',
            },
          },
          description:
            'One intended access grant stored on invitation.grants. Exactly one of accessProfileKey or permissionKey should be set. Materialized into grant rows on invitation accept.',
        },
        AccessProfileRecord: {
          type: 'object',
          required: ['key', 'displayName', 'permissions'],
          properties: {
            key: { type: 'string' },
            displayName: { type: 'string' },
            permissions: {
              type: 'array',
              items: { type: 'string' },
            },
          },
        },
        AccessProfilesResponse: {
          type: 'object',
          required: ['accessProfiles'],
          properties: {
            accessProfiles: {
              type: 'array',
              items: { $ref: '#/components/schemas/AccessProfileRecord' },
            },
          },
        },
        PermissionRecord: {
          type: 'object',
          required: ['key', 'displayName'],
          properties: {
            key: { type: 'string' },
            displayName: { type: 'string' },
          },
        },
        PermissionsResponse: {
          type: 'object',
          required: ['permissions'],
          properties: {
            permissions: {
              type: 'array',
              items: { $ref: '#/components/schemas/PermissionRecord' },
            },
          },
        },
        AccessRecord: {
          type: 'object',
          required: [
            'id',
            'subjectKind',
            'subjectId',
            'resourceId',
            'effect',
          ],
          properties: {
            id: { type: 'string', format: 'uuid' },
            subjectKind: {
              type: 'string',
              enum: ['user', 'team', 'organization'],
            },
            subjectId: { type: 'string', format: 'uuid' },
            resourceId: { type: 'string', format: 'uuid' },
            effect: { type: 'string', enum: ['allow', 'deny'] },
            accessProfileKey: { type: ['string', 'null'] },
            permissionKey: { type: ['string', 'null'] },
          },
        },
        AccessListResponse: {
          type: 'object',
          required: ['access'],
          properties: {
            access: {
              type: 'array',
              items: { $ref: '#/components/schemas/AccessRecord' },
            },
          },
        },
        CreateAccessRequest: {
          type: 'object',
          required: ['subjectKind', 'subjectId', 'resourceId', 'effect'],
          description:
            'Exactly one of accessProfileKey or permissionKey must be provided. accessProfileKey is expanded server-side into multiple atomic grant rows in a single transaction.',
          properties: {
            subjectKind: {
              type: 'string',
              enum: ['user', 'team', 'organization'],
            },
            subjectId: { type: 'string', format: 'uuid' },
            resourceId: { type: 'string', format: 'uuid' },
            effect: { type: 'string', enum: ['allow', 'deny'] },
            accessProfileKey: {
              type: 'string',
              description:
                'Sugar: expanded to atomic permission rows server-side. Exactly one of `accessProfileKey` or `permissionKey` required.',
            },
            permissionKey: {
              type: 'string',
              description: 'Single atomic permission key from the catalog.',
            },
          },
        },
        CreateAccessResponse: {
          type: 'object',
          required: ['ok', 'id'],
          properties: {
            ok: { type: 'boolean', const: true },
            id: { type: 'string', format: 'uuid' },
            created: {
              type: 'boolean',
              description: 'True if at least one new row was inserted.',
            },
          },
        },
        RevokeAccessResponse: {
          type: 'object',
          required: ['ok'],
          properties: {
            ok: { type: 'boolean', const: true },
          },
        },
        RealmRow: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            displayName: { type: ['string', 'null'] },
            organizationId: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        RealmsResponse: {
          type: 'object',
          required: ['realms'],
          properties: {
            realms: {
              type: 'array',
              items: { $ref: '#/components/schemas/RealmRow' },
            },
          },
        },
        CreateRealmRequest: {
          type: 'object',
          properties: {
            displayName: { type: 'string' },
          },
        },
        EnvironmentRow: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            displayName: { type: ['string', 'null'] },
            organizationId: { type: 'string' },
            realmId: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        EnvironmentsResponse: {
          type: 'object',
          required: ['environments'],
          properties: {
            environments: {
              type: 'array',
              items: { $ref: '#/components/schemas/EnvironmentRow' },
            },
          },
        },
        CreateEnvironmentRequest: {
          type: 'object',
          required: ['realmId'],
          properties: {
            displayName: { type: 'string' },
            realmId: { type: 'string' },
          },
        },
        ProjectRow: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            displayName: { type: ['string', 'null'] },
            organizationId: { type: 'string' },
            environmentId: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        ProjectsResponse: {
          type: 'object',
          required: ['projects'],
          properties: {
            projects: {
              type: 'array',
              items: { $ref: '#/components/schemas/ProjectRow' },
            },
          },
        },
        CreateProjectRequest: {
          type: 'object',
          required: ['environmentId'],
          properties: {
            displayName: { type: 'string' },
            environmentId: { type: 'string' },
          },
        },
        ServiceRow: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            displayName: { type: ['string', 'null'] },
            organizationId: { type: 'string' },
            projectId: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        ServicesResponse: {
          type: 'object',
          required: ['services'],
          properties: {
            services: {
              type: 'array',
              items: { $ref: '#/components/schemas/ServiceRow' },
            },
          },
        },
        CreateServiceRequest: {
          type: 'object',
          required: ['projectId'],
          properties: {
            displayName: { type: 'string' },
            projectId: { type: 'string' },
          },
        },
        HostingRow: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            displayName: { type: ['string', 'null'] },
            organizationId: { type: 'string' },
            projectId: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' },
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
          required: ['projectId'],
          properties: {
            displayName: { type: 'string' },
            projectId: { type: 'string' },
          },
        },
        EntityOkResponse: {
          type: 'object',
          required: ['ok', 'id'],
          properties: {
            ok: { type: 'boolean', const: true },
            id: { type: 'string' },
          },
        },
        UpdateEntityRequest: {
          type: 'object',
          properties: {
            displayName: { type: 'string' },
          },
        },
        UpdateEntityOkResponse: {
          type: 'object',
          required: ['ok'],
          properties: {
            ok: { type: 'boolean', const: true },
          },
        },
      },
    },
    paths: {
      '/api/health': {
        get: {
          tags: ['health'],
          summary: 'Health probe',
          responses: {
            '200': {
              description: 'Instance is reachable',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/OkHealth' },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/status': {
        get: {
          tags: ['client'],
          summary: 'Client surface status',
          responses: {
            '200': {
              description: 'Client API is available',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ClientStatus' },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/auth/sign-in': {
        post: {
          tags: ['auth'],
          summary: 'Sign in with email credentials',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SignInRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Signed in; session cookie set',
              headers: {
                'Set-Cookie': {
                  schema: { type: 'string' },
                  description: 'Signed session cookie',
                },
              },
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SessionResponse' },
                },
              },
            },
            '400': {
              description: 'Invalid request body',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '401': {
              description: 'Invalid credentials',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '403': {
              description: 'Root account must use install wizard',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/auth/sign-out': {
        post: {
          tags: ['auth'],
          summary: 'Sign out and clear session cookie',
          security: [{ cookieAuth: [] }],
          responses: {
            '200': {
              description: 'Signed out',
              headers: {
                'Set-Cookie': {
                  schema: { type: 'string' },
                  description: 'Clears session cookie',
                },
              },
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SignOutResponse' },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/auth/session': {
        get: {
          tags: ['auth'],
          summary: 'Get current session',
          security: [{ cookieAuth: [] }],
          responses: {
            '200': {
              description: 'Active session',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SessionResponse' },
                },
              },
            },
            '401': {
              description: 'No valid session',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/UnauthorizedResponse' },
                },
              },
            },
          },
        },
      },
      '/api/install/v1/status': {
        get: {
          tags: ['install'],
          summary: 'Install wizard status',
          description:
            'Dedicated install surface (`/api/install/v1`). Workers: needsInstall/isInstallMode always false; isSignupEnabled from DB + TURBOPANEL_IS_SIGNUP_ENABLED env. Deno: full install wizard status.',
          responses: {
            '200': {
              description: 'Install status',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/InstallStatusResponse' },
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
      '/api/install/v1/bootstrap': {
        post: {
          tags: ['install'],
          summary: 'Verify host PAM credentials (install step 1)',
          description: 'Deno self-hosted only.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/InstallBootstrapRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Host credentials verified',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/InstallBootstrapResponse' },
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
            '401': {
              description: 'Invalid credentials',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '404': {
              description: 'Not available on Workers',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '409': {
              description: 'Instance already configured',
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
      '/api/install/v1/': {
        post: {
          tags: ['install'],
          summary: 'Complete initial install (install step 2)',
          description:
            'Deno self-hosted only. Creates org, team, superadmin, and session. Requires host credentials as `username`/`password`.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/InstallRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Install complete; superadmin session cookie set',
              headers: {
                'Set-Cookie': {
                  schema: { type: 'string' },
                  description: 'Signed session cookie',
                },
              },
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SessionResponse' },
                },
              },
            },
            '400': {
              description: 'Invalid request or install failed',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '401': {
              description: 'Invalid host credentials',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '404': {
              description: 'Not available on Workers',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            '409': {
              description: 'Instance already configured',
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
      '/api/client/v1/servers': {
        get: {
          tags: ['client'],
          summary: 'List servers for the signed-in organization',
          security: [{ cookieAuth: [] }],
          responses: {
            '200': {
              description: 'Organization servers with live connection state',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ServersResponse' },
                },
              },
            },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '503': {
              description: 'Database unavailable',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/licenses': {
        get: {
          tags: ['client'],
          summary: 'List active licenses for org',
          security: [{ cookieAuth: [] }],
          responses: {
            '200': {
              description: 'Active licenses for the signed-in organization',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/LicensesResponse' },
                },
              },
            },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '503': {
              description: 'Database unavailable',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ['client'],
          summary: 'Create a license',
          security: [{ cookieAuth: [] }],
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateLicenseRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'License created; token shown once',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CreateLicenseResponse' },
                },
              },
            },
            '400': {
              description: 'Invalid request',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '503': {
              description: 'Database unavailable',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/licenses/{id}': {
        delete: {
          tags: ['client'],
          summary: 'Revoke a license',
          security: [{ cookieAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'License revoked',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RevokeOkResponse' },
                },
              },
            },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '404': {
              description: 'License not found or already revoked',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '503': {
              description: 'Database unavailable',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/invitations/{id}/accept': {
        post: {
          tags: ['client'],
          summary: 'Accept an organization invitation',
          description:
            'Atomically claims a pending invitation, creates org membership (and optional team membership), materializes the invitation\'s `grants` JSON into `access` rows, and updates the active session `organizationId`. When `grants` is null, a default org-scoped `member` role grant is applied.',
          security: [{ cookieAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Invitation accepted',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/InvitationAcceptResponse' },
                },
              },
            },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '403': {
              description: 'Invitation email does not match session user',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '404': {
              description: 'Invitation not found',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '410': {
              description: 'Invitation expired or already used',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '503': {
              description: 'Database unavailable',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/access-profiles': {
        get: {
          tags: ['client'],
          summary: 'List access profiles',
          security: [{ cookieAuth: [] }],
          responses: {
            '200': {
              description: 'Access profile catalog',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AccessProfilesResponse' },
                },
              },
            },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/permissions': {
        get: {
          tags: ['client'],
          summary: 'List authorization permissions',
          security: [{ cookieAuth: [] }],
          responses: {
            '200': {
              description: 'Permission catalog',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PermissionsResponse' },
                },
              },
            },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/access/check': {
        get: {
          tags: ['client'],
          summary: 'Check a permission for the signed-in user',
          security: [{ cookieAuth: [] }],
          parameters: [
            {
              name: 'resourceId',
              in: 'query',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              name: 'permissionKey',
              in: 'query',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Permission check result',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['allowed'],
                    properties: { allowed: { type: 'boolean' } },
                  },
                },
              },
            },
            '400': {
              description: 'Missing or invalid query parameters',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '404': {
              description: 'Resource not found',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '503': {
              description: 'Database unavailable',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/access/resource-id': {
        get: {
          tags: ['client'],
          summary: 'Resolve a resource id for an entity',
          security: [{ cookieAuth: [] }],
          parameters: [
            {
              name: 'kind',
              in: 'query',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'itemId',
              in: 'query',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': {
              description: 'Resolved resource id',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['resourceId', 'kind', 'itemId'],
                    properties: {
                      resourceId: { type: 'string', format: 'uuid' },
                      kind: { type: 'string' },
                      itemId: { type: 'string', format: 'uuid' },
                    },
                  },
                },
              },
            },
            '400': {
              description: 'Missing or invalid query parameters',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
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
              description: 'Resource not found',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '503': {
              description: 'Database unavailable',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/access': {
        get: {
          tags: ['client'],
          summary: 'List access grants for a resource',
          description:
            'Requires the resource-kind management permission: organization:members, team:members, or {kind}:rw for other kinds.',
          security: [{ cookieAuth: [] }],
          parameters: [
            {
              name: 'resourceId',
              in: 'query',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            '200': {
              description: 'Access grants for the resource',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AccessListResponse' },
                },
              },
            },
            '400': {
              description: 'Missing or invalid query parameters',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
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
              description: 'Resource not found',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string', example: 'Not found' } },
                  },
                },
              },
            },
            '503': {
              description: 'Database unavailable',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ['client'],
          summary: 'Create an access grant',
          description:
            'Requires the resource-kind management permission on the target resourceId. Accepts accessProfileKey as sugar — expanded server-side to multiple atomic grant rows in one transaction.',
          security: [{ cookieAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CreateAccessRequest' },
              },
            },
          },
          responses: {
            '200': {
              description: 'Access grant created',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CreateAccessResponse' },
                },
              },
            },
            '400': {
              description: 'Invalid request',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
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
              description:
                'Target entity or subject not found (`Entity not found`, `User not found`, `Team not found`, or `Organization not found`)',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: {
                      error: {
                        type: 'string',
                        enum: [
                          'Entity not found',
                          'User not found',
                          'Team not found',
                          'Organization not found',
                        ],
                      },
                    },
                  },
                },
              },
            },
            '503': {
              description: 'Database unavailable',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      '/api/client/v1/access/{id}': {
        delete: {
          tags: ['client'],
          summary: 'Revoke an access grant',
          description:
            'Requires the resource-kind management permission on the grant\'s target resource.',
          security: [{ cookieAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: {
            '200': {
              description: 'Access grant revoked',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RevokeAccessResponse' },
                },
              },
            },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
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
              description: 'Access grant not found',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
            '503': {
              description: 'Database unavailable',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['error'],
                    properties: { error: { type: 'string' } },
                  },
                },
              },
            },
          },
        },
      },
      ...resourceTreePaths,
      '/api/install/v1/daemon-install.sh': {
        get: {
          tags: ['install'],
          summary: 'Daemon install script',
          description:
            'Returns a POSIX sh script for installing a managed daemon. ' +
            'Shell arguments (not HTTP query params): `--license <id:token>` (required) ' +
            'and optional `--host <instance-url>` to set TURBOPANEL_INSTANCE_URL before ' +
            'delegating to the CDN installer.',
          responses: {
            '200': {
              description: 'Install script',
              content: {
                'text/plain': {
                  schema: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }
}

/** Hand-authored OpenAPI 3.1 spec for documented daemon REST/WS routes. */
export function getDaemonOpenApiSpec(serverUrl: string): object {
  return {
    openapi: '3.1.0',
    info: {
      title: 'TurboPanel Daemon API',
      version: '0.1.0',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        licenseAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'License credentials as `licenseId:licenseToken`. On the WebSocket surface, ' +
            'send `licenseId` and `licenseToken` in the first `hello` JSON message after ' +
            'upgrade — not in HTTP Authorization headers.',
        },
      },
      schemas: {
        DaemonErrorResponse: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string' },
          },
        },
        DaemonVersion: {
          type: 'object',
          required: ['commit', 'branch'],
          properties: {
            commit: {
              type: 'string',
              description: 'Daemon checkout HEAD commit (git rev-parse HEAD).',
            },
            branch: {
              type: 'string',
              description: 'Daemon checkout branch (git rev-parse --abbrev-ref HEAD).',
            },
          },
        },
      },
    },
    paths: {
      '/api/daemon/v1/readiness': {
        get: {
          tags: ['daemon'],
          summary: 'Install readiness probe',
          description:
            'Co-located self-hosted daemons poll this before opening the daemon WebSocket. ' +
            'Returns 503 until the install wizard has created org + superadmin.',
          responses: {
            '200': {
              description: 'Instance is ready for daemon connections',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['ok', 'ready'],
                    properties: {
                      ok: { type: 'boolean', const: true },
                      ready: { type: 'boolean', const: true },
                    },
                  },
                },
              },
            },
            '503': {
              description: 'Not ready or database unavailable',
              content: {
                'application/json': {
                  schema: {
                    oneOf: [
                      {
                        type: 'object',
                        required: ['ok', 'ready', 'needsInstall'],
                        properties: {
                          ok: { type: 'boolean', const: true },
                          ready: { type: 'boolean', const: false },
                          needsInstall: { type: 'boolean', const: true },
                        },
                      },
                      {
                        type: 'object',
                        required: ['ok', 'error'],
                        properties: {
                          ok: { type: 'boolean', const: false },
                          error: { type: 'string' },
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
      '/api/daemon/v1/instance/ca': {
        get: {
          tags: ['daemon'],
          summary: 'Platform TLS CA certificate',
          description: 'Returns the PEM-encoded platform CA for daemon trust stores.',
          responses: {
            '200': {
              description: 'PEM certificate',
              content: {
                'application/x-pem-file': {
                  schema: { type: 'string', format: 'byte' },
                },
              },
            },
            '500': {
              description: 'CA unavailable',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DaemonErrorResponse' },
                },
              },
            },
          },
        },
      },
      '/api/daemon/v1/version': {
        get: {
          tags: ['daemon'],
          summary: 'Co-located daemon checkout version',
          description:
            'Informational daemon repo commit and branch on this host (Deno self-hosted only). ' +
            'Daemons may fetch this at connect time; connected daemons do not auto-sync from this value.',
          responses: {
            '200': {
              description: 'Daemon checkout HEAD',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DaemonVersion' },
                },
              },
            },
          },
        },
      },
      '/ws/daemon/v1': {
        get: {
          tags: ['daemon'],
          summary: 'Daemon WebSocket',
          description:
            'WebSocket upgrade endpoint for managed daemons. After the connection opens, ' +
            'send a JSON `hello` message with `hostname`, optional `serverId`, `machineId`, ' +
            'and license credentials (`licenseId`, `licenseToken`). Invalid or revoked licenses ' +
            'close the socket with code 4401.',
          security: [{ licenseAuth: [] }],
          responses: {
            '101': {
              description: 'Switching Protocols — WebSocket upgrade',
            },
          },
        },
      },
    },
  }
}
